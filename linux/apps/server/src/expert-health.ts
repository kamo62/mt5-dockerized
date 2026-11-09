import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Mt5Status } from "@linux-mt5/shared";

type Cursor = { offset: number; inode: number; pending: string; utf16: boolean };

// Native journal evidence detects attachment failures, not EA heartbeats.
export class ExpertLogMonitor {
  readonly status: NonNullable<Mt5Status["expert"]>;
  private readonly cursors = new Map<string, Cursor>();
  private readonly instances = new Map<string, string | undefined>();
  private readonly event: RegExp;

  private constructor(private readonly root: string, name: string) {
    this.status = { name, state: "unverified" };
    const escaped = name.replace(/\.ex5$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    this.event = new RegExp(`^(?:expert|initializing of)\\s+${escaped}(?=\\s|\\()(?:\\s*\\(([^)]*)\\))?`, "i");
  }

  static async create(root: string, name: string, adopting = false): Promise<ExpertLogMonitor> {
    const monitor = new ExpertLogMonitor(root, name);
    for (const file of await monitor.files()) {
      const info = await stat(file);
      monitor.cursors.set(file, await monitor.cursor(file, adopting ? 0 : info.size, info.ino));
    }
    if (adopting) await monitor.poll();
    return monitor;
  }

  private async files(): Promise<string[]> {
    const files: string[] = [];
    for (const directory of ["logs", "Logs"]) {
      try {
        const entries = await readdir(join(this.root, directory));
        files.push(...entries.filter((name) => /^\d{8}\.log$/i.test(name)).map((name) => join(this.root, directory, name)));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return files.sort().slice(-2);
  }

  private async cursor(file: string, offset: number, inode: number): Promise<Cursor> {
    const handle = await open(file, "r");
    try {
      const header = Buffer.alloc(2);
      await handle.read(header, 0, 2, 0);
      return { offset, inode, pending: "", utf16: header[0] === 0xff && header[1] === 0xfe };
    } finally {
      await handle.close();
    }
  }

  async poll(): Promise<void> {
    const files = await this.files();
    for (const file of this.cursors.keys()) if (!files.includes(file)) this.cursors.delete(file);
    for (const file of files) {
      const info = await stat(file);
      let cursor = this.cursors.get(file);
      if (!cursor || cursor.inode !== info.ino || info.size < cursor.offset || (cursor.offset === 0 && info.size >= 2)) {
        cursor = await this.cursor(file, 0, info.ino);
        this.cursors.set(file, cursor);
      }
      let size = Math.min(info.size - cursor.offset, 262144);
      if (cursor.utf16) size -= size % 2;
      if (!size) continue;
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, cursor.offset);
        cursor.offset += bytesRead;
        const lines = (cursor.pending + buffer.subarray(0, bytesRead).toString(cursor.utf16 ? "utf16le" : "utf8")).split(/\r?\n/);
        cursor.pending = (lines.pop() ?? "").slice(-16384);
        for (const line of lines) {
          const message = line.match(/(?:^|\t)Experts\t(.+)$/)?.[1];
          const event = message && this.event.exec(message);
          if (!message || !event) continue;
          const instance = event[1]?.replace(/\s/g, "").toUpperCase() ?? "unknown";
          if (/\bfailed\b|\bremoved\b/i.test(message)) {
            this.instances.set(instance, `Configured EA failure: ${message}`);
          } else if (/\bloaded successfully\b/i.test(message)) {
            this.instances.set(instance, undefined);
          }
          const failure = [...this.instances.values()].find((error) => error !== undefined);
          this.status.state = failure ? "failed" : this.instances.size ? "loaded" : "unverified";
          this.status.lastError = failure;
        }
      } finally {
        await handle.close();
      }
    }
  }
}
