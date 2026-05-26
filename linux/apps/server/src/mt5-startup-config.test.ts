import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  buildMt5StartupConfig,
  mt5StartupConfigFromEnv,
  writeMt5StartupFiles,
} from "./mt5-startup-config";

function utf16(text: string): Buffer {
  return Buffer.from(`\ufeff${text}`, "utf16le");
}

test("buildMt5StartupConfig overlays startup settings while preserving broker state", () => {
  const base = [
    "[Common]",
    "Login=54870107",
    "Server=HFMarketsSA-Live2",
    "NewsEnable=1",
    "[Charts]",
    "ProfileLast=Default",
    "MaxBars=100000",
    "[Experts]",
    "AllowDllImport=1",
    "Enabled=1",
    "WebRequest=1",
    "WebRequestUrl=encrypted-value",
  ].join("\r\n");

  const built = buildMt5StartupConfig(base, {
    enabled: true,
    chartMaxBars: "5000",
    chartPreload: "0",
    expertName: "TelegramTC_EA",
    startupSymbol: "XAUUSDr",
    startupPeriod: "H1",
    presetFilename: "TelegramTC_EA.set",
    presetInputs: {},
  });

  expect(built).toContain("[Common]\r\nLogin=54870107\r\nServer=HFMarketsSA-Live2\r\nNewsEnable=0");
  expect(built).toContain("[Charts]\r\nProfileLast=Default\r\nMaxBars=5000");
  expect(built).toContain("PreloadCharts=0");
  expect(built).toContain("[Experts]\r\nAllowDllImport=1\r\nEnabled=1");
  expect(built).toContain("AllowLiveTrading=1");
  expect(built).toContain("WebRequestUrl=encrypted-value");
  expect(built).toContain(
    [
      "[StartUp]",
      "Expert=TelegramTC_EA",
      "Symbol=XAUUSDr",
      "Period=H1",
      "ExpertParameters=TelegramTC_EA.set",
    ].join("\r\n"),
  );
});

test("buildMt5StartupConfig skips StartUp when no expert is configured", () => {
  const built = buildMt5StartupConfig(
    [
      "[Common]",
      "NewsEnable=1",
      "[StartUp]",
      "Expert=OldEA",
      "Symbol=EURUSD",
      "Period=M15",
      "ExpertParameters=OldEA.set",
    ].join("\r\n"),
    {
      enabled: true,
      chartMaxBars: "5000",
      chartPreload: "0",
      startupPeriod: "H1",
      presetInputs: {},
    },
  );

  expect(built).toContain("[Common]\r\nNewsEnable=0");
  expect(built).toContain("[Charts]\r\nMaxBars=5000");
  expect(built).not.toContain("[StartUp]");
  expect(built).not.toContain("OldEA");
});

test("writeMt5StartupFiles updates UTF-16 common.ini and writes EA preset", async () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-startup-${Date.now()}-${Math.random()}`,
  );

  try {
    const terminalRoot = join(
      root,
      "drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/D0E8209F77C8CF37AD8BF550E51FF075",
    );
    mkdirSync(join(terminalRoot, "config"), { recursive: true });
    writeFileSync(
      join(terminalRoot, "config/common.ini"),
      utf16("[Common]\r\nLogin=54870107\r\nServer=HFMarketsSA-Live2\r\n[Experts]\r\nWebRequestUrl=encrypted\r\n"),
    );

    const files = await writeMt5StartupFiles(root, {
      enabled: true,
      chartMaxBars: "5000",
      chartPreload: "0",
      expertName: "TelegramTC_EA",
      startupSymbol: "XAUUSDr",
      startupPeriod: "H1",
      presetFilename: "TelegramTC_EA.set",
      presetInputs: {
        BackendBaseUrl: "http://192.168.0.100:18787/api",
        LinkCode: "OYW74CFC",
        PollSeconds: "1",
      },
    });

    expect(files?.commonIniPath).toBe(join(terminalRoot, "config/common.ini"));
    expect(files?.commonIniWindowsPath).toBe(
      "C:\\users\\root\\AppData\\Roaming\\MetaQuotes\\Terminal\\D0E8209F77C8CF37AD8BF550E51FF075\\config\\common.ini",
    );
    expect(files?.presetPath).toBe(join(terminalRoot, "MQL5/Presets/TelegramTC_EA.set"));
    expect(readFileSync(files!.commonIniPath, "utf16le")).toContain("[StartUp]\r\nExpert=TelegramTC_EA");
    expect(readFileSync(files!.presetPath!, "utf16le")).toContain("LinkCode=OYW74CFC");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("writeMt5StartupFiles supports official portable installs under Program Files", async () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-portable-startup-${Date.now()}-${Math.random()}`,
  );

  try {
    const terminalRoot = join(root, "drive_c/Program Files/MetaTrader 5");
    mkdirSync(join(terminalRoot, "Config"), { recursive: true });
    mkdirSync(join(terminalRoot, "MQL5/Experts"), { recursive: true });
    writeFileSync(
      join(terminalRoot, "Config/common.ini"),
      utf16("[Common]\r\nSource=download.terminal.free\r\n[Experts]\r\nWebRequestUrl=encrypted\r\n"),
    );

    const files = await writeMt5StartupFiles(root, {
      enabled: true,
      chartMaxBars: "5000",
      chartPreload: "0",
      expertName: "TelegramTC_EA",
      startupSymbol: "XAUUSD",
      startupPeriod: "H1",
      presetFilename: "TelegramTC_EA.set",
      presetInputs: {
        LinkCode: "OYW74CFC",
      },
    });

    expect(files?.commonIniPath).toBe(join(terminalRoot, "Config/common.ini"));
    expect(files?.commonIniWindowsPath).toBe("C:\\Program Files\\MetaTrader 5\\Config\\common.ini");
    expect(files?.presetPath).toBe(join(terminalRoot, "MQL5/Presets/TelegramTC_EA.set"));
    expect(readFileSync(files!.commonIniPath, "utf16le")).toContain("[StartUp]\r\nExpert=TelegramTC_EA");
    expect(readFileSync(files!.presetPath!, "utf16le")).toContain("LinkCode=OYW74CFC");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("mt5StartupConfigFromEnv maps compose variables to startup options", () => {
  const env = {
    MT5_STARTUP_CONFIG: "true",
    MT5_STARTUP_SYMBOL: "XAUUSDr",
    MT5_STARTUP_PERIOD: "M15",
    MT5_STARTUP_EXPERT: "TelegramTC_EA",
    MT5_STARTUP_PRESET: "TelegramTC_EA.set",
    MT5_CHART_MAX_BARS: "7000",
    MT5_PRELOAD_CHARTS: "0",
    MT5_EA_BackendBaseUrl: "http://192.168.0.100:18787/api",
    MT5_EA_LinkCode: "OYW74CFC",
  };

  expect(mt5StartupConfigFromEnv(env)).toEqual({
    enabled: true,
    chartMaxBars: "5000",
    chartPreload: "0",
    expertName: "TelegramTC_EA",
    startupSymbol: "XAUUSDr",
    startupPeriod: "M15",
    presetFilename: "TelegramTC_EA.set",
    presetInputs: {
      BackendBaseUrl: "http://192.168.0.100:18787/api",
      LinkCode: "OYW74CFC",
    },
  });
});
