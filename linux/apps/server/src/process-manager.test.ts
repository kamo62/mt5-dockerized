import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { createRuntimePaths } from "@linux-mt5/shared";
import {
  DEFAULT_WINE_BOOT_TIMEOUT_MS,
  Mt5ProcessManager,
  readTimeoutMs,
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
