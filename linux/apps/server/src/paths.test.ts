import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  findMt5ExpertsDirectory,
  getRuntimePaths,
  isMt5ExecutablePath,
  mt5ExpertsDirectoryCandidates,
  mt5ExecutableCandidates,
  mt5InstallDirectoryCandidates,
} from "./paths";

test("getRuntimePaths keeps the Wine prefix and downloads under the data directory", () => {
  const paths = getRuntimePaths("/data");

  expect(paths.dataDir).toBe("/data");
  expect(paths.cacheDir).toBe("/data/cache");
  expect(paths.winePrefix).toBe("/data/wine-prefix/.mt5");
  expect(paths.mt5InstallerPath).toBe("/data/cache/mt5setup.exe");
  expect(paths.webviewInstallerPath).toBe("/data/cache/webview2.exe");
});

test("mt5ExecutableCandidates returns the common 64-bit and 32-bit Wine locations", () => {
  const candidates = mt5ExecutableCandidates("/data/wine-prefix/.mt5");

  expect(candidates).toContain(
    "/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe",
  );
  expect(candidates).toContain(
    "/data/wine-prefix/.mt5/drive_c/Program Files (x86)/MetaTrader 5/terminal64.exe",
  );
});

test("mt5ExecutableCandidates discovers broker-branded install locations", () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-paths-${Date.now()}-${Math.random()}`,
  );

  try {
    const installDir = join(
      root,
      "drive_c/Program Files/HFM Metatrader 5",
    );
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "terminal64.exe"), "");

    expect(mt5ExecutableCandidates(root)).toContain(
      join(installDir, "terminal64.exe"),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("mt5InstallDirectoryCandidates includes official and broker-branded roots", () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-install-roots-${Date.now()}-${Math.random()}`,
  );

  try {
    const brandedInstallDir = join(
      root,
      "drive_c/Program Files/HFM Metatrader 5",
    );
    mkdirSync(brandedInstallDir, { recursive: true });

    expect(mt5InstallDirectoryCandidates(root)).toContain(
      join(root, "drive_c/Program Files/MetaTrader 5"),
    );
    expect(mt5InstallDirectoryCandidates(root)).toContain(brandedInstallDir);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("isMt5ExecutablePath accepts branded terminal64.exe executables", () => {
  expect(
    isMt5ExecutablePath(
      "/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe",
    ),
  ).toBe(true);
  expect(
    isMt5ExecutablePath(
      "/data/wine-prefix/.mt5/drive_c/Program Files/HFM Metatrader 5/terminal64.exe",
    ),
  ).toBe(true);
  expect(isMt5ExecutablePath("/data/cache/mt5setup.exe")).toBe(false);
});

test("findMt5ExpertsDirectory discovers terminal data directories", () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-experts-${Date.now()}-${Math.random()}`,
  );

  try {
    const expertsDir = join(
      root,
      "drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/D0E8209F77C8CF37AD8BF550E51FF075/MQL5/Experts",
    );
    mkdirSync(expertsDir, { recursive: true });

    expect(mt5ExpertsDirectoryCandidates(root)).toContain(expertsDir);
    expect(findMt5ExpertsDirectory(root)).toBe(expertsDir);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("findMt5ExpertsDirectory discovers official portable install experts directories", () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-portable-experts-${Date.now()}-${Math.random()}`,
  );

  try {
    const expertsDir = join(
      root,
      "drive_c/Program Files/MetaTrader 5/MQL5/Experts",
    );
    mkdirSync(expertsDir, { recursive: true });

    expect(mt5ExpertsDirectoryCandidates(root)).toContain(expertsDir);
    expect(findMt5ExpertsDirectory(root)).toBe(expertsDir);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
