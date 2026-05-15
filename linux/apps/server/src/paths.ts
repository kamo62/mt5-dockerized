import { existsSync, readdirSync, statSync } from "node:fs";
import { createRuntimePaths, type RuntimePaths } from "@linux-mt5/shared";

export function getRuntimePaths(dataDir = process.env.MT5_DATA_DIR ?? "/data"): RuntimePaths {
  return createRuntimePaths(dataDir);
}

export function mt5ExecutableCandidates(winePrefix: string): string[] {
  const programFilesDirs = [
    `${winePrefix}/drive_c/Program Files`,
    `${winePrefix}/drive_c/Program Files (x86)`,
  ];
  const discovered = programFilesDirs.flatMap((directory) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => [
          `${directory}/${entry.name}/terminal64.exe`,
          `${directory}/${entry.name}/terminal.exe`,
        ]);
    } catch {
      return [];
    }
  });

  return [
    `${winePrefix}/drive_c/Program Files/MetaTrader 5/terminal64.exe`,
    `${winePrefix}/drive_c/Program Files (x86)/MetaTrader 5/terminal64.exe`,
    `${winePrefix}/drive_c/Program Files/MetaTrader 5/terminal.exe`,
    `${winePrefix}/drive_c/Program Files (x86)/MetaTrader 5/terminal.exe`,
    ...discovered,
  ];
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

  try {
    return readdirSync(usersDir, { withFileTypes: true })
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
  } catch {
    return [];
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
