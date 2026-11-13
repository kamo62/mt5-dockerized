import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  buildMt5StartupConfig,
  mt5StartupConfigFromEnv,
  writeMt5StartupFiles,
  writeMt5RestoreFile,
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

    const executable = join(root, "drive_c/Program Files/MetaTrader 5/terminal64.exe");
    mkdirSync(join(root, "drive_c/Program Files/MetaTrader 5"), { recursive: true });
    writeFileSync(executable, "fixture");
    mkdirSync(join(terminalRoot, "MQL5/Experts"), { recursive: true });
    writeFileSync(join(terminalRoot, "MQL5/Experts/TelegramTC_EA.ex5"), "fixture");
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

    const executable = join(root, "drive_c/Program Files/MetaTrader 5/terminal64.exe");
    mkdirSync(join(root, "drive_c/Program Files/MetaTrader 5"), { recursive: true });
    writeFileSync(executable, "fixture");
    mkdirSync(join(terminalRoot, "MQL5/Experts"), { recursive: true });
    writeFileSync(join(terminalRoot, "MQL5/Experts/TelegramTC_EA.ex5"), "fixture");
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

test("restore uses the last authorised account rather than stale managed login settings", async () => {
  const root = join(process.env.TMPDIR ?? "/tmp", `mt5-last-account-${crypto.randomUUID()}`);
  const terminal = join(root, "drive_c/Program Files/MetaTrader 5");
  try {
    mkdirSync(join(terminal, "Config"), { recursive: true });
    mkdirSync(join(terminal, "Logs"), { recursive: true });
    writeFileSync(join(terminal, "terminal64.exe"), "fixture");
    const saved = utf16("[Common]\r\nLogin=111111\r\nServer=OldBroker\r\nPassword=must-not-transfer\r\n[StartUp]\r\nExpert=DoNotReplay\r\n");
    writeFileSync(join(terminal, "Config/common.ini"), saved);
    writeFileSync(join(terminal, "Logs/20261112.log"), utf16("AB\t0\t12:00:00\tNetwork\t'222222': authorized on LastBroker-Live\r\n"));
    const result = await writeMt5RestoreFile(root, join(root, "cache"));
    const generated = readFileSync(result!.path, "utf16le");
    expect(generated).toContain("Login=222222");
    expect(generated).toContain("Server=LastBroker-Live");
    expect(generated).not.toContain("must-not-transfer");
    expect(generated).not.toContain("DoNotReplay");
    const native = readFileSync(join(terminal, "Config/common.ini"), "utf16le");
    expect(native).toContain("Login=111111");
    expect(native).toContain("Password=must-not-transfer");
    expect(native).not.toContain("DoNotReplay");
    const backup = readdirSync(join(root, "cache")).find((name) => name.startsWith("common-before-restore-"))!;
    expect(readFileSync(join(root, "cache", backup)).equals(saved)).toBe(true);
    expect(statSync(join(root, "cache", backup)).mode & 0o777).toBe(0o600);
    await writeMt5RestoreFile(root, join(root, "cache"));
    expect(readdirSync(join(root, "cache")).filter((name) => name.startsWith("common-before-restore-")).length).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("startup rejects missing experts and presets before changing account configuration", async () => {
  const root = join(process.env.TMPDIR ?? "/tmp", `mt5-preflight-${Date.now()}-${Math.random()}`);
  const terminal = join(root, "drive_c/Program Files/MetaTrader 5");
  const common = join(terminal, "Config/common.ini");
  try {
    mkdirSync(join(terminal, "Config"), { recursive: true });
    mkdirSync(join(terminal, "MQL5/Experts"), { recursive: true });
    writeFileSync(join(terminal, "terminal64.exe"), "fixture");
    const original = utf16("[Common]\r\nServer=fixture\r\n");
    writeFileSync(common, original);
    const config = mt5StartupConfigFromEnv({ MT5_STARTUP_CONFIG: "true", MT5_STARTUP_EXPERT: "Example", MT5_STARTUP_PRESET: "Example.set" });
    await expect(writeMt5StartupFiles(root, config)).rejects.toThrow("expert file");
    expect(readFileSync(common).equals(original)).toBe(true);
    writeFileSync(join(terminal, "MQL5/Experts/Example.ex5"), "fixture");
    await expect(writeMt5StartupFiles(root, config)).rejects.toThrow("preset file");
    expect(readFileSync(common).equals(original)).toBe(true);
    config.presetFilename = "../../outside.set";
    await expect(writeMt5StartupFiles(root, config)).rejects.toThrow("within its MQL5 directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
