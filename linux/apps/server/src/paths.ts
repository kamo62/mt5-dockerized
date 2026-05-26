import { existsSync, readdirSync, statSync } from "node:fs";
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
  return mt5ExpertsDirectoryCandidates(winePrefix)
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    })[0];
}
