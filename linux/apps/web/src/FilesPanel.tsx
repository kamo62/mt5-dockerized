import { ArrowUp, ChevronRight, File, Folder, Link, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { droppedFiles, folderFiles, type SelectedImportFile } from "./import-files";

export type FilesListing = {
  root: string; windowsRoot?: string; path: string; parent: string | null;
  exists: boolean; writable: boolean; truncated: boolean;
  entries: { name: string; path: string; kind: "directory" | "file" | "link"; size?: number }[];
};

export function FilesPanel({ active, offline, transferBlocked, refreshKey, onTransfer, onReview, onListing }: {
  active: boolean;
  offline: boolean;
  transferBlocked?: string;
  refreshKey: number;
  onTransfer: (files: SelectedImportFile[], destination: string) => boolean;
  onReview: () => void;
  onListing: (listing: FilesListing) => void;
}) {
  const [listing, setListing] = useState<FilesListing>();
  const [path, setPath] = useState("");
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [readingDrop, setReadingDrop] = useState(false);
  const [selection, setSelection] = useState<SelectedImportFile[]>([]);
  const [message, setMessage] = useState<string>();
  const [browseError, setBrowseError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentPath = useRef("");
  const loaded = useRef(false);
  const refreshedKey = useRef(-1);
  const latestListing = useRef(onListing);
  latestListing.current = onListing;

  const browse = useCallback(async (destination: string) => {
    const requestId = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setLoading(true);
    setBrowseError(undefined);
    try {
      const response = await fetch(`/api/mt5/files?path=${encodeURIComponent(destination)}`, {
        headers: { "x-linux-mt5": "1" }, cache: "no-store",
        signal: AbortSignal.any([controller.current.signal, AbortSignal.timeout(10_000)]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `Folder request failed (HTTP ${response.status}).`);
      if (requestId !== generation.current) return;
      const next = data as FilesListing;
      setListing(next);
      setPath(next.path);
      setEdited(false);
      currentPath.current = next.path;
      loaded.current = true;
      latestListing.current(next);
    } catch (error) {
      if (requestId !== generation.current) return;
      setListing(undefined);
      loaded.current = false;
      setBrowseError(error instanceof Error ? error.message : "Unable to browse this folder.");
    } finally { if (requestId === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (offline) loaded.current = false;
    if (active && !offline && (!loaded.current || refreshedKey.current !== refreshKey)) {
      refreshedKey.current = refreshKey;
      void browse(currentPath.current);
    }
  }, [active, offline, refreshKey, browse]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  const blocked = transferBlocked ?? (offline ? "Control server is unreachable." : loading ? "Wait for the destination to load." : edited ? "Press Go to resolve the edited destination first." : !listing ? "Choose a destination first." : !listing.writable ? "This location is browse-only. Choose a folder under MQL5, Profiles, Templates or Config." : undefined);

  function transfer(files: SelectedImportFile[], destination: string) {
    // Keep File objects available if the import panel refuses a racing transfer.
    setSelection(files);
    if (blocked) { setMessage(blocked); return; }
    if (!files.length) { setMessage("Choose files or a folder first."); return; }
    if (onTransfer(files, destination)) setMessage(`Transfer sent to Import for MT5 / ${destination || "data folder"}. Selection is retained for retry; terminal data has not been changed.`);
  }

  return <section className="panel-section" aria-label="MT5 destination browser">
    <form className="path-form" onSubmit={(event) => { event.preventDefault(); void browse(path); }}>
      <label htmlFor="destination-path">Destination in MT5 data folder</label>
      <div className="button-row path-input-row">
        <input id="destination-path" className="technical-path" value={path} disabled={loading} onChange={(event) => { setPath(event.target.value); setEdited(true); }} placeholder="MQL5/Experts or an absolute data-folder path" spellCheck={false} />
        <button type="submit" disabled={offline}>Go</button>
      </div>
    </form>
    <p className="upload-note">Paste a relative path, or this terminal’s Linux / Windows data-folder path. Only this data folder can be browsed.</p>
    {listing && <details className="root-paths"><summary>Active data-folder paths</summary><code>{listing.root}</code>{listing.windowsRoot && <code>{listing.windowsRoot}</code>}</details>}
    <div className="button-row folder-shortcuts" aria-label="Destination shortcuts">
      {[["MQL5/Experts", "Experts"], ["MQL5/Indicators", "Indicators"], ["MQL5/Include", "Include"], ["MQL5/Libraries", "Libraries"], ["MQL5/Files", "Files"], ["Profiles", "Profiles"], ["Templates", "Templates"], ["Config", "Config"]].map(([destination, label]) => <button key={destination} type="button" disabled={offline} onClick={() => void browse(destination!)}>{label}</button>)}
    </div>
    <nav className="breadcrumbs" aria-label="Destination breadcrumbs">
      <button type="button" disabled={offline || !listing || listing.parent === null} onClick={() => listing && void browse(listing.parent!)} aria-label="Parent folder"><ArrowUp size={15} /></button>
      <button type="button" disabled={offline} onClick={() => void browse("")}>MT5 data</button>
      {listing?.path.split("/").filter(Boolean).map((part, index, parts) => <span key={parts.slice(0, index + 1).join("/")}><ChevronRight size={12} aria-hidden="true" /><button type="button" disabled={offline} onClick={() => void browse(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}
      <button type="button" disabled={loading || offline} aria-label="Refresh destination" onClick={() => void browse(currentPath.current)}><RefreshCcw size={14} /></button>
    </nav>
    {browseError && <p className="note error-text" role="alert">{browseError}</p>}
    {loading && <p className="upload-note" role="status">Loading destination…</p>}
    {listing && <>
      <ul className="directory-list" aria-label="Destination contents" aria-busy={loading}>
        {listing.entries.map((entry) => <li key={entry.path}>
          {entry.kind === "directory" ? <button type="button" disabled={offline || loading} onClick={() => void browse(entry.path)}><Folder size={16} aria-hidden="true" /><span>{entry.name}</span><ChevronRight size={14} aria-hidden="true" /></button> : <div>{entry.kind === "link" ? <Link size={16} aria-hidden="true" /> : <File size={16} aria-hidden="true" />}<span>{entry.name}</span><small>{entry.kind === "link" ? "Link · unavailable" : entry.size === undefined ? "File" : `${entry.size.toLocaleString()} B`}</small></div>}
        </li>)}
        {!listing.entries.length && <li className="directory-empty">{listing.exists ? "This folder is empty." : "Folder does not exist yet. It is created only when you apply an import."}</li>}
      </ul>
      {listing.truncated && <p className="upload-note">Listing limited by the server. Navigate to a subfolder or paste its path.</p>}
      <p className="upload-note">{listing.writable ? "Transfers are staged, checked and reviewed before apply." : "Browse-only location. Transfers are unavailable here."}</p>
    </>}
    <div className={`transfer-zone${dragging ? " dragging" : ""}`} tabIndex={0} role="group" aria-label="Drop or paste files to stage at the current destination"
      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = blocked ? "none" : "copy"; setDragging(true); } }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false);
        if (blocked || readingDrop || !listing) { setMessage(blocked ?? "Wait for the current folder selection."); return; }
        const destination = listing.path;
        const files = droppedFiles(event.dataTransfer);
        setReadingDrop(true);
        void files.then((next) => transfer(next, destination)).catch((error: Error) => setMessage(error.message)).finally(() => setReadingDrop(false));
      }}
      onPaste={(event) => {
        if (!event.clipboardData.files.length) { setMessage("No files were exposed by the browser. Use Choose files / Choose folder. Pasted local path text cannot grant file access."); return; }
        event.preventDefault();
        if (readingDrop || !listing) { setMessage("Choose a destination and wait for any current folder read first."); return; }
        transfer(folderFiles(event.clipboardData.files), listing.path);
      }}>
      <h3>Transfer to this destination</h3>
      <p className="technical-path transfer-target">MT5 / {listing?.path || "data folder"}</p>
      <p className="upload-note">Drop files or folders here, or focus this box and paste files with Ctrl/Cmd+V, to stage and open Import review. Folder drops preserve the selected folder name.</p>
      <label>Choose files<input className="file-input" type="file" multiple disabled={Boolean(transferBlocked) || readingDrop || offline} onChange={(event) => { setSelection(folderFiles(event.target.files ?? [])); setMessage(undefined); event.target.value = ""; }} /></label>
      <label>Choose folder<input className="file-input" type="file" multiple {...{ webkitdirectory: "" }} disabled={Boolean(transferBlocked) || readingDrop || offline} onChange={(event) => { setSelection(folderFiles(event.target.files ?? [])); setMessage(undefined); event.target.value = ""; }} /></label>
      <p className="upload-note">{readingDrop ? "Reading dropped folder…" : `${selection.length} files selected. Selection alone does not upload.`} If directory drop or paste is unsupported, use Choose folder.</p>
      {selection.length > 0 && <details><summary>Selected paths</summary><ul className="import-file-list">{selection.map((file, index) => <li key={`${file.path}:${index}`}><code>{file.path}</code></li>)}</ul></details>}
      <button className="primary-button" type="button" disabled={Boolean(blocked) || readingDrop || !selection.length} onClick={() => listing && transfer(selection, listing.path)}>Stage to destination &amp; review</button>
      {selection.length > 0 && <button type="button" disabled={readingDrop} onClick={() => setSelection([])}>Clear local selection</button>}
    </div>
    {blocked && <p className="upload-note">{blocked}</p>}
    {transferBlocked && <button type="button" onClick={onReview}>Open Import review</button>}
    {message && <p className="note" role="status">{message}</p>}
  </section>;
}
