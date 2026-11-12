import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { DataImportStore, normaliseImportPaths } from "./data-import";

test("data imports preserve relative paths and reject traversal, aliases and duplicate Windows paths", () => {
  expect(normaliseImportPaths([{ path: "My MT5/MQL5/Experts/MyEA/EA.ex5", size: 2 }])[0]?.path).toBe("MQL5/Experts/MyEA/EA.ex5");
  expect(normaliseImportPaths([{ path: "MQL5/Files/EA/settings.json", size: 2 }])[0]?.excluded).toBeUndefined();
  for (const path of ["MQL5/../config/common.ini", "/MQL5/a", "C:/MQL5/a", "MQL5/Files/CON.txt", "MQL5/Files/a.", "MQL5/Files/a:stream"]) {
    expect(() => normaliseImportPaths([{ path, size: 1 }])).toThrow("unsafe");
  }
  expect(() => normaliseImportPaths([{ path: "MQL5/Experts/A.ex5", size: 1 }, { path: "mql5/experts/a.ex5", size: 1 }])).toThrow("Duplicate");
  expect(normaliseImportPaths([{ path: "__MACOSX/._MT5", size: 1 }, { path: "MT5/MQL5/Experts/EA.ex5", size: 1 }])[1]?.path).toBe("MQL5/Experts/EA.ex5");
  expect(() => normaliseImportPaths([{ path: "MQL5/Experts", size: 1 }, { path: "MQL5/Experts/EA.ex5", size: 1 }])).toThrow("parent directory");
});

test("chunked folder import previews conflicts, preserves account by default and creates backups", async () => {
  const data = await mkdtemp(join(tmpdir(), "mt5-data-import-"));
  const root = join(data, "terminal");
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(root, "MQL5/Experts/Nested"), { recursive: true });
    await writeFile(join(root, "config/accounts.dat"), "saved-encrypted-account");
    await writeFile(join(root, "config/common.ini"), "saved-login-and-profile");
    await writeFile(join(root, "MQL5/Experts/Nested/EA.ex5"), "old-ea");
    const store = new DataImportStore(data);
    const files = [
      { path: "Backup/MQL5/Experts/Nested/EA.ex5", data: "new-ea" },
      { path: "Backup/MQL5/Files/EA/settings.json", data: "abcdef" },
      { path: "Backup/Config/accounts.dat", data: "another-account" },
      { path: "Backup/Config/common.ini", data: "another-login" },
      { path: "Backup/MQL5/Include/empty.mqh", data: "" },
      { path: "Backup/Logs/20261112.log", data: "old-journal" },
      { path: "Backup/origin.txt", data: "wrong-installation" },
    ];
    const preview = await store.create(root, { files: files.map((file) => ({ path: file.path, size: file.data.length })) });
    expect(preview.entries[0]?.conflict).toBe(true);
    expect(preview.entries[2]?.account).toBe(true);
    expect(preview.entries[5]?.excluded).toBeTruthy();
    expect(preview.entries[6]?.excluded).toBeTruthy();
    for (const entry of preview.entries.filter((entry) => !entry.excluded)) {
      const contents = new TextEncoder().encode(files[entry.index]!.data);
      const middle = Math.floor(contents.length / 2);
      const digest = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
      await store.chunk(preview.id, entry.index, 0, contents.slice(0, middle), contents.length ? undefined : digest);
      if (contents.length) await store.chunk(preview.id, entry.index, middle, contents.slice(middle), digest);
    }
    const result = await store.apply(preview.id, root, { overwrite: true, restoreAccount: false });
    expect(await readFile(join(root, "config/accounts.dat"), "utf8")).toBe("saved-encrypted-account");
    expect(await readFile(join(root, "config/common.ini"), "utf8")).toBe("saved-login-and-profile");
    expect(await readFile(join(root, "MQL5/Files/EA/settings.json"), "utf8")).toBe("abcdef");
    expect(await readFile(join(root, "MQL5/Experts/Nested/EA.ex5"), "utf8")).toBe("new-ea");
    expect(await readFile(join(result.backup, "MQL5/Experts/Nested/EA.ex5"), "utf8")).toBe("old-ea");
    expect(await readFile(join(root, "MQL5/Include/empty.mqh"), "utf8")).toBe("");
    expect(await store.pending()).toBeUndefined();
    // A new server/store sees the same saved login and profile, not image state.
    expect((await new DataImportStore(data).info()).recoveryRequired).toBe(false);
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("imports reject symlink destinations and incomplete uploads without modifying terminal files", async () => {
  const data = await mkdtemp(join(tmpdir(), "mt5-import-safety-"));
  const root = join(data, "terminal");
  try {
    await mkdir(join(root, "MQL5"), { recursive: true });
    await mkdir(join(data, "outside"));
    await symlink(join(data, "outside"), join(root, "MQL5/Files"));
    const store = new DataImportStore(data);
    await expect(store.create(root, { files: [{ path: "MQL5/Files/secret.txt", size: 1 }] })).rejects.toThrow("symbolic link");
    expect((await store.info()).active).toBeUndefined();
    const preview = await store.create(root, { files: [{ path: "MQL5/Experts/EA.ex5", size: 2 }] });
    await expect(store.apply(preview.id, root, { overwrite: false, restoreAccount: false })).rejects.toThrow("incomplete");
    await store.cancel(preview.id);
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("an interrupted import can be rolled back after a server restart", async () => {
  const data = await mkdtemp(join(tmpdir(), "mt5-import-recovery-"));
  const root = join(data, "terminal");
  const id = crypto.randomUUID();
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await mkdir(join(data, `imports/backup-${id}/config`), { recursive: true });
    await writeFile(join(data, `imports/backup-${id}/config/accounts.dat`), "original-encrypted-account");
    await writeFile(join(root, "config/accounts.dat"), "partial-replacement");
    await writeFile(join(root, "config/new-file.dat"), "partial-new-file");
    await writeFile(join(data, "imports/pending-apply.json"), JSON.stringify({ id, root, backup: `backup-${id}`, changes: [{ path: "config/accounts.dat", existed: true }, { path: "config/new-file.dat", existed: false }, { path: "MQL5/Profiles/Charts/NeverCreated/new.chr", existed: false }] }));
    const restarted = new DataImportStore(data);
    expect((await restarted.info()).recoveryRequired).toBe(true);
    await restarted.recover();
    expect(await readFile(join(root, "config/accounts.dat"), "utf8")).toBe("original-encrypted-account");
    expect(await Bun.file(join(root, "config/new-file.dat")).exists()).toBe(false);
    expect(await restarted.pending()).toBeUndefined();
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("account restore is explicit, backup is retained, and tampered staging fails verification", async () => {
  const data = await mkdtemp(join(tmpdir(), "mt5-import-account-"));
  const root = join(data, "terminal");
  const contents = new TextEncoder().encode("restored-account");
  const digest = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config/accounts.dat"), "current-account");
    const store = new DataImportStore(data);
    const preview = await store.create(root, { files: [{ path: "Data/Config/accounts.dat", size: contents.length }] });
    await store.chunk(preview.id, 0, 0, contents, digest);
    await expect(store.apply(preview.id, root, { overwrite: true, restoreAccount: false })).rejects.toThrow("No files");
    expect(await readFile(join(root, "config/accounts.dat"), "utf8")).toBe("current-account");
    const result = await store.apply(preview.id, root, { overwrite: true, restoreAccount: true });
    expect(await readFile(join(root, "config/accounts.dat"), "utf8")).toBe("restored-account");
    expect(await readFile(join(result.backup, "config/accounts.dat"), "utf8")).toBe("current-account");
    const next = await store.create(root, { files: [{ path: "Config/accounts.dat", size: contents.length }] });
    await store.chunk(next.id, 0, 0, contents, digest);
    await writeFile(join(data, "imports", next.id, "file-0"), "tampered-account");
    await expect(store.apply(next.id, root, { overwrite: true, restoreAccount: true })).rejects.toThrow("verification failed");
    expect(await readFile(join(root, "config/accounts.dat"), "utf8")).toBe("restored-account");
  } finally { await rm(data, { recursive: true, force: true }); }
});
