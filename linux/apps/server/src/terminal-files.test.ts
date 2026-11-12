import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { listTerminalFiles, relativeDataDirectory } from "./terminal-files";
import { DataImportStore } from "./data-import";

test("the file browser resolves only active data-folder paths without creating destinations", async () => {
  const base = await mkdtemp(join(tmpdir(), "mt5-file-browser-"));
  const root = join(base, "terminal");
  const windows = "C:\\Program Files\\MetaTrader 5";
  try {
    await mkdir(join(root, "MQL5/Experts"), { recursive: true });
    await mkdir(join(root, "config"));
    await writeFile(join(root, "terminal64.exe"), "not an exposed data-folder file");
    const listing = await listTerminalFiles(root, "", windows);
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual(["MQL5", "config"]);
    const selected = await listTerminalFiles(root, "c:\\program files\\metatrader 5\\mql5\\experts\\NewFolder", windows);
    expect(selected.path).toBe("MQL5/Experts/NewFolder");
    expect(selected.exists).toBe(false);
    expect(selected.writable).toBe(true);
    expect(await Bun.file(join(root, selected.path)).exists()).toBe(false);
    expect(relativeDataDirectory(`${root}/MQL5/Experts`, root, windows)).toBe("MQL5/Experts");
    expect((await listTerminalFiles(root, "Logs", windows)).writable).toBe(false);
    for (const path of ["../../etc", "/etc", "C:\\Windows", "MQL5/../Config", "MQL5/Files/CON"]) {
      await expect(listTerminalFiles(root, path, windows)).rejects.toThrow();
    }
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(root, "MQL5/External"));
    expect((await listTerminalFiles(root, "MQL5", windows)).entries.find((entry) => entry.name === "External")?.kind).toBe("link");
    await expect(listTerminalFiles(root, "MQL5/External", windows)).rejects.toThrow("symbolic link");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("destination paste retains folder names, keeps account protection and never strips a root wrapper", async () => {
  const base = await mkdtemp(join(tmpdir(), "mt5-destination-transfer-"));
  const root = join(base, "terminal");
  try {
    await mkdir(root);
    const store = new DataImportStore(base);
    const paste = await store.create(root, { destination: "mql5/Experts", files: [{ path: "MyEA/EA.ex5", size: 2 }, { path: "MyEA/resources/settings.json", size: 2 }] });
    expect(paste.destination).toBe("MQL5/Experts");
    expect(paste.entries.map((entry) => entry.path)).toEqual(["MQL5/Experts/MyEA/EA.ex5", "MQL5/Experts/MyEA/resources/settings.json"]);
    await store.cancel(paste.id);
    const account = await store.create(root, { destination: "Config", files: [{ path: "accounts.dat", size: 2 }] });
    expect(account.entries[0]?.account).toBe(true);
    await store.cancel(account.id);
    await expect(store.create(root, { destination: "", files: [{ path: "Wrapper/MQL5/Experts/EA.ex5", size: 2 }] })).rejects.toThrow("No supported");
    await expect(store.create(root, { destination: "MQL5/../Config", files: [{ path: "accounts.dat", size: 2 }] })).rejects.toThrow("unsafe");
    await expect(store.create(root, { destination: "Logs", files: [{ path: "example.log", size: 2 }] })).rejects.toThrow("browse-only");
  } finally { await rm(base, { recursive: true, force: true }); }
});
