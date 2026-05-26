import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mt5InstallDirectoryCandidates } from "./paths";

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
type TerminalDataRoot = {
  root: string;
  commonIniPath: string;
};

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
      skipping = nextSection === sectionToRemove;
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
    Experts: {
      AllowLiveTrading: "1",
      Enabled: "1",
      WebRequest: "1",
    },
  };

  if (Object.keys(startup).length > 0) {
    updates.StartUp = startup;
  }

  return updateIni(removeIniSection(baseConfig, "StartUp"), updates);
}

function terminalDataRoots(winePrefix: string): string[] {
  const usersDir = `${winePrefix}/drive_c/users`;
  const portableRoots = mt5InstallDirectoryCandidates(winePrefix);

  try {
    const roamingRoots = readdirSync(usersDir, { withFileTypes: true })
      .filter((user) => user.isDirectory())
      .flatMap((user) => {
        const terminalRoot = `${usersDir}/${user.name}/AppData/Roaming/MetaQuotes/Terminal`;
        try {
          return readdirSync(terminalRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${terminalRoot}/${entry.name}`);
        } catch {
          return [];
        }
      });
    return [...new Set([...roamingRoots, ...portableRoots])];
  } catch {
    return [...new Set(portableRoots)];
  }
}

function commonIniCandidates(terminalRoot: string): string[] {
  return [
    `${terminalRoot}/config/common.ini`,
    `${terminalRoot}/Config/common.ini`,
  ];
}

function exactChildPath(parent: string, names: string[]): string | undefined {
  try {
    const entries = readdirSync(parent, { withFileTypes: true });
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.name === name);
      if (entry) {
        return `${parent}/${entry.name}`;
      }
    }
  } catch {
    return undefined;
  }
}

function findExistingCommonIni(terminalRoot: string): string | undefined {
  const configDir = exactChildPath(terminalRoot, ["config", "Config"]);
  if (configDir) {
    const commonIni = exactChildPath(configDir, ["common.ini"]);
    if (commonIni) {
      return commonIni;
    }
  }

  return commonIniCandidates(terminalRoot).find((candidate) => existsSync(candidate));
}

function findTerminalDataRoot(winePrefix: string): TerminalDataRoot | undefined {
  return terminalDataRoots(winePrefix)
    .map((root) => {
      const commonIniPath = findExistingCommonIni(root);
      return commonIniPath ? { root, commonIniPath } : undefined;
    })
    .filter((candidate): candidate is TerminalDataRoot => candidate !== undefined)
    .sort((left, right) => {
      try {
        return (
          statSync(right.commonIniPath).mtimeMs -
          statSync(left.commonIniPath).mtimeMs
        );
      } catch {
        return 0;
      }
    })[0];
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

export async function writeMt5StartupFiles(
  winePrefix: string,
  config: Mt5StartupConfig,
): Promise<Mt5StartupFiles | undefined> {
  if (!config.enabled) {
    return undefined;
  }

  const terminalRoot = findTerminalDataRoot(winePrefix);
  if (!terminalRoot) {
    throw new Error("MT5 terminal data folder with config/common.ini was not found.");
  }

  const commonPath = terminalRoot.commonIniPath;
  const baseConfig = decodeMt5Text(await readFile(commonPath));
  const generatedConfig = buildMt5StartupConfig(baseConfig, config);
  await writeFile(commonPath, encodeMt5Text(generatedConfig));

  let presetPath: string | undefined;
  if (config.presetFilename && Object.keys(config.presetInputs).length > 0) {
    presetPath = `${terminalRoot.root}/MQL5/Presets/${config.presetFilename}`;
    await mkdir(dirname(presetPath), { recursive: true });
    await writeFile(presetPath, encodeMt5Text(buildPreset(config)));
  }

  return {
    commonIniPath: commonPath,
    commonIniWindowsPath: windowsPath(winePrefix, commonPath),
    presetPath,
  };
}
