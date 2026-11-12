import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const IMPORT_CHUNK_BYTES = 4 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;
export const ImportManifestSchema = z.object({
  files: z.array(z.object({ path: z.string().min(1).max(1024), size: z.number().int().min(0).max(IMPORT_MAX_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() })).min(1).max(10_000),
  destination: z.string().max(1024).optional(),
});

type Entry = { path: string; size: number; sha256: string; received: number; excluded?: string };
type Session = { id: string; root: string; destination?: string; created: number; entries: Entry[] };
type Change = { path: string; existed: boolean; sha256?: string };
type Journal = { id: string; root: string; backup: string; changes: Change[] };
export type ImportOptions = { overwrite: boolean; restoreAccount: boolean };

const roots = new Map(["MQL5", "Profiles", "Templates", "Config", "Bases", "Tester", "Logs"].map((name) => [name.toLowerCase(), name]));

function pathParts(path: string): string[] {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || [...part].some((char) => char.charCodeAt(0) < 32) || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Import contains an unsafe or unsupported file path.");
  }
  return parts;
}

export function normaliseDataDirectory(input: string): string {
  if (!input) return "";
  const parts = pathParts(input);
  const root = roots.get(parts[0]!.toLowerCase());
  if (!root) throw new Error("Choose a folder inside MQL5, Profiles, Templates or Config, or browse the data-folder root.");
  parts[0] = root;
  return parts.join("/");
}

export function isWritableDataDirectory(path: string): boolean {
  return !path || ["mql5", "profiles", "templates", "config"].includes(path.split("/")[0]!.toLowerCase()) && !/(?:^|\/)(?:logs|cache)(?:\/|$)/i.test(path);
}

export function normaliseImportPaths(files: { path: string; size: number; sha256?: string }[], stripWrapper = true): Entry[] {
  // Only strip a common wrapper when it is not itself a recognised data root.
  const paths = files.map(({ path }) => path.replace(/\\/g, "/"));
  const metadata = (path: string) => path.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._"));
  const usefulPaths = paths.filter((path) => !metadata(path));
  const first = usefulPaths[0]?.split("/")[0] ?? "";
  const wrapper = stripWrapper && !roots.has(first.toLowerCase()) && usefulPaths.every((path) => path.startsWith(`${first}/`));
  const seen = new Set<string>();
  let total = 0;
  const entries = files.map((file, index) => {
    const raw = paths[index]!;
    const segments = pathParts(raw);
    if (wrapper && raw.startsWith(`${first}/`)) segments.shift();
    const root = roots.get(segments[0]!.toLowerCase());
    if (root) segments[0] = root;
    const path = segments.join("/");
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate import path: ${path}`);
    seen.add(key);
    let excluded: string | undefined;
    if (metadata(raw)) excluded = "Desktop metadata is not imported.";
    else if (!root || segments.length < 2) excluded = "Not an MT5 data directory (executables and origin.txt are never imported).";
    else if (["Bases", "Tester", "Logs"].includes(root) || /(?:^|\/)(?:logs|cache)(?:\/|$)/i.test(path)) excluded = "History, tester cache and logs are not imported.";
    else if (/\.(exe|com|bat|cmd|ps1|lnk|reg|sh)$/i.test(path)) excluded = "Executable installers, shortcuts and shell scripts are not imported.";
    if (!excluded) total += file.size;
    if (total > IMPORT_MAX_BYTES) throw new Error("Import exceeds the 1 GiB total limit. Exclude history/cache files.");
    return { path, size: file.size, sha256: file.sha256 ?? "", received: 0, excluded };
  });
  const accepted = new Set(entries.filter((entry) => !entry.excluded).map((entry) => entry.path.toLowerCase()));
  for (const entry of entries.filter((entry) => !entry.excluded)) {
    const parts = entry.path.toLowerCase().split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      if (accepted.has(parts.slice(0, depth).join("/"))) throw new Error("An import file conflicts with another file's parent directory.");
    }
  }
  return entries;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Match Windows' case-insensitive paths without ever following a symlink.
export async function safeTarget(root: string, path: string): Promise<string> {
  if (!path) return root;
  pathParts(path);
  let target = root;
  for (const part of path.split("/")) {
    let names: string[] = [];
    try { names = await readdir(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const matches = names.filter((name) => name.toLowerCase() === part.toLowerCase());
    if (matches.length > 1) throw new Error(`Ambiguous destination casing: ${path}`);
    target = join(target, matches[0] ?? part);
    if (await exists(target)) {
      if ((await lstat(target)).isSymbolicLink()) throw new Error("Import destination contains a symbolic link.");
    }
  }
  if (!target.startsWith(`${root}${sep}`)) throw new Error("Import destination is outside the terminal.");
  return target;
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const handle = await open(`${path}.tmp`, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(`${path}.tmp`, path);
  await syncDirectory(dirname(path));
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncParents(path: string, root: string): Promise<void> {
  for (let directory = dirname(path); directory === root || directory.startsWith(`${root}${sep}`); directory = dirname(directory)) {
    try { await syncDirectory(directory); } catch (error) {
      // Recovery also visits planned new files that may never have been made.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directory === root) break;
  }
}

async function fileHash(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export class DataImportStore {
  private readonly base: string;
  private readonly journalPath: string;
  private readonly sessions = new Map<string, Session>();
  private busy = false;

  constructor(dataDir: string) {
    this.base = resolve(dataDir, "imports");
    this.journalPath = join(this.base, "pending-apply.json");
  }

  async pending(): Promise<Journal | undefined> {
    try { return JSON.parse(await readFile(this.journalPath, "utf8")) as Journal; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Cannot read the import recovery journal; do not launch MT5 until it is repaired.");
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Another import operation is in progress.");
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private async session(id: string): Promise<Session> {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error("Invalid import ID.");
    let session = this.sessions.get(id);
    if (!session) {
      session = JSON.parse(await readFile(join(this.base, id, "manifest.json"), "utf8")) as Session;
      this.sessions.set(id, session);
    }
    if (Date.now() - session.created > 24 * 60 * 60 * 1000) throw new Error("Import expired. Cancel it and select the folder again.");
    return session;
  }

  async create(root: string, input: unknown) {
    return this.exclusive(async () => {
      if (await this.pending()) throw new Error("Recover the interrupted import before starting another.");
      const { files, destination: requestedDestination } = ImportManifestSchema.parse(input);
      const destination = requestedDestination === undefined ? undefined : normaliseDataDirectory(requestedDestination);
      if (destination !== undefined && !isWritableDataDirectory(destination)) throw new Error("Logs, history and tester folders are browse-only. Choose a writable data folder.");
      await mkdir(this.base, { recursive: true, mode: 0o700 });
      await syncDirectory(dirname(this.base));
      // One staged session at a time bounds abandoned uploads to 1 GiB.
      const existing = (await readdir(this.base, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[\da-f-]{36}$/.test(entry.name));
      if (existing.length) throw new Error(`A staged import already exists (${existing[0]!.name}). Cancel it before uploading another.`);
      // Destination transfers preserve a pasted folder's name. Full data-folder
      // restores retain the existing wrapper detection instead.
      if (destination !== undefined) files.forEach((file) => pathParts(file.path));
      const incoming = destination === undefined ? files : files.map((file) => ({ ...file, path: destination ? `${destination}/${file.path}` : file.path }));
      const session: Session = { id: randomUUID(), root: await realpath(root), destination, created: Date.now(), entries: normaliseImportPaths(incoming, destination === undefined) };
      if (session.entries.every((entry) => entry.excluded)) throw new Error("No supported MT5 data files found. Select the folder from Open Data Folder, or MQL5 itself.");
      await mkdir(join(this.base, session.id), { mode: 0o700 });
      try {
        await durableJson(join(this.base, session.id, "manifest.json"), session);
        this.sessions.set(session.id, session);
        return await this.preview(session.id);
      } catch (error) {
        await rm(join(this.base, session.id), { recursive: true, force: true });
        this.sessions.delete(session.id);
        throw error;
      }
    });
  }

  async preview(id: string) {
    const session = await this.session(id);
    const entries = [];
    for (let index = 0; index < session.entries.length; index++) {
      const entry = session.entries[index]!;
      const target = entry.excluded ? undefined : await safeTarget(session.root, entry.path);
      const stagedPath = join(this.base, id, `file-${index}`);
      const received = await exists(stagedPath) ? (await stat(stagedPath)).size : 0;
      entry.received = received;
      entries.push({ ...entry, index, received, conflict: Boolean(target && await exists(target)), account: entry.path.startsWith("Config/") });
    }
    return { id, target: session.root, destination: session.destination, entries, chunkBytes: IMPORT_CHUNK_BYTES };
  }

  async chunk(id: string, index: number, offset: number, bytes: Uint8Array, sha256?: string) {
    return this.exclusive(async () => {
      const session = await this.session(id);
      const entry = session.entries[index];
      if (!entry || entry.excluded || !Number.isSafeInteger(offset) || offset < 0 || bytes.byteLength > IMPORT_CHUNK_BYTES) throw new Error("Invalid import chunk.");
      const path = join(this.base, id, `file-${index}`);
      const received = await exists(path) ? (await stat(path)).size : 0;
      if (offset !== received || offset + bytes.byteLength > entry.size) throw new Error("Chunk offset or size does not match the manifest. Preview again before retrying.");
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await handle.write(bytes, written, bytes.byteLength - written, offset + written);
          if (!result.bytesWritten) throw new Error("Unable to write upload chunk.");
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (!offset) await syncDirectory(dirname(path));
      entry.received = offset + bytes.byteLength;
      if (sha256 !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(sha256) || entry.received !== entry.size || await fileHash(path) !== sha256) throw new Error("Uploaded content does not match the source file. Cancel and re-upload.");
        entry.sha256 = sha256;
        await durableJson(join(this.base, id, "manifest.json"), session);
      }
      return { received: entry.received };
    });
  }

  async apply(id: string, root: string, options: ImportOptions) {
    return this.exclusive(async () => {
      if (await this.pending()) throw new Error("Recover the interrupted import first.");
      const session = await this.session(id);
      if (await realpath(root) !== session.root) throw new Error("The active terminal changed. Cancel and preview the import again.");
      const preview = await this.preview(id);
      const selected = preview.entries.filter((entry) => !entry.excluded && (!entry.account || options.restoreAccount) && (!entry.conflict || options.overwrite));
      if (!selected.length) throw new Error("No files selected to apply. Existing files are preserved unless overwrite is selected.");
      if (selected.some((entry) => entry.received !== entry.size)) throw new Error("Upload is incomplete. Finish uploading before applying.");
      // Verify every staged byte before backing up or changing any destination.
      for (const entry of selected) {
        if (await fileHash(join(this.base, id, `file-${entry.index}`)) !== entry.sha256) throw new Error(`Content verification failed: ${entry.path}. Cancel and re-upload.`);
        const target = await safeTarget(session.root, entry.path);
        if (entry.conflict && !(await lstat(target)).isFile()) throw new Error(`Destination is not a regular file: ${entry.path}`);
      }
      const backupName = `backup-${id}-${randomUUID()}`;
      const backup = join(this.base, backupName);
      await mkdir(backup, { mode: 0o700 });
      await syncDirectory(this.base);
      const journal: Journal = { id, root: session.root, backup: backupName, changes: [] };
      // Back up everything before changing the first destination file.
      for (const entry of selected) {
        const target = await safeTarget(session.root, entry.path);
        const path = relative(session.root, target);
        if (entry.conflict) {
          await mkdir(dirname(join(backup, path)), { recursive: true, mode: 0o700 });
          await copyFile(target, join(backup, path), constants.COPYFILE_EXCL);
          await syncFile(join(backup, path));
          await syncParents(join(backup, path), backup);
        }
        journal.changes.push({ path, existed: entry.conflict, sha256: entry.conflict ? await fileHash(join(backup, path)) : undefined });
      }
      await durableJson(join(backup, "manifest.json"), journal);
      await durableJson(this.journalPath, journal);
      try {
        for (const entry of selected) {
          const target = await safeTarget(session.root, entry.path);
          await mkdir(dirname(target), { recursive: true });
          const temporary = `${target}.mt5-import-${id}`;
          await copyFile(join(this.base, id, `file-${entry.index}`), temporary, constants.COPYFILE_EXCL);
          await syncFile(temporary);
          await rename(temporary, target);
          await syncParents(target, session.root);
        }
        await rm(this.journalPath);
        await syncDirectory(this.base);
      } catch (error) {
        try { await this.rollbackJournal(journal); } catch {
          throw new Error(`Import interrupted. Launch is blocked. Use Recover import ${id} before starting MT5.`);
        }
        throw error;
      }
      await rm(join(this.base, id), { recursive: true, force: true });
      this.sessions.delete(id);
      return { applied: selected.length, skipped: preview.entries.length - selected.length, backup, message: "Import applied. MT5 remains stopped; launch it when ready." };
    });
  }

  private async rollbackJournal(journal: Journal) {
    const backup = join(this.base, journal.backup);
    for (const change of journal.changes) {
      if (change.existed && change.sha256 && await fileHash(join(backup, change.path)) !== change.sha256) throw new Error("Backup verification failed. Recovery is blocked to protect the original data.");
    }
    for (const change of journal.changes) {
      const target = await safeTarget(journal.root, change.path);
      if (change.existed) {
        const temporary = `${target}.mt5-rollback-${randomUUID()}`;
        await copyFile(join(backup, change.path), temporary, constants.COPYFILE_EXCL);
        await syncFile(temporary);
        await rename(temporary, target);
      } else {
        await rm(target, { force: true });
      }
      await rm(`${target}.mt5-import-${journal.id}`, { force: true });
      await syncParents(target, journal.root);
    }
    await rm(this.journalPath);
    await syncDirectory(this.base);
  }

  async recover() {
    return this.exclusive(async () => {
      const journal = await this.pending();
      if (!journal) throw new Error("No interrupted import to recover.");
      await this.rollbackJournal(journal);
      return { message: "Previous data restored. MT5 remains stopped." };
    });
  }

  async cancel(id: string) {
    return this.exclusive(async () => {
      if ((await this.pending())?.id === id) throw new Error("Recover this import before cancelling it.");
      if (!/^[\da-f-]{36}$/.test(id)) throw new Error("Invalid import ID.");
      await rm(join(this.base, id), { recursive: true, force: true });
      this.sessions.delete(id);
      return { message: "Staged import cancelled; terminal data was not changed." };
    });
  }

  async info() {
    let active: string | undefined;
    try { active = (await readdir(this.base)).find((name) => /^[\da-f-]{36}$/.test(name)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { active, recoveryRequired: Boolean(await this.pending()) };
  }
}
