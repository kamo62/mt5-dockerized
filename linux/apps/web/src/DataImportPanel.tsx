import { useEffect, useRef, useState } from "react";
import { folderFiles, zipFiles, type SelectedImportFile } from "./import-files";
import { ConfirmDialog } from "./ConfirmDialog";

type Preview = {
  id: string;
  target: string;
  destination?: string;
  chunkBytes: number;
  entries: { index: number; path: string; size: number; sha256: string; received: number; excluded?: string; conflict: boolean; account: boolean; requiresStop?: boolean }[];
};
type ImportInfo = { active?: string; recoveryRequired: boolean; target?: string; sessionMode: "restore" | "managed" };
export type ImportTransfer = { id: string; files: SelectedImportFile[]; destination: string };
export type ImportState = { ready: boolean; busy: boolean; active?: string; recoveryRequired: boolean };
const headers = { "x-linux-mt5": "1" };

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? { cache: "no-store", signal: AbortSignal.timeout(10_000) } : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Import request failed.");
  return data as T;
}

export function DataImportPanel({ stopped, disabled, onApplied, transfer, onTransferConsumed, onStateChange, refreshKey }: {
  stopped: boolean; disabled: boolean; onApplied: () => void;
  transfer?: ImportTransfer;
  onTransferConsumed: (id: string) => void;
  onStateChange: (state: ImportState) => void;
  refreshKey: string;
}) {
  const [info, setInfo] = useState<ImportInfo>();
  const [preview, setPreview] = useState<Preview>();
  const [selection, setSelection] = useState<SelectedImportFile[]>([]);
  const [destination, setDestination] = useState<string>();
  const [overwrite, setOverwrite] = useState(false);
  const [restoreAccount, setRestoreAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const upload = useRef<XMLHttpRequest | null>(null);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const working = useRef(false);
  const consumedTransfer = useRef<string | undefined>(undefined);
  const refreshGeneration = useRef(0);
  const active = preview?.id ?? info?.active;

  async function refresh() {
    const generation = ++refreshGeneration.current;
    const next = await request<ImportInfo>("/api/mt5/imports");
    if (mounted.current && generation === refreshGeneration.current) setInfo(next);
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancelled.current = true; upload.current?.abort(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { await refresh(); } catch (error) {
        if (!disposed) {
          setInfo(undefined);
          setMessage(error instanceof Error ? error.message : "Unable to check import status.");
          timer = setTimeout(() => void load(), 5000);
        }
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); refreshGeneration.current++; };
  }, [refreshKey]);
  useEffect(() => {
    onStateChange({ ready: Boolean(info), busy, active, recoveryRequired: Boolean(info?.recoveryRequired) });
  }, [info, busy, active, onStateChange]);

  async function perform(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setMessage(undefined);
    try { await action(); } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      if (mounted.current) { await refresh().catch(() => undefined); setBusy(false); setUploading(false); }
      working.current = false;
    }
  }

  function sendChunk(url: string, chunk: Blob, transferred: number, total: number, sha256?: string) {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      upload.current = xhr;
      xhr.open("POST", url);
      xhr.setRequestHeader("x-linux-mt5", "1");
      if (sha256) xhr.setRequestHeader("x-file-sha256", sha256);
      xhr.timeout = 120_000;
      xhr.upload.onprogress = (event) => setProgress(total ? Math.round((transferred + event.loaded) * 100 / total) : 100);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else { try { reject(new Error(JSON.parse(xhr.responseText).error)); } catch { reject(new Error(`Upload failed (HTTP ${xhr.status}).`)); } }
      };
      xhr.onerror = () => reject(new Error("Upload connection failed. Cancel the staged import and retry."));
      xhr.ontimeout = () => reject(new Error("Upload timed out. Cancel the staged import and retry."));
      xhr.onabort = () => reject(new Error("Upload stopped. Staged data can be cancelled below."));
      xhr.send(chunk);
    });
  }

  async function stage(files = selection, target = destination) {
    if (active) throw new Error("An import is already staged. Review it or cancel it before starting another.");
    if (!files.length) throw new Error("Select your MT5 data folder or a ZIP first.");
    if (disabled || !info || info.recoveryRequired) throw new Error("Import is currently unavailable. Check the terminal and import status.");
    cancelled.current = false;
    setUploading(true);
    setProgress(0);
    setMessage("Preparing import preview…");
    const { sha256 } = await import("@noble/hashes/sha2.js");
    if (cancelled.current) throw new Error("Upload stopped before staging.");
    const next = await request<Preview>("/api/mt5/imports", { files: files.map(({ path, file }) => ({ path, size: file.size })), ...(target === undefined ? {} : { destination: target }) });
    setPreview(next);
    setInfo((previous) => previous ? { ...previous, active: next.id } : previous);
    const accepted = next.entries.filter((entry) => !entry.excluded);
    const total = accepted.reduce((sum, entry) => sum + entry.size, 0);
    let transferred = 0;
    for (const entry of accepted) {
      const file = files[entry.index]!.file;
      const hash = sha256.create();
      for (let offset = 0; offset < file.size || offset === 0; offset += next.chunkBytes) {
        if (cancelled.current) throw new Error("Upload stopped. Cancel staged data below.");
        const chunk = file.slice(offset, offset + next.chunkBytes);
        hash.update(new Uint8Array(await chunk.arrayBuffer()));
        if (cancelled.current) throw new Error("Upload stopped. Cancel staged data below.");
        const digest = offset + chunk.size === file.size ? Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("") : undefined;
        await sendChunk(`/api/mt5/imports/${next.id}/chunk?index=${entry.index}&offset=${offset}`, chunk, transferred, total, digest);
        transferred += chunk.size;
        if (!file.size) break;
      }
    }
    setProgress(100);
    setPreview(await request<Preview>(`/api/mt5/imports/${next.id}`));
    setMessage("Upload complete. Review the files and options before applying. MT5 has not been changed.");
    await refresh();
  }

  // Only an explicit Files-panel transfer creates this command. Consume its ID
  // once; hiding or reopening the drawer must never start another upload.
  const receiveTransfer = useRef<(next: ImportTransfer) => void>(() => undefined);
  receiveTransfer.current = (next) => {
    onTransferConsumed(next.id);
    if (working.current || active || disabled || !info || info.recoveryRequired) {
      setMessage("Transfer refused. Review or cancel the current staged import, and wait for any active operation before trying again.");
      return;
    }
    setSelection(next.files);
    setDestination(next.destination);
    setOverwrite(false);
    setRestoreAccount(false);
    void perform(() => stage(next.files, next.destination));
  };
  useEffect(() => {
    if (!transfer || consumedTransfer.current === transfer.id) return;
    consumedTransfer.current = transfer.id;
    receiveTransfer.current(transfer);
  }, [transfer]);

  function clearSelection() {
    setSelection([]);
    setDestination(undefined);
    setOverwrite(false);
    setRestoreAccount(false);
  }

  async function apply() {
    if (!preview || !stopped && needsStop || disabled || info?.recoveryRequired) return;
    const result = await request<{ message: string; backup: string; applied: number; skipped: number }>(`/api/mt5/imports/${preview.id}/apply`, { overwrite, restoreAccount });
    setMessage(`${result.message} Applied ${result.applied}; skipped ${result.skipped}. Backup: ${result.backup}`);
    setPreview(undefined);
    clearSelection();
    await refresh();
    onApplied();
  }

  const accepted = preview?.entries.filter((entry) => !entry.excluded && (!entry.account || restoreAccount) && (!entry.conflict || overwrite)) ?? [];
  const complete = accepted.length > 0 && accepted.every((entry) => entry.received === entry.size && Boolean(entry.sha256));
  const needsStop = accepted.some((entry) => entry.requiresStop !== false);
  const hasAccountFiles = preview?.entries.some((entry) => entry.account && !entry.excluded);
  const hasProfileFiles = preview?.entries.some((entry) => /^(?:MQL5\/)?Profiles\//i.test(entry.path) && !entry.excluded);
  return (
    <section className="panel-section import-panel" aria-label="Import MT5 data folder">
      <h3>{destination !== undefined || preview?.destination !== undefined ? "Destination transfer" : "Import MT5 data folder"}</h3>
      <ol className="import-steps" aria-label="Import steps"><li aria-current={!selection.length && !active ? "step" : undefined}>Select</li><li aria-current={uploading || selection.length > 0 && !preview ? "step" : undefined}>Stage</li><li aria-current={preview && !uploading ? "step" : undefined}>Review</li><li>Apply</li></ol>
      {!active && <>
      <p className="upload-note">Select the folder opened by MT5 → File → Open Data Folder, or a ZIP of it. New MQL5 files can be copied while MT5 runs, then discovered with Navigator → Refresh. Account/profile changes and replacements require a stopped terminal. No automatic stop, launch or EA attachment.</p>
      <label className="upload-note">Data folder
        <input aria-label="MT5 data folder" className="file-input" type="file" multiple {...{ webkitdirectory: "" }} disabled={busy || Boolean(active) || disabled || !info || info.recoveryRequired} onChange={(event) => { clearSelection(); setSelection(folderFiles(event.target.files ?? [])); setMessage(undefined); event.target.value = ""; }} />
      </label>
      <label className="upload-note">Or ZIP archive (128 MiB compressed / 256 MiB expanded)
        <input aria-label="MT5 data ZIP" className="file-input" type="file" accept=".zip" disabled={busy || Boolean(active) || disabled || !info || info.recoveryRequired} onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) { clearSelection(); void perform(async () => { setSelection(await zipFiles(file)); }); }
        }} />
      </label>
      <p className="upload-note">{selection.length} files selected. Folder limit: 1 GiB / 10,000 files. Logs, history, terminal executables and installation metadata are excluded.</p>
      </>}
      {(preview?.destination ?? destination) !== undefined && <p className="note">Transfer destination: <code>MT5 / {preview?.destination ?? destination}</code>. Selected folder names are preserved beneath this path. {active && "Cancel this staged transfer to choose a different source."}</p>}
      {!active && <button type="button" className="secondary-button" disabled={busy || !selection.length || disabled || !info || info.recoveryRequired} onClick={() => void perform(() => stage())}>Upload to staging &amp; preview</button>}
      {uploading && <><progress aria-label="Import progress" max="100" value={progress} /><p className="upload-note" role="status">Staging {progress}% · SHA-256 verified uploads</p><button type="button" className="secondary-button" onClick={() => { cancelled.current = true; upload.current?.abort(); }}>Stop upload</button></>}
      {busy && !uploading && <p className="upload-note" role="status">Import operation in progress…</p>}
      {(preview?.target ?? info?.target) && <details><summary>Target data folder</summary><code>{preview?.target ?? info?.target}</code></details>}
      {info?.sessionMode === "managed" && <p className="upload-note">Explicit startup settings can replace imported chart/preset choices on launch. Choose Restore last session in Session to follow saved chart changes.</p>}
      {!info && <button type="button" disabled={busy || disabled} onClick={() => void perform(refresh)}>Retry import status</button>}
      {active && !preview && <button type="button" className="secondary-button" disabled={busy || disabled} onClick={() => void perform(async () => { setPreview(await request<Preview>(`/api/mt5/imports/${active}`)); setOverwrite(false); setRestoreAccount(false); })}>Review staged import</button>}
      {preview && <>
        <p className="upload-note">{preview.entries.length} files; {preview.entries.filter((entry) => entry.conflict).length} existing paths; {preview.entries.filter((entry) => entry.excluded).length} excluded.</p>
        {preview.entries.some((entry) => entry.conflict) && <label className="import-option"><input type="checkbox" checked={overwrite} disabled={busy} onChange={(event) => setOverwrite(event.target.checked)} />Overwrite existing files (backed up first)</label>}
        {hasAccountFiles ? <>
          <label className="import-option"><input type="checkbox" checked={restoreAccount} disabled={busy} onChange={(event) => setRestoreAccount(event.target.checked)} />Restore uploaded Config, including account settings</label>
          <p className="upload-note">Leave account restore off to keep this terminal’s saved login. Passwords copied from another machine may not decrypt. Keep MT5’s “Save password” enabled.</p>
        </> : <p className="upload-note">No account configuration is included. This terminal’s saved login is preserved.</p>}
        {hasProfileFiles && <p className="upload-note">Profiles are merged, not mirrored. A profile containing both new and existing chart files can restore a mixed layout; review its paths before applying.</p>}
        <details><summary>File preview</summary><ul className="import-file-list">{preview.entries.map((entry) => <li key={entry.index}><code>{entry.path}</code> · {entry.size} bytes · {entry.excluded ?? (entry.account && !restoreAccount ? "preserve current account" : entry.conflict && !overwrite ? "keep existing" : entry.received !== entry.size || !entry.sha256 ? "incomplete / checksum pending" : entry.conflict ? "replace with backup" : "add")}</li>)}</ul></details>
        {!stopped && needsStop && <p className="note">This selection replaces existing files or changes account/chart state. Stop MT5 before applying it.</p>}
        {!stopped && !needsStop && accepted.length > 0 && <p className="note">These are new MQL5 files only. MT5 can stay running. Use Navigator → Refresh afterwards; this does not reload an already attached EA.</p>}
        <button type="button" className="secondary-button" disabled={busy || disabled || !stopped && needsStop || !complete || info?.recoveryRequired} onClick={() => setConfirmApply(true)}>Apply {accepted.length} files {stopped ? "(keep MT5 stopped)" : needsStop ? "(requires stopped MT5)" : "(keep MT5 running)"}</button>
      </>}
      {active && <button type="button" className="secondary-button" disabled={busy || disabled || info?.recoveryRequired} onClick={() => void perform(async () => { await request(`/api/mt5/imports/${active}/cancel`, {}); setPreview(undefined); clearSelection(); setProgress(0); setMessage("Staged import cancelled. Terminal data was not changed."); await refresh(); })}>Cancel staged import</button>}
      {info?.recoveryRequired && <><p role="alert" className="note">An interrupted import must be recovered before MT5 can launch.</p><button type="button" className="secondary-button" disabled={busy || disabled || !stopped} onClick={() => void perform(async () => { const result = await request<{ message: string }>("/api/mt5/imports/recover", {}); setMessage(result.message); setPreview(undefined); clearSelection(); await refresh(); onApplied(); })}>Recover previous data</button></>}
      {message && <p role="status" className="upload-note">{message}</p>}
      {confirmApply && preview && <ConfirmDialog title="Apply this import?" confirmLabel={`Apply ${accepted.length} files`} disabled={busy || disabled || !stopped && needsStop || !complete || info?.recoveryRequired} onCancel={() => setConfirmApply(false)} onConfirm={() => { setConfirmApply(false); void perform(apply); }}><p>Destination: <code>{preview.target}{preview.destination ? `/${preview.destination}` : ""}</code></p><p>{restoreAccount ? "Uploaded Config may replace the current account, server and saved-password settings." : "The current account configuration will be preserved."}</p><p>{overwrite ? "Existing files are backed up before replacement." : "Existing files will be kept."} {stopped ? "MT5 stays stopped. Launch it yourself when ready." : "MT5 keeps running. Use Navigator → Refresh to discover new files. No EA is attached or reinitialised by this action."}</p></ConfirmDialog>}
    </section>
  );
}
