import { statSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { findMt5CommonIni, findMt5TerminalDataRoot } from "./paths";

export type Mt5StartupConfig = {
  enabled: boolean;
  chartMaxBars: string;
  chartPreload: string;
  expertName?: string;
  startupSymbol?: string;
  startupPeriod: string;
  presetFilename?: string;
  presetInputs: Record<string, string>;
};

export type Mt5StartupFiles = {
  commonIniPath: string;
  commonIniWindowsPath: string;
  presetPath?: string;
};

type Environment = Record<string, string | undefined>;

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readEaPresetInputs(env: Environment): Record<string, string> {
  return Object.entries(env)
    .filter(([key, value]) => key.startsWith("MT5_EA_") && cleanOptional(value))
    .reduce<Record<string, string>>((inputs, [key, value]) => {
      inputs[key.slice("MT5_EA_".length)] = value ?? "";
      return inputs;
    }, {});
}

export function mt5StartupConfigFromEnv(
  env: Environment,
): Mt5StartupConfig {
  return {
    enabled: readBoolean(env.MT5_STARTUP_CONFIG, false),
    chartMaxBars: "5000",
    chartPreload: cleanOptional(env.MT5_PRELOAD_CHARTS) ?? "0",
    expertName: cleanOptional(env.MT5_STARTUP_EXPERT),
    startupSymbol: cleanOptional(env.MT5_STARTUP_SYMBOL),
    startupPeriod: cleanOptional(env.MT5_STARTUP_PERIOD) ?? "H1",
    presetFilename: cleanOptional(env.MT5_STARTUP_PRESET),
    presetInputs: readEaPresetInputs(env),
  };
}

function decodeMt5Text(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le").replace(/^\ufeff/, "");
  }
  return buffer.toString("utf8").replace(/^\ufeff/, "");
}

function encodeMt5Text(text: string): Buffer {
  return Buffer.from(`\ufeff${text}`, "utf16le");
}

function sectionName(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }
  return trimmed.slice(1, -1);
}

function lineKey(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith(";") || trimmed.startsWith("#") || !line.includes("=")) {
    return undefined;
  }
  return line.split("=", 1)[0]?.trim();
}

function updateIni(base: string, updates: Record<string, Record<string, string>>): string {
  const lines = base.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const output: string[] = [];
  const seenSections = new Set<string>();
  const seenKeys = new Map<string, Set<string>>();
  let currentSection: string | undefined;

  function flushSection(section: string | undefined): void {
    if (!section || !updates[section]) {
      return;
    }
    const keys = seenKeys.get(section) ?? new Set<string>();
    for (const [key, value] of Object.entries(updates[section])) {
      if (!keys.has(key)) {
        output.push(`${key}=${value}`);
        keys.add(key);
      }
    }
    seenKeys.set(section, keys);
  }

  for (const line of lines) {
    const nextSection = sectionName(line);
    if (nextSection) {
      flushSection(currentSection);
      currentSection = nextSection;
      seenSections.add(nextSection);
      output.push(line);
      continue;
    }

    const key = lineKey(line);
    if (currentSection && key && updates[currentSection]?.[key] !== undefined) {
      const keys = seenKeys.get(currentSection) ?? new Set<string>();
      if (!keys.has(key)) {
        output.push(`${key}=${updates[currentSection][key]}`);
        keys.add(key);
      }
      seenKeys.set(currentSection, keys);
      continue;
    }

    output.push(line);
  }

  flushSection(currentSection);

  for (const [section, values] of Object.entries(updates)) {
    if (seenSections.has(section)) {
      continue;
    }
    if (output.length > 0 && output.at(-1) !== "") {
      output.push("");
    }
    output.push(`[${section}]`);
    for (const [key, value] of Object.entries(values)) {
      output.push(`${key}=${value}`);
    }
  }

  return `${output.join("\r\n")}\r\n`;
}

function removeIniSection(base: string, sectionToRemove: string): string {
  const lines = base.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const output: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const nextSection = sectionName(line);
    if (nextSection) {
      skipping = nextSection.toLowerCase() === sectionToRemove.toLowerCase();
      if (!skipping) {
        output.push(line);
      }
      continue;
    }

    if (!skipping) {
      output.push(line);
    }
  }

  return output.join("\n");
}

export function buildMt5StartupConfig(
  baseConfig: string,
  config: Mt5StartupConfig,
): string {
  const startup: Record<string, string> = {};
  if (config.expertName) {
    startup.Expert = config.expertName;
    if (config.startupSymbol) {
      startup.Symbol = config.startupSymbol;
    }
    if (config.startupPeriod) {
      startup.Period = config.startupPeriod;
    }
    if (config.presetFilename) {
      startup.ExpertParameters = config.presetFilename;
    }
  }

  const updates: Record<string, Record<string, string>> = {
    Common: {
      NewsEnable: "0",
    },
    Charts: {
      MaxBars: config.chartMaxBars,
      PreloadCharts: config.chartPreload,
    },
  };

  if (Object.keys(startup).length > 0) {
    updates.StartUp = startup;
    updates.Experts = { AllowLiveTrading: "1", Enabled: "1", WebRequest: "1" };
  }

  return updateIni(removeIniSection(baseConfig, "StartUp"), updates);
}

function startupPath(root: string, relative: string): string {
  const path = resolve(root, relative.replace(/\\/g, "/"));
  if (!path.startsWith(`${resolve(root)}${sep}`) || /[\r\n]/.test(relative)) {
    throw new Error("MT5 startup file must stay within its MQL5 directory.");
  }
  return path;
}

function requireStartupFile(path: string, label: string): void {
  try {
    if (statSync(path).isFile() && statSync(path).size > 0) return;
  } catch { /* Report missing and empty startup files consistently. */ }
  throw new Error(`Configured MT5 ${label} file was not found or is empty: ${path}`);
}

function buildPreset(config: Mt5StartupConfig): string {
  return `${Object.entries(config.presetInputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\r\n")}\r\n`;
}

function windowsPath(winePrefix: string, path: string): string {
  const driveRoot = `${winePrefix}/drive_c/`;
  if (path.startsWith(driveRoot)) {
    return `C:\\${path.slice(driveRoot.length).replace(/\//g, "\\")}`;
  }
  return `Z:${path.replace(/\//g, "\\")}`;
}

export type CustomStartup = { expert: string; symbol: string; period: string; preset: string; profile: string };

export function customStartupIni(config: CustomStartup): string {
  const sections: string[] = [];
  if (config.profile) sections.push(`[Charts]\r\nProfileLast=${config.profile}`);
  const startup: string[] = [];
  if (config.expert) startup.push(`Expert=${config.expert}`);
  if (config.symbol) startup.push(`Symbol=${config.symbol}`, `Period=${config.period}`);
  if (config.preset) startup.push(`ExpertParameters=${config.preset}`);
  if (startup.length) sections.push(`[StartUp]\r\n${startup.join("\r\n")}`);
  return sections.length ? `${sections.join("\r\n\r\n")}\r\n` : "";
}

export async function writeCustomStartupFile(winePrefix: string, cacheDir: string, config: CustomStartup) {
  const restored = await writeMt5RestoreFile(winePrefix, cacheDir);
  if (!restored) throw new Error("MT5's saved configuration was not found. Launch it once before configuring custom startup.");
  const base = decodeMt5Text(await readFile(restored.path));
  const updates: Record<string, Record<string, string>> = {};
  if (config.profile) updates.Charts = { ProfileLast: config.profile };
  const startup: Record<string, string> = {};
  if (config.expert) startup.Expert = config.expert;
  if (config.symbol) { startup.Symbol = config.symbol; startup.Period = config.period; }
  if (config.preset) startup.ExpertParameters = config.preset;
  if (Object.keys(startup).length) updates.StartUp = startup;
  // Deliberately do not modify Experts/AllowLiveTrading or DLL/WebRequest
  // permissions. A startup definition is not permission to enable trading.
  const path = resolve(cacheDir, "control-room-startup.ini");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, encodeMt5Text(updateIni(removeIniSection(base, "StartUp"), updates)), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return { path, windowsPath: windowsPath(winePrefix, path) };
}

export async function writeMt5RestoreFile(winePrefix: string, cacheDir: string): Promise<{ path: string; windowsPath: string } | undefined> {
  const root = findMt5TerminalDataRoot(winePrefix);
  const common = root && findMt5CommonIni(root);
  if (!root || !common) return undefined;
  // Called only before starting MT5. Clear legacy native autoload as well as
  // the launch copy: omitting a section in /config is not a deletion of native
  // defaults. All account, profile and permission settings remain untouched.
  const original = await readFile(common);
  const saved = decodeMt5Text(original);
  let skipping = false;
  const native = (saved.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? []).filter((line) => {
    const section = sectionName(line.trimEnd());
    if (section) skipping = section.toLowerCase() === "startup";
    return !skipping;
  }).join("");
  await mkdir(cacheDir, { recursive: true });
  if (native !== saved) {
    const backup = resolve(cacheDir, `common-before-restore-${randomUUID()}.ini`);
    const backupHandle = await open(backup, "wx", 0o600);
    try { await backupHandle.writeFile(original); await backupHandle.sync(); } finally { await backupHandle.close(); }
    const directory = await open(cacheDir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    const temporary = `${common}.${randomUUID()}.restore`;
    const handle = await open(temporary, "wx", 0o600);
    const encoded = original[0] === 0xff && original[1] === 0xfe ? encodeMt5Text(native) : Buffer.from(`${original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf ? "\ufeff" : ""}${native}`, "utf8");
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, common);
    const parent = await open(dirname(common), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  let restored = removeIniSection(saved, "StartUp");
  const account = await lastAuthorisedAccount(root);
  if (account) {
    // Managed common.ini can retain an earlier account after a user switches
    // accounts inside MT5. Prefer the terminal's own successful-login evidence.
    // Never carry an explicit old password over to a different account.
    let common = false;
    restored = restored.split(/\r?\n/).filter((line) => {
      const section = sectionName(line);
      if (section) common = section.toLowerCase() === "common";
      return !(common && ["password", "certpassword"].includes(lineKey(line)?.toLowerCase() ?? ""));
    }).join("\n");
    restored = updateIni(restored, { Common: { Login: account.login, Server: account.server } });
  }
  restored = restored.replace(/\r?\n/g, "\r\n");
  const path = resolve(cacheDir, "session-restore.ini");
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, encodeMt5Text(restored), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return { path, windowsPath: windowsPath(winePrefix, path) };
}

async function lastAuthorisedAccount(root: string): Promise<{ login: string; server: string } | undefined> {
  let account: { login: string; server: string } | undefined;
  for (const directory of ["Logs", "logs"]) {
    let files: string[];
    try { files = (await readdir(`${root}/${directory}`)).filter((name) => /^\d{8}\.log$/i.test(name)).sort().slice(-2); } catch { continue; }
    for (const name of files) {
      const handle = await open(`${root}/${directory}/${name}`, "r");
      try {
        const info = await handle.stat();
        const header = Buffer.alloc(2);
        await handle.read(header, 0, 2, 0);
        const utf16 = header[0] === 0xff && header[1] === 0xfe;
        let offset = Math.max(0, info.size - 262144);
        if (utf16) offset -= offset % 2;
        const buffer = Buffer.alloc(info.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        for (const line of buffer.subarray(0, bytesRead).toString(utf16 ? "utf16le" : "utf8").split(/\r?\n/)) {
          const match = line.match(/\tNetwork\t['"]?(\d+)['"]?:\s*authorized on\s+(.+?)(?:\s+through\b.*)?$/i);
          if (match) account = { login: match[1]!, server: match[2]!.trim() };
        }
      } finally { await handle.close(); }
    }
    break;
  }
  return account;
}

export async function writeMt5StartupFiles(
  winePrefix: string,
  config: Mt5StartupConfig,
): Promise<Mt5StartupFiles | undefined> {
  if (!config.enabled) {
    return undefined;
  }

  const terminalRoot = findMt5TerminalDataRoot(winePrefix);
  const commonPath = terminalRoot && findMt5CommonIni(terminalRoot);
  if (!terminalRoot || !commonPath) {
    throw new Error("MT5 terminal data folder with config/common.ini was not found.");
  }

  if (config.expertName) {
    const expert = config.expertName.replace(/\.ex5$/i, "");
    requireStartupFile(startupPath(`${terminalRoot}/MQL5/Experts`, `${expert}.ex5`), "expert");
  }
  let presetPath: string | undefined;
  if (config.presetFilename) {
    presetPath = startupPath(`${terminalRoot}/MQL5/Presets`, config.presetFilename);
    if (Object.keys(config.presetInputs).length === 0) requireStartupFile(presetPath, "preset");
  }
  const baseConfig = decodeMt5Text(await readFile(commonPath));
  const generatedConfig = buildMt5StartupConfig(baseConfig, config);

  if (presetPath && Object.keys(config.presetInputs).length > 0) {
    await mkdir(dirname(presetPath), { recursive: true });
    await writeFile(presetPath, encodeMt5Text(buildPreset(config)));
  }

  await writeFile(commonPath, encodeMt5Text(generatedConfig));

  return {
    commonIniPath: commonPath,
    commonIniWindowsPath: windowsPath(winePrefix, commonPath),
    presetPath,
  };
}
