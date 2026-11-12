import { readdir, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { Dirent } from "node:fs";
import { isWritableDataDirectory, normaliseDataDirectory, safeTarget } from "./data-import";

export function relativeDataDirectory(input: string, root: string, windowsRoot?: string): string {
  let path = input.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const linuxRoot = root.replace(/\/+$/, "");
  const windows = windowsRoot?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (path === linuxRoot || windows && path.toLowerCase() === windows.toLowerCase()) return "";
  if (path.startsWith(`${linuxRoot}/`)) path = path.slice(linuxRoot.length + 1);
  else if (windows && path.toLowerCase().startsWith(`${windows.toLowerCase()}/`)) path = path.slice(windows.length + 1);
  return normaliseDataDirectory(path);
}

export async function listTerminalFiles(root: string, input: string, windowsRoot?: string) {
  const canonicalRoot = await realpath(root);
  const requested = relativeDataDirectory(input, root, windowsRoot);
  const target = await safeTarget(canonicalRoot, requested);
  let exists = true;
  let children: Dirent[];
  try {
    if (!(await stat(target)).isDirectory()) throw new Error("This path is a file. Choose its parent folder as the destination.");
    children = await readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
    children = [];
  }
  const path = relative(canonicalRoot, target).replace(/\\/g, "/");
  const sorted = children.filter((entry) => path || entry.isDirectory() && ["mql5", "profiles", "templates", "config", "bases", "tester", "logs"].includes(entry.name.toLowerCase())).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const entries = sorted.slice(0, 1000).map((entry) => ({
    name: entry.name,
    path: path ? `${path}/${entry.name}` : entry.name,
    kind: entry.isSymbolicLink() ? "link" as const : entry.isDirectory() ? "directory" as const : "file" as const,
  }));
  return { root, windowsRoot, path, parent: path ? path.split("/").slice(0, -1).join("/") : null, exists, writable: isWritableDataDirectory(path), entries, truncated: sorted.length > entries.length };
}
