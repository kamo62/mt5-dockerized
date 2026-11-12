export type SelectedImportFile = { path: string; file: File };

export function folderFiles(files: FileList | File[]): SelectedImportFile[] {
  return Array.from(files, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

// Capture the entries during the drop event: browsers clear DataTransfer after
// the handler returns. Directory readers may return several batches.
export async function droppedFiles(data: DataTransfer): Promise<SelectedImportFile[]> {
  const items = Array.from(data.items).filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  if (!entries.some(Boolean)) {
    const files = folderFiles(data.files);
    if (!files.length) throw new Error("This browser did not expose the dropped files. Use Choose folder for directories.");
    return files;
  }
  if (entries.some((entry) => !entry)) throw new Error("This browser could not read every dropped item. Use Choose files or Choose folder instead.");
  const files: SelectedImportFile[] = [];
  let bytes = 0;
  let visited = 0;
  async function visit(entry: FileSystemEntry, parent: string) {
    if (++visited > 20_000) throw new Error("Too many directory entries. Choose a smaller folder.");
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      bytes += file.size;
      if (files.length >= 10_000 || bytes > 1024 ** 3) throw new Error("Folder exceeds 10,000 files or 1 GiB. Choose a smaller transfer.");
      files.push({ path, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, path);
      }
    } else throw new Error("Unsupported dropped item. Use the folder picker instead.");
  }
  for (const entry of entries) if (entry) await visit(entry, "");
  if (!files.length) throw new Error("No files found. Empty folders are not transferred.");
  return files;
}

export async function zipFiles(file: File): Promise<SelectedImportFile[]> {
  if (file.size > 128 * 1024 * 1024) throw new Error("ZIP exceeds 128 MiB. Use the folder picker for larger imports.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  // Inspect the central directory before allocating decompressed contents.
  // Reject links, encryption, multi-disk and ZIP64 rather than guessing.
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < 0 || bytes.length < 22 || view.getUint32(end, true) !== 0x06054b50) throw new Error("Invalid ZIP archive.");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const directoryOffset = offset;
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 65535 || count > 10_000 || offset === 0xffffffff) throw new Error("ZIP64, split or oversized archives are not supported. Use the folder picker.");
  let total = 0;
  const names = new Set<string>();
  const entries: { name: string; size: number; compressed: number; local: number; method: number }[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP directory.");
    const flags = view.getUint16(offset + 8, true);
    const mode = view.getUint32(offset + 38, true) >>> 16;
    if (flags & 1 || (mode & 0xf000) === 0xa000) throw new Error("Encrypted ZIPs and symbolic links are not supported.");
    total += view.getUint32(offset + 24, true);
    if (total > 256 * 1024 * 1024) throw new Error("Expanded ZIP exceeds 256 MiB. Use the folder picker for larger imports.");
    const nameLength = view.getUint16(offset + 28, true);
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x800) && rawName.some((byte) => byte > 127)) throw new Error("Unsupported ZIP filename encoding. Use a UTF-8 ZIP or the folder picker.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
    if (names.has(name.toLowerCase())) throw new Error("ZIP contains duplicate file paths.");
    names.add(name.toLowerCase());
    entries.push({ name, size: view.getUint32(offset + 24, true), compressed: view.getUint32(offset + 20, true), local: view.getUint32(offset + 42, true), method: view.getUint16(offset + 10, true) });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (offset > end) throw new Error("Invalid ZIP directory length.");
  }
  const { Inflate } = await import("fflate");
  let actualSize = 0;
  const selected: SelectedImportFile[] = [];
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    if (entry.local + 30 > directoryOffset || view.getUint32(entry.local, true) !== 0x04034b50) throw new Error("Invalid ZIP local header.");
    if (view.getUint16(entry.local + 6, true) & 1 || view.getUint16(entry.local + 8, true) !== entry.method) throw new Error("ZIP local header does not match its directory.");
    const nameLength = view.getUint16(entry.local + 26, true);
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(entry.local + 30, entry.local + 30 + nameLength));
    if (localName !== entry.name) throw new Error("ZIP local path does not match its directory.");
    const start = entry.local + 30 + nameLength + view.getUint16(entry.local + 28, true);
    if (start + entry.compressed > directoryOffset || ![0, 8].includes(entry.method)) throw new Error("Unsupported ZIP compression or invalid entry bounds.");
    let size = 0;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    const receive = (chunk: Uint8Array) => {
      size += chunk.length;
      actualSize += chunk.length;
      if (size > entry.size || actualSize > 256 * 1024 * 1024) throw new Error("ZIP expanded contents exceed the declared size or safe extraction limit.");
      parts.push(new Uint8Array(chunk));
    };
    if (entry.method === 0) receive(bytes.subarray(start, start + entry.compressed));
    else {
      // Small compressed input chunks bound allocation even if an archive lies
      // about its expanded size. Do not allocate an entire inflate result first.
      const inflater = new Inflate(receive);
      for (let position = 0; position < entry.compressed; position += 16_384) {
        inflater.push(bytes.subarray(start + position, start + Math.min(position + 16_384, entry.compressed)), position + 16_384 >= entry.compressed);
        if (position % 262_144 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (size !== entry.size) throw new Error("ZIP expanded size does not match its directory.");
    selected.push({ path: entry.name, file: new File(parts, entry.name.split("/").at(-1)!) });
  }
  return selected;
}
