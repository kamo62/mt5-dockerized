import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

test("HTTP control guard, health JSON and compressed static responses work together", async () => {
  const root = await mkdtemp(join(tmpdir(), "mt5-api-"));
  const html = `<!doctype html><title>Fixture</title>${"fixture ".repeat(200)}`;
  await mkdir(join(root, "web"));
  await writeFile(join(root, "web/index.html"), html);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], {
    env: { ...process.env, PORT: "0", WEB_DIST_DIR: join(root, "web"), MT5_DATA_DIR: root, AUTO_INSTALL_MT5: "false", AUTO_LAUNCH_MT5: "false", MT5_STARTUP_CONFIG: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([
      (async () => {
        const reader = child.stdout.getReader();
        let output = "";
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`API exited before listening: ${output}`);
            output += new TextDecoder().decode(chunk.value);
            const match = output.match(/listening on http:\/\/localhost:(\d+)/);
            if (match) return match[1];
          }
        } finally { reader.releaseLock(); }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("API startup deadline exceeded")), 5000); }),
    ]);
    clearTimeout(timer);
    const base = `http://127.0.0.1:${port}`;
    const denied = await fetch(`${base}/api/mt5/stop`, { method: "POST" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const health = await fetch(`${base}/api/health`);
    expect(health.headers.get("content-type")).toContain("application/json");
    expect((await health.json()).ok).toBe(true);
    const compressed = await fetch(base, { headers: { "accept-encoding": "gzip" } });
    expect(compressed.headers.get("content-type")).toContain("text/html");
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(await compressed.text()).toBe(html);
    const unchanged = await fetch(base, { headers: { "if-none-match": compressed.headers.get("etag")! } });
    expect(unchanged.status).toBe(304);
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
