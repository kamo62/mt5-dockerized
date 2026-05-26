import { expect, test } from "bun:test";
import {
  buildMt5InstallerCommand,
  buildMt5LaunchCommand,
  buildWineAntiDebugCommand,
  buildWebViewInstallCommand,
  buildWineEnv,
  buildWineWindowsVersionCommand,
} from "./command-builder";

test("buildWineEnv pins Wine to the persisted prefix and virtual display", () => {
  const env = buildWineEnv({
    display: ":99",
    pulseServer: "unix:/tmp/pulse/native",
    winePrefix: "/data/wine-prefix/.mt5",
  });

  expect(env.DISPLAY).toBe(":99");
  expect(env.PULSE_SERVER).toBe("unix:/tmp/pulse/native");
  expect(env.WINEPREFIX).toBe("/data/wine-prefix/.mt5");
  expect(env.WINEDEBUG).toBe("-all");
});

test("buildWineEnv omits PulseAudio when audio is disabled", () => {
  const env = buildWineEnv({
    display: ":99",
    winePrefix: "/data/wine-prefix/.mt5",
  });

  expect(env.PULSE_SERVER).toBeUndefined();
});

test("installer commands follow the official Wine-based MT5 install flow", () => {
  expect(buildWineWindowsVersionCommand()).toEqual(["winecfg", "-v=win10"]);

  expect(buildWineAntiDebugCommand()).toEqual([
    "sh",
    "-lc",
    "wine reg add 'HKCU\\Software\\Wine' /v HideWineExports /t REG_SZ /d Y /f && (wine reg delete 'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug' /f || true) && (wine reg delete 'HKLM\\Software\\Wow6432Node\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug' /f || true)",
  ]);

  expect(buildWebViewInstallCommand("/data/cache/webview2.exe")).toEqual([
    "wine",
    "/data/cache/webview2.exe",
    "/silent",
    "/install",
  ]);

  expect(buildMt5InstallerCommand("/data/cache/mt5setup.exe")).toEqual([
    "wine",
    "/data/cache/mt5setup.exe",
  ]);
});

test("buildMt5LaunchCommand starts terminal64.exe through Wine", () => {
  expect(
    buildMt5LaunchCommand(
      "/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe",
    ),
  ).toEqual([
    "wine",
    "/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe",
  ]);
});

test("buildMt5LaunchCommand can launch with the active common.ini startup config", () => {
  expect(
    buildMt5LaunchCommand(
      "/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe",
      "C:\\users\\root\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABC\\config\\common.ini",
    ),
  ).toEqual([
    "wine",
    "/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/terminal64.exe",
    "/config:C:\\users\\root\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABC\\config\\common.ini",
  ]);
});
