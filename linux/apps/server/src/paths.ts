import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRuntimePaths, type RuntimePaths } from "@linux-mt5/shared";

export function getRuntimePaths(dataDir = process.env.MT5_DATA_DIR ?? "/data"): RuntimePaths {
  return createRuntimePaths(dataDir);
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function mt5InstallDirectoryCandidates(winePrefix: string): string[] {
  const programFilesDirs = [
    `${winePrefix}/drive_c/Program Files`,
    `${winePrefix}/drive_c/Program Files (x86)`,
  ];
  const defaults = programFilesDirs.map((directory) => `${directory}/MetaTrader 5`);
  const discovered = programFilesDirs.flatMap((directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${directory}/${entry.name}`);
    } catch {
      return [];
    }
  });

  return unique([...defaults, ...discovered]);
}

export function mt5ExecutableCandidates(winePrefix: string): string[] {
  return mt5InstallDirectoryCandidates(winePrefix).flatMap((directory) => [
    `${directory}/terminal64.exe`,
    `${directory}/terminal.exe`,
  ]);
}

export function isMt5ExecutablePath(path: string): boolean {
  return /\/terminal64\.exe$/i.test(path);
}

export function findMt5Executable(winePrefix: string): string | undefined {
  return mt5ExecutableCandidates(winePrefix).find((candidate) =>
    existsSync(candidate),
  );
}

export function mt5ExpertsDirectoryCandidates(winePrefix: string): string[] {
  const usersDir = `${winePrefix}/drive_c/users`;
  const portableExpertsDirs = mt5InstallDirectoryCandidates(winePrefix).map(
    (directory) => `${directory}/MQL5/Experts`,
  );

  try {
    const terminalExpertsDirs = readdirSync(usersDir, { withFileTypes: true })
      .filter((user) => user.isDirectory())
      .flatMap((user) => {
        const terminalRoot = `${usersDir}/${user.name}/AppData/Roaming/MetaQuotes/Terminal`;
        try {
          return readdirSync(terminalRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${terminalRoot}/${entry.name}/MQL5/Experts`);
        } catch {
          return [];
        }
      });
    return unique([...terminalExpertsDirs, ...portableExpertsDirs]);
  } catch {
    return unique(portableExpertsDirs);
  }
}

export function findMt5ExpertsDirectory(winePrefix: string): string | undefined {
  const root = findMt5TerminalDataRoot(winePrefix);
  const experts = root && join(root, "MQL5/Experts");
  return experts && existsSync(experts) ? experts : undefined;
}

export function findMt5CommonIni(root: string): string | undefined {
  for (const directory of ["config", "Config"]) {
    try {
      if (!readdirSync(root).includes(directory)) continue;
      if (readdirSync(join(root, directory)).includes("common.ini")) {
        return join(root, directory, "common.ini");
      }
    } catch { /* The terminal may not have created its configuration yet. */ }
  }
}

function normaliseInstallPath(value: string): string {
  return value.replace(/^\ufeff/, "").replace(/\\/g, "/").replace(/\/+$/, "").trim().toLowerCase();
}

export function findMt5TerminalDataRoot(winePrefix: string): string | undefined {
  const executable = findMt5Executable(winePrefix);
  if (!executable) return undefined;
  const installRoot = dirname(executable);
  const windowsInstall = normaliseInstallPath(
    `C:/${installRoot.slice(`${winePrefix}/drive_c/`.length)}`,
  );
  const roots = unique(mt5ExpertsDirectoryCandidates(winePrefix).map((path) => dirname(dirname(path))));
  const roaming = roots.filter((root) => root.includes("/MetaQuotes/Terminal/"));
  const hasData = (root: string) => Boolean(findMt5CommonIni(root)) || existsSync(join(root, "MQL5/Experts"));
  const singleInstall = mt5ExecutableCandidates(winePrefix).filter((path) => existsSync(path)).length === 1;
  const candidates = roots.filter((root) => {
    if (!hasData(root)) return false;
    if (!roaming.includes(root)) return root === installRoot;
    try {
      const bytes = readFileSync(join(root, "origin.txt"));
      const origin = bytes[0] === 0xff && bytes[1] === 0xfe
        ? bytes.toString("utf16le") : bytes.toString("utf8");
      return normaliseInstallPath(origin) === windowsInstall;
    } catch {
      // Older prefixes without origin metadata are safe only when unambiguous.
      return singleInstall && roaming.filter(hasData).length === 1;
    }
  });
  if (candidates.length > 1) {
    throw new Error("Multiple MT5 data folders match the selected installation; resolve the ambiguity before launch or upload.");
  }
  return candidates[0];
}
