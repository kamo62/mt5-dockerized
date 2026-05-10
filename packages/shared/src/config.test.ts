import { expect, test } from "bun:test";
import {
  Mt5StatusSchema,
  RuntimeConfigSchema,
  createInitialMt5Status,
  redactPathsForStatus,
} from "./index";

test("createInitialMt5Status keeps the desktop ready and MT5 idle by default", () => {
  const status = createInitialMt5Status("/data");

  expect(status.desktop).toBe("ready");
  expect(status.mt5).toBe("idle");
  expect(status.installed).toBe(false);
  expect(status.paths.dataDir).toBe("/data");
  expect(status.logs).toEqual([]);
  expect(Mt5StatusSchema.parse(status)).toEqual(status);
});

test("RuntimeConfigSchema accepts the browser noVNC URL used by the UI", () => {
  const config = RuntimeConfigSchema.parse({
    noVncUrl:
      "http://192.168.0.100:17080/vnc.html?autoconnect=1&resize=scale&path=websockify",
  });

  expect(config.noVncUrl).toContain("path=websockify");
});

test("redactPathsForStatus preserves operational paths without exposing host-only bind mounts", () => {
  const status = createInitialMt5Status("/home/kamo/linux-mt5-data");

  expect(redactPathsForStatus(status).paths.dataDir).toBe("/data");
  expect(redactPathsForStatus(status).paths.winePrefix).toBe(
    "/data/wine-prefix/.mt5",
  );
});
