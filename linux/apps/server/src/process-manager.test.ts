import { expect, test } from "bun:test";
import { DEFAULT_WINE_BOOT_TIMEOUT_MS, readTimeoutMs } from "./process-manager";

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
