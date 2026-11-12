import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { CLIPBOARD_MAX_BYTES, DesktopClipboard, clipboardWriteText, validateClipboardText } from "./desktop-clipboard";

test("desktop text bridge is bounded and passes content as stdin, never shell arguments", async () => {
  const base = await mkdtemp(join(tmpdir(), "mt5-clipboard-test-"));
  const utility = join(base, "fake-xclip");
  const contents = join(base, "contents.txt");
  try {
    await writeFile(utility, `#!/usr/bin/env bun\nimport { readFile } from 'node:fs/promises';\nconst file = ${JSON.stringify(contents)};\nif (process.argv.includes('-out')) process.stdout.write(await readFile(file));\nelse await Bun.write(file, await Bun.stdin.text());\n`);
    await chmod(utility, 0o700);
    const bridge = new DesktopClipboard(":fixture", utility);
    expect(bridge.info().available).toBe(true);
    const text = "UTF-8 ✓\n$(never execute this); 'quoted' & <text>";
    await bridge.write(text);
    expect(await readFile(contents, "utf8")).toBe(text);
    expect(await bridge.read()).toBe(text);
    validateClipboardText("a".repeat(CLIPBOARD_MAX_BYTES));
    expect(() => validateClipboardText("€".repeat(30_000))).toThrow("64 KiB");
    expect(() => validateClipboardText("text\0hidden")).toThrow("NUL");
    await writeFile(contents, "a".repeat(CLIPBOARD_MAX_BYTES + 1));
    await expect(bridge.read()).rejects.toThrow("64 KiB");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("malformed clipboard requests do not echo private text in errors", async () => {
  const privateText = "private-clipboard-fixture";
  try {
    await clipboardWriteText(new Request("http://localhost/clipboard", { method: "POST", body: `{"text": ${privateText}` }));
    throw new Error("Malformed JSON was accepted.");
  } catch (error) {
    expect((error as Error).message).toContain("Invalid clipboard JSON");
    expect((error as Error).message).not.toContain(privateText);
  }
  const valid = await clipboardWriteText(new Request("http://localhost/clipboard", { method: "POST", body: JSON.stringify({ text: "UTF-8 ✓" }) }));
  expect(valid).toBe("UTF-8 ✓");
  await expect(clipboardWriteText(new Request("http://localhost/clipboard", { method: "POST", body: "x".repeat(512 * 1024 + 1) }))).rejects.toThrow("too large");
});
