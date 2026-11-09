import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ExpertLogMonitor } from "./expert-health";

test("native journal failures survive launcher presence and later attachment can recover", async () => {
  const root = await mkdtemp(join(tmpdir(), "mt5-expert-health-"));
  const file = join(root, "logs/20261109.log");
  const line = (message: string) => `AB\t0\t06:22:00.000\tExperts\t${message}\r\n`;
  try {
    await mkdir(join(root, "logs"));
    await writeFile(file, Buffer.from(`\ufeff${line("expert Example (XAUUSD,M5) removed")}`, "utf16le"));
    const monitor = await ExpertLogMonitor.create(root, "Example");
    await monitor.poll();
    expect(monitor.status.state).toBe("unverified");
    const append = (message: string) => appendFile(file, Buffer.from(line(message), "utf16le"));
    await append("expert Example (XAUUSD,M5) loaded successfully");
    await monitor.poll();
    expect(monitor.status.state).toBe("loaded");
    await append("initializing of Example (XAUUSD,M5) failed with code 0 (symbol synchronization timeout)");
    await monitor.poll();
    expect(monitor.status.state).toBe("failed");
    expect(monitor.status.lastError).toContain("symbol synchronization timeout");
    await append("expert DifferentEA (XAUUSD,M5) loaded successfully");
    await monitor.poll();
    expect(monitor.status.state).toBe("failed");
    await append("expert Example (XAUUSD,M5) loaded successfully");
    await monitor.poll();
    expect(monitor.status.state).toBe("loaded");
    expect(monitor.status.lastError).toBeUndefined();
    const adopted = await ExpertLogMonitor.create(root, "Example", true);
    expect(adopted.status.state).toBe("loaded");
    await writeFile(join(root, "logs/20261110.log"), line("expert Example (XAUUSD,M5) removed"));
    await monitor.poll();
    expect(monitor.status.state).toBe("failed");
    const emptyFile = join(root, "logs/20261111.log");
    await writeFile(emptyFile, "");
    const emptyMonitor = await ExpertLogMonitor.create(root, "Example");
    await appendFile(emptyFile, Buffer.from(`\ufeff${line("expert Example (XAUUSD,M5) loaded successfully")}`, "utf16le"));
    await emptyMonitor.poll();
    expect(emptyMonitor.status.state).toBe("loaded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("another chart's successful attachment cannot clear a failed EA instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "mt5-expert-instances-"));
  const file = join(root, "logs/20261109.log");
  const line = (message: string) => `AB\t0\t06:22:00.000\tExperts\t${message}\r\n`;
  try {
    await mkdir(join(root, "logs"));
    const monitor = await ExpertLogMonitor.create(root, "Example");
    await writeFile(file, [
      "expert Example (XAUUSD,M5) loaded successfully",
      "initializing of Example (XAUUSD,M5) failed with code 0 (symbol synchronization timeout)",
      "expert Example (XAUUSD,M5) removed",
      "expert Example (EURUSD,M5) loaded successfully",
    ].map(line).join(""));
    await monitor.poll();
    expect(monitor.status.state).toBe("failed");
    expect(monitor.status.lastError).toContain("XAUUSD,M5");
    await appendFile(file, line("expert Example (XAUUSD,H1) loaded successfully"));
    await monitor.poll();
    expect(monitor.status.state).toBe("failed");
    await appendFile(file, line("expert Example (XAUUSD,M5) loaded successfully"));
    await monitor.poll();
    expect(monitor.status.state).toBe("loaded");
    expect(monitor.status.lastError).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
