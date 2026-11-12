import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { createRuntimePaths } from "@linux-mt5/shared";
import {
  DEFAULT_WINE_BOOT_TIMEOUT_MS,
  Mt5ProcessManager,
  readTimeoutMs,
  uploadTargetDirectory,
} from "./process-manager";

test("Wine bootstrap timeout allows slow first-run prefix creation", () => {
  expect(DEFAULT_WINE_BOOT_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
});

test("readTimeoutMs accepts positive numeric overrides and rejects bad values", () => {
  const key = "LINUX_MT5_TEST_TIMEOUT_MS";
  const previous = process.env[key];

  try {
    process.env[key] = "45000";
    expect(readTimeoutMs(key, 1000)).toBe(45_000);

    process.env[key] = "0";
    expect(readTimeoutMs(key, 1000)).toBe(1000);

    process.env[key] = "not-a-number";
    expect(readTimeoutMs(key, 1000)).toBe(1000);
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
});

test("upload routing puts presets, DLLs, and includes in MT5's expected folders", () => {
  const experts = "/data/prefix/drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/ABC/MQL5/Experts";
  const mql5 = "/data/prefix/drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/ABC/MQL5";

  expect(uploadTargetDirectory(experts, "EA.ex5")).toBe(experts);
  expect(uploadTargetDirectory(experts, "EA.mq5")).toBe(experts);
  expect(uploadTargetDirectory(experts, "EA.set")).toBe(`${mql5}/Presets`);
  expect(uploadTargetDirectory(experts, "helper.dll")).toBe(`${mql5}/Libraries`);
  expect(uploadTargetDirectory(experts, "common.mqh")).toBe(`${mql5}/Include`);
});

test("stop force-kills the prefix when graceful Wine shutdown fails", async () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-stop-${Date.now()}-${Math.random()}`,
  );
  const paths = createRuntimePaths(root);
  const executable = join(
    paths.winePrefix,
    "drive_c/Program Files/MetaTrader 5/terminal64.exe",
  );
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fake");

  const previousStopTimeout = process.env.MT5_STOP_TIMEOUT_MS;
  process.env.MT5_STOP_TIMEOUT_MS = "1";

  try {
    const manager = new Mt5ProcessManager({
      paths,
      autoInstall: false,
      autoLaunch: false,
    });
    const internals = manager as unknown as {
      isMt5Running: () => Promise<boolean>;
      runOneShot: (name: string, command: string[], timeoutMs: number) => Promise<void>;
    };
    const events: string[] = [];
    let running = true;

    internals.isMt5Running = async () => running;
    internals.runOneShot = async (name) => {
      if (name === "wine-shutdown") {
        events.push("shutdown");
        throw new Error("wineboot hung");
      }
      if (name === "wineserver-kill") {
        events.push("kill");
        running = false;
      }
    };

    const status = await manager.stop();

    expect(events).toEqual(["shutdown", "kill"]);
    expect(status.mt5).toBe("idle");
  } finally {
    if (previousStopTimeout === undefined) {
      delete process.env.MT5_STOP_TIMEOUT_MS;
    } else {
      process.env.MT5_STOP_TIMEOUT_MS = previousStopTimeout;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("reconcile marks a disappeared terminal failed and recovers when it returns", async () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-reconcile-${Date.now()}-${Math.random()}`,
  );
  const paths = createRuntimePaths(root);

  try {
    const manager = new Mt5ProcessManager({
      paths,
      autoInstall: false,
      autoLaunch: false,
    });
    const internals = manager as unknown as {
      mt5State: string;
      isMt5Running: () => Promise<boolean>;
      reconcileMt5State: () => Promise<void>;
    };
    let running = true;
    internals.isMt5Running = async () => running;
    internals.mt5State = "running";

    await internals.reconcileMt5State();
    expect(internals.mt5State).toBe("running");

    running = false;
    await internals.reconcileMt5State();
    expect(internals.mt5State).toBe("failed");
    expect(manager.getState().lastError).toBe("MT5 terminal is no longer running.");

    running = true;
    await internals.reconcileMt5State();
    expect(internals.mt5State).toBe("running");
    expect(manager.getState().lastError).toBeUndefined();
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("restart waits for an in-flight launch before shutting down and relaunching", async () => {
  const root = join(
    process.env.TMPDIR ?? "/tmp",
    `linux-mt5-lifecycle-${Date.now()}-${Math.random()}`,
  );
  const paths = createRuntimePaths(root);
  const executable = join(
    paths.winePrefix,
    "drive_c/Program Files/MetaTrader 5/terminal64.exe",
  );
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, "fake");

  const previousStartupConfig = process.env.MT5_STARTUP_CONFIG;
  process.env.MT5_STARTUP_CONFIG = "false";

  try {
    const manager = new Mt5ProcessManager({
      paths,
      autoInstall: false,
      autoLaunch: false,
    });
    const internals = manager as unknown as {
      isMt5Running: () => Promise<boolean>;
      runOneShot: (name: string, command: string[], timeoutMs: number) => Promise<void>;
      startProcess: (name: string, command: string[]) => void;
    };
    const events: string[] = [];
    let running = false;
    let releaseFirstAudio!: () => void;
    let signalFirstAudio!: () => void;
    const firstAudioStarted = new Promise<void>((resolve) => {
      signalFirstAudio = resolve;
    });
    const firstAudioRelease = new Promise<void>((resolve) => {
      releaseFirstAudio = resolve;
    });
    let audioRuns = 0;

    internals.isMt5Running = async () => running;
    internals.runOneShot = async (name) => {
      if (name === "wine-shutdown") {
        events.push("shutdown");
        running = false;
        return;
      }
      if (name === "wine-audio") {
        events.push("audio");
        audioRuns += 1;
        if (audioRuns === 1) {
          signalFirstAudio();
          await firstAudioRelease;
        }
      }
    };
    internals.startProcess = () => {
      events.push("start");
      running = true;
    };

    const launch = manager.launch();
    await firstAudioStarted;
    const restart = manager.restart();
    releaseFirstAudio();
    await Promise.all([launch, restart]);

    expect(events).toEqual(["audio", "start", "shutdown", "audio", "start"]);
  } finally {
    if (previousStartupConfig === undefined) {
      delete process.env.MT5_STARTUP_CONFIG;
    } else {
      process.env.MT5_STARTUP_CONFIG = previousStartupConfig;
    }
    rmSync(root, { force: true, recursive: true });
  }
});

test("a timed-out child that ignores SIGTERM fails within the deadline", async () => {
  const manager = new Mt5ProcessManager({ autoInstall: false, autoLaunch: false });
  const internals = manager as unknown as { runOneShot(name: string, command: string[], timeoutMs: number): Promise<void> };
  const start = performance.now();
  await expect(internals.runOneShot("deadline-probe", ["sh", "-c", "trap '' TERM; sleep 0.5; exit 0"], 30)).rejects.toThrow("timed out");
  expect(performance.now() - start).toBeLessThan(400);
});

test("an unintentional clean exit fails and a stale callback cannot overwrite Stop", async () => {
  const manager = new Mt5ProcessManager({ autoInstall: false, autoLaunch: false });
  const internals = manager as unknown as {
    mt5State: string;
    isMt5Running(): Promise<boolean>;
    startProcess(name: string, command: string[]): void;
  };
  internals.isMt5Running = async () => false;
  internals.mt5State = "running";
  internals.startProcess("mt5", ["sh", "-c", "exit 0"]);
  for (let i = 0; i < 50 && manager.getState().mt5 !== "failed"; i++) await Bun.sleep(5);
  expect(manager.getState().mt5).toBe("failed");
  expect(manager.getState().lastError).toContain("unexpectedly with code 0");
  let release!: (value: boolean) => void;
  let started!: () => void;
  const checking = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  internals.isMt5Running = async () => {
    if (calls++ === 0) {
      started();
      return new Promise<boolean>((resolve) => { release = resolve; });
    }
    return false;
  };
  internals.startProcess("mt5", ["sh", "-c", "exit 0"]);
  await checking;
  await manager.stop();
  release(true);
  await Bun.sleep(10);
  expect(manager.getState().mt5).toBe("idle");
});

test("lifecycle requests wait for installation to finish", async () => {
  const manager = new Mt5ProcessManager({ autoInstall: false, autoLaunch: false });
  const internals = manager as unknown as { installPromise?: Promise<void> };
  internals.installPromise = Promise.resolve();
  await expect(manager.launch()).rejects.toThrow("installer to finish");
  await expect(manager.restart()).rejects.toThrow("installer to finish");
  internals.installPromise = undefined;
  expect((await manager.stop()).mt5).toBe("idle");
});

test("restore mode resumes the saved account/profile without applying managed startup inputs", async () => {
  const root = join(process.env.TMPDIR ?? "/tmp", `mt5-session-${crypto.randomUUID()}`);
  const paths = createRuntimePaths(root);
  const terminal = join(paths.winePrefix, "drive_c/Program Files/MetaTrader 5");
  const previous = { mode: process.env.MT5_SESSION_MODE, config: process.env.MT5_STARTUP_CONFIG, expert: process.env.MT5_STARTUP_EXPERT };
  try {
    mkdirSync(join(terminal, "Config"), { recursive: true });
    mkdirSync(join(terminal, "MQL5/Experts"), { recursive: true });
    writeFileSync(join(terminal, "terminal64.exe"), "fixture");
    const common = "[Common]\r\nLogin=fixture-login\r\nServer=fixture-server\r\n[Charts]\r\nProfileLast=Saved\r\n";
    writeFileSync(join(terminal, "Config/common.ini"), common);
    writeFileSync(join(terminal, "Config/accounts.dat"), "saved-encrypted-credentials");
    process.env.MT5_SESSION_MODE = "restore";
    process.env.MT5_STARTUP_CONFIG = "true";
    process.env.MT5_STARTUP_EXPERT = "NotInstalledAndMustNotBeAutoloaded";
    for (let boot = 0; boot < 2; boot++) {
      const manager = new Mt5ProcessManager({ paths, autoInstall: false, autoLaunch: false });
      const internal = manager as unknown as { isMt5Running(): Promise<boolean>; runOneShot(): Promise<void>; startProcess(name: string, command: string[]): void };
      internal.isMt5Running = async () => false;
      internal.runOneShot = async () => undefined;
      let command: string[] = [];
      internal.startProcess = (_name, cmd) => { command = cmd; };
      expect((await manager.launch()).sessionMode).toBe("restore");
      expect(command.some((argument) => argument.startsWith("/config:"))).toBe(false);
      expect(readFileSync(join(terminal, "Config/common.ini"), "utf8")).toBe(common);
      expect(readFileSync(join(terminal, "Config/accounts.dat"), "utf8")).toBe("saved-encrypted-credentials");
    }
  } finally {
    for (const [key, value] of [["MT5_SESSION_MODE", previous.mode], ["MT5_STARTUP_CONFIG", previous.config], ["MT5_STARTUP_EXPERT", previous.expert]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("applying an import never stops a running terminal", async () => {
  const root = join(process.env.TMPDIR ?? "/tmp", `mt5-import-running-${crypto.randomUUID()}`);
  const paths = createRuntimePaths(root);
  const terminal = join(paths.winePrefix, "drive_c/Program Files/MetaTrader 5");
  try {
    mkdirSync(join(terminal, "MQL5/Experts"), { recursive: true });
    writeFileSync(join(terminal, "terminal64.exe"), "fixture");
    const manager = new Mt5ProcessManager({ paths, autoInstall: false, autoLaunch: false });
    const preview = await manager.createImport({ files: [{ path: "MQL5/Experts/New.ex5", size: 3 }] });
    await manager.uploadImportChunk(preview.id, 0, 0, new TextEncoder().encode("new"));
    const internals = manager as unknown as { isMt5Running(): Promise<boolean> };
    internals.isMt5Running = async () => true;
    await expect(manager.applyImport(preview.id, { overwrite: false, restoreAccount: false })).rejects.toThrow("Stop MT5 explicitly");
    expect(await Bun.file(join(terminal, "MQL5/Experts/New.ex5")).exists()).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
