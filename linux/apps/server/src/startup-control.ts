import { mkdir, readFile, readdir, rename, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { findMt5CommonIni, findMt5TerminalDataRoot } from "./paths";
import { normaliseDataDirectory, safeTarget } from "./data-import";
import { customStartupIni } from "./mt5-startup-config";

export const STARTUP_PERIODS = ["M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30", "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1"] as const;
const value = z.string().max(512).refine((text) => ![...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !/[\u0085\u2028\u2029]/.test(text), "Startup values cannot contain control characters or line breaks.");
export const StartupSettingsSchema = z.object({
  mode: z.enum(["restore", "custom"]), expert: value.default(""), symbol: value.default(""),
  period: z.enum(STARTUP_PERIODS).default("H1"), preset: value.default(""), profile: value.default(""),
}).strict();
export type StartupSettings = z.infer<typeof StartupSettingsSchema>;
export const RESTORE_SETTINGS: StartupSettings = { mode: "restore", expert: "", symbol: "", period: "H1", preset: "", profile: "" };

export class StartupControlStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(dataDir: string, private readonly winePrefix: string) {
    this.directory = join(dataDir, "control-room");
    this.path = join(this.directory, "startup.json");
  }

  async load(): Promise<StartupSettings | undefined> {
    try { return StartupSettingsSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Saved startup settings are unreadable. Review and save the startup choice in Control Room before launching.");
    }
  }

  private async validate(settings: StartupSettings): Promise<StartupSettings> {
    if (settings.mode === "restore") return { ...RESTORE_SETTINGS };
    const config = { ...settings, expert: settings.expert.trim().replace(/\\/g, "/").replace(/\.ex5$/i, ""), preset: settings.preset.trim().replace(/\\/g, "/"), symbol: settings.symbol.trim(), profile: settings.profile.trim() };
    if (config.expert && !config.symbol) throw new Error("Choose the broker's exact chart symbol for this EA.");
    if (config.preset && !config.expert) throw new Error("A preset requires an expert. Profiles already contain their own EA inputs.");
    if (config.profile && (config.expert || config.symbol || config.preset)) throw new Error("Choose either a saved profile or a custom chart. A profile already contains its charts, EAs and inputs.");
    if (config.profile.includes("/") || config.profile.includes("\\")) throw new Error("Choose a single existing profile name.");
    if (!config.expert && !config.symbol && !config.profile) throw new Error("Choose a profile or chart for custom startup, or use Restore last session.");
    const root = findMt5TerminalDataRoot(this.winePrefix);
    if (!root) throw new Error("MT5 data folder was not found. Launch MT5 once to create it.");
    const requireFile = async (relative: string, label: string) => {
      const path = await safeTarget(root, normaliseDataDirectory(relative));
      try { const info = await stat(path); if (info.isFile() && info.size > 0) return; } catch { /* Report a safe, fixed error. */ }
      throw new Error(`The selected ${label} is missing or empty. Upload it first.`);
    };
    if (config.expert) await requireFile(`MQL5/Experts/${config.expert}.ex5`, "compiled expert");
    if (config.preset) {
      if (!/\.set$/i.test(config.preset)) throw new Error("Choose a .set preset file.");
      await requireFile(`MQL5/Presets/${config.preset}`, "preset");
    }
    if (config.profile) {
      const path = await safeTarget(root, normaliseDataDirectory(`MQL5/Profiles/Charts/${config.profile}`));
      try { if (!(await stat(path)).isDirectory()) throw new Error(); } catch { throw new Error("The selected chart profile does not exist."); }
    }
    return config;
  }

  async validated(settings: StartupSettings): Promise<StartupSettings> { return this.validate(StartupSettingsSchema.parse(settings)); }

  async save(input: unknown): Promise<StartupSettings> {
    const parsed = StartupSettingsSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid startup settings. Check the mode, fields and timeframe; passwords and extra fields are not accepted.");
    const settings = await this.validate(parsed.data);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(settings)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.path);
    const parent = await open(this.directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return settings;
  }

  async describe(fallback: StartupSettings) {
    const saved = await this.load();
    const settings = saved ?? fallback;
    const root = findMt5TerminalDataRoot(this.winePrefix);
    const choices = { experts: [] as string[], presets: [] as string[], profiles: [] as string[] };
    if (root) {
      const collect = async (relative: string, extension: RegExp, output: string[], prefix = "", depth = 0): Promise<void> => {
        if (depth > 8 || output.length >= 1000) return;
        let entries;
        try { entries = await readdir(await safeTarget(root, relative), { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (output.length >= 1000) break;
          const name = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await collect(`${relative}/${entry.name}`, extension, output, name, depth + 1);
          else if (entry.isFile() && extension.test(entry.name)) output.push(name);
        }
      };
      await collect("MQL5/Experts", /\.ex5$/i, choices.experts);
      choices.experts = choices.experts.map((name) => name.replace(/\.ex5$/i, "")).sort();
      await collect("MQL5/Presets", /\.set$/i, choices.presets);
      try { choices.profiles = (await readdir(await safeTarget(root, "MQL5/Profiles/Charts"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); } catch { /* Empty choices before first launch. */ }
    }
    const common = root && findMt5CommonIni(root);
    let legacyStartup = false;
    if (common) {
      const bytes = await readFile(common);
      const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le") : bytes.toString("utf8");
      legacyStartup = /^\s*\[startup\]\s*$/im.test(text);
    }
    return { settings, source: saved ? "control-room" as const : "environment" as const, legacyStartup, preview: settings.mode === "custom" ? customStartupIni(settings) : "No custom [StartUp] block. Resume the last saved MT5 profile.", choices, appliesOnNextLaunch: true as const };
  }
}
