import { spawn } from "bun";

export const CLIPBOARD_MAX_BYTES = 64 * 1024;

export async function clipboardWriteText(request: Request): Promise<string> {
  // JSON can expand escaped text considerably. Bound the raw body separately,
  // and never let a parser diagnostic quote private clipboard contents.
  const maxBody = 512 * 1024;
  if (Number(request.headers.get("content-length")) > maxBody) throw new Error("Clipboard request body is too large.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBody) { await reader.cancel(); throw new Error("Clipboard request body is too large."); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch {
    throw new Error("Invalid clipboard JSON. Contents were not logged.");
  }
  if (typeof value !== "object" || value === null || !("text" in value) || typeof value.text !== "string" || Object.keys(value).length !== 1) throw new Error("Clipboard write requires a JSON object with only a text string.");
  validateClipboardText(value.text);
  return value.text;
}

export function validateClipboardText(text: string): void {
  if (text.includes("\0")) throw new Error("Clipboard text cannot contain a NUL character.");
  if (Buffer.byteLength(text, "utf8") > CLIPBOARD_MAX_BYTES) throw new Error("Clipboard text exceeds the 64 KiB UTF-8 limit.");
}

// Text never becomes a command argument, shell fragment, or log entry. xclip
// owns the X11 CLIPBOARD selection; Wine maps that to the Windows clipboard.
export class DesktopClipboard {
  constructor(private readonly display = process.env.DISPLAY ?? process.env.DISPLAY_ID ?? ":99", private readonly utility = "xclip") {}

  info() {
    const available = Boolean(Bun.which(this.utility));
    return { available, maxBytes: CLIPBOARD_MAX_BYTES, reason: available ? undefined : "Desktop clipboard utility is not installed. Rebuild the runtime image with xclip." };
  }

  private async run(args: string[], text?: string): Promise<string> {
    if (!this.info().available) throw new Error(this.info().reason);
    const child = spawn({ cmd: [this.utility, "-selection", "clipboard", ...args], env: { ...process.env, DISPLAY: this.display }, stdin: text === undefined ? "ignore" : "pipe", stdout: text === undefined ? "pipe" : "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = (async () => {
      if (text !== undefined && typeof child.stdin !== "number") {
        child.stdin?.write(text);
        await child.stdin?.end();
      }
      if (text !== undefined) {
        // The forked X11 selection owner may keep stdout open after its parent
        // exits. A write waits for the parent, not pipe EOF from that owner.
        if (await child.exited !== 0) throw new Error("Cannot update the desktop clipboard. Check that the desktop is running.");
        return "";
      }
      if (!child.stdout) throw new Error("Desktop clipboard output is unavailable.");
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > CLIPBOARD_MAX_BYTES) throw new Error("Desktop clipboard exceeds 64 KiB. Copy a smaller text selection.");
          chunks.push(next.value);
        }
        if (await child.exited !== 0) throw new Error("Cannot access the desktop text clipboard. Copy text in MT5 first and check that the desktop is running.");
        return Buffer.concat(chunks).toString("utf8");
      } finally { reader.releaseLock(); }
    })();
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Desktop clipboard timed out. Check that the desktop is running.")), 3000);
      })]);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  read(): Promise<string> { return this.run(["-out", "-target", "UTF8_STRING"]); }

  async write(text: string): Promise<void> {
    validateClipboardText(text);
    // Silent mode forks a small selection owner after stdin reaches EOF. It
    // remains until the clipboard is replaced; no keystrokes are injected.
    await this.run(["-in", "-silent"], text);
  }
}
