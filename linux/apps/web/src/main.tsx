import {
  Activity,
  ChevronDown,
  Clipboard,
  Download,
  ExternalLink,
  Folder,
  Maximize,
  Minimize,
  Monitor,
  Play,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  Square,
  Terminal,
  Upload,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { DataImportPanel, type ImportState, type ImportTransfer } from "./DataImportPanel";
import { FilesPanel, type FilesListing } from "./FilesPanel";
import { ClipboardPanel } from "./ClipboardPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { StartupPanel } from "./StartupPanel";
import type { SelectedImportFile } from "./import-files";

type Mt5State =
  | "idle"
  | "installing"
  | "launching"
  | "running"
  | "stopping"
  | "failed";

type Mt5Status = {
  desktop: "starting" | "ready" | "failed";
  mt5: Mt5State;
  installed: boolean;
  installerRunning: boolean;
  installerFiles: {
    mt5Setup: boolean;
    webviewSetup: boolean;
  };
  paths: {
    dataDir: string;
    cacheDir: string;
    winePrefix: string;
    mt5InstallerPath: string;
    webviewInstallerPath: string;
    mt5ExecutablePath?: string;
  };
  lastError?: string;
  expert?: { name: string; state: "unverified" | "loaded" | "removed" | "failed"; lastError?: string };
  sessionMode?: "restore" | "managed";
  logs: string[];
};

type RuntimeConfig = {
  noVncUrl: string;
};

type ExpertsInfo = {
  expertsDir: string;
  files: string[];
  uploaded?: string[];
};

type PendingAction = "install" | "launch" | "stop" | "restart" | "acknowledge";
type Drawer = "files" | "clipboard" | "session" | "diagnostics";

const emptyStatus: Mt5Status = {
  desktop: "starting",
  mt5: "idle",
  installed: false,
  installerRunning: false,
  installerFiles: {
    mt5Setup: false,
    webviewSetup: false,
  },
  paths: {
    dataDir: "",
    cacheDir: "",
    winePrefix: "",
    mt5InstallerPath: "",
    webviewInstallerPath: "",
  },
  logs: [],
};

const actionHeaders = { "x-linux-mt5": "1" };
const logTimeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

async function postJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: actionHeaders,
    method: "POST",
  });
  const data = (await response.json()) as unknown;
  if (
    !response.ok &&
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    throw new Error(data.error);
  }
  if (!response.ok) throw new Error(`Action failed (HTTP ${response.status}).`);
  return data as T;
}

function stateLabel(status: Mt5Status): string {
  if (status.mt5 === "failed") return "Failed";
  if (status.installerRunning || status.mt5 === "installing") return "Installer active";
  if (status.mt5 === "launching") return "Launching…";
  if (status.mt5 === "stopping") return "Stopping…";
  if (status.mt5 === "running") return "Running";
  return status.installed ? "Stopped" : "Not installed";
}

function parseLog(line: string): { time: string; message: string; tone: string } {
  const match = line.match(/^\[(?<iso>[^\]]+)]\s(?<message>.*)$/);
  const message = match?.groups?.message ?? line;
  const lower = message.toLowerCase();
  const tone =
    lower.includes("error") || lower.includes("failed")
      ? "bad"
      : lower.includes("downloaded") ||
          lower.includes("launched") ||
          lower.includes("ready")
        ? "good"
        : "neutral";

  const date = match?.groups?.iso ? new Date(match.groups.iso) : undefined;
  return {
    time: date && !Number.isNaN(date.getTime())
      ? logTimeFormat.format(date)
      : "--:--:--",
    message,
    tone,
  };
}

function StatusPill({
  label,
  value,
  tone = "neutral",
  onClick,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`status-pill status-pill-${tone}`} onClick={onClick} aria-label={`${label}: ${value}. Open runtime evidence.`}>
      <i className={`led ${tone}`} aria-hidden="true" />
      <small>{label}</small>
      <strong>{value}</strong>
    </button>
  );
}

function ActionButton({
  icon,
  label,
  pending,
  disabled,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={`action-button${danger ? " danger-button" : ""}`}
      disabled={disabled || pending}
      onClick={onClick}
      type="button"
    >
      {pending ? <RefreshCcw className="spin" size={17} /> : icon}
      <span>{label}</span>
    </button>
  );
}

function DrawerSection({ name, title, description, active, onClose, children }: {
  name: Drawer; title: string; description: string; active?: Drawer; onClose: () => void; children: React.ReactNode;
}) {
  return <section className="drawer-section" id={`drawer-${name}`} hidden={active !== name} aria-labelledby={`heading-${name}`}>
    <header className="drawer-heading"><div><h2 id={`heading-${name}`} tabIndex={-1}>{title}</h2><p>{description}</p></div><button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><X size={17} /></button></header>
    {children}
  </section>;
}

function App() {
  const [status, setStatus] = useState<Mt5Status>(emptyStatus);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>();
  const [desktopError, setDesktopError] = useState<string>();
  const [pending, setPending] = useState<PendingAction>();
  const [error, setError] = useState<string>();
  const [expertsInfo, setExpertsInfo] = useState<ExpertsInfo>();
  const [uploadingExperts, setUploadingExperts] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string>();
  const [desktopKey, setDesktopKey] = useState(0);
  const [offline, setOffline] = useState(false);
  const [hasStatus, setHasStatus] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>();
  const [filesTab, setFilesTab] = useState<"browse" | "transfers">("browse");
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [expandedDesktop, setExpandedDesktop] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState<string>();
  const [activityOpen, setActivityOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"stop" | "restart">();
  const [importState, setImportState] = useState<ImportState>({ ready: false, busy: false, recoveryRequired: false });
  const [transfer, setTransfer] = useState<ImportTransfer>();
  const [filesRefresh, setFilesRefresh] = useState(0);
  const [filesListing, setFilesListing] = useState<FilesListing>();
  const refreshing = useRef(false);
  const actionGeneration = useRef(0);
  const actionInFlight = useRef(false);
  const expertsGeneration = useRef(0);
  const desktopGeneration = useRef(0);
  const transferPending = useRef(false);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const desktopPanelRef = useRef<HTMLElement>(null);

  const logLines = useMemo(
    () => {
      const occurrences = new Map<string, number>();
      return status.logs.slice(-120).map((raw) => {
        const occurrence = occurrences.get(raw) ?? 0;
        occurrences.set(raw, occurrence + 1);
        return { ...parseLog(raw), key: `${raw}:${occurrence}` };
      }).reverse();
    },
    [status.logs],
  );

  useEffect(() => {
    if (drawer) document.getElementById(`heading-${drawer}`)?.focus();
  }, [drawer]);

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current || actionInFlight.current) return;
    refreshing.current = true;
    const generation = actionGeneration.current;
    try {
      const response = await fetch("/api/status", { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Status request failed with HTTP ${response.status}.`);
      }
      const nextStatus = (await response.json()) as Mt5Status;
      if (generation === actionGeneration.current) {
        setHasStatus(true);
        setOffline(false);
        setStatus((previous) => {
          if (JSON.stringify(previous) === JSON.stringify(nextStatus)) return previous;
          if (previous.logs.length === nextStatus.logs.length && previous.logs.every((line, index) => line === nextStatus.logs[index])) nextStatus.logs = previous.logs;
          return nextStatus;
        });
      }
    } catch (refreshError) {
      if (generation === actionGeneration.current) setOffline(true);
      throw refreshError;
    } finally { refreshing.current = false; }
  }, []);

  const loadDesktopConfig = useCallback(async () => {
    const generation = ++desktopGeneration.current;
    try {
      const response = await fetch("/api/runtime-config", { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load desktop configuration.");
      const config = await response.json() as RuntimeConfig;
      if (!/^https?:\/\//i.test(config.noVncUrl)) throw new Error("Invalid desktop URL.");
      if (generation !== desktopGeneration.current) return;
      setRuntimeConfig(config);
      setDesktopError(undefined);
    } catch (error) { if (generation === desktopGeneration.current) setDesktopError(error instanceof Error ? error.message : "Desktop configuration failed."); }
  }, []);

  async function refreshExperts(): Promise<void> {
    const generation = ++expertsGeneration.current;
    const response = await fetch("/api/mt5/experts", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return;
    }
    const next = await response.json() as ExpertsInfo;
    if (generation === expertsGeneration.current) setExpertsInfo(next);
  }

  useEffect(() => {
    let disposed = false;
    let ticking = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (disposed || ticking) return;
      ticking = true;
      if (!document.hidden) await refresh().catch(() => undefined);
      ticking = false;
      if (!disposed) timer = setTimeout(() => void tick(), 2500);
    };
    const visibility = () => {
      if (!document.hidden) { clearTimeout(timer); void tick(); }
    };
    void tick();
    void loadDesktopConfig();
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [refresh, loadDesktopConfig]);

  useEffect(() => {
    // The Experts directory is created by the terminal on first launch, so
    // refresh on runtime transitions too, not only when `installed` flips.
    if (status.installed) {
      void refreshExperts().catch(() => undefined);
    }
  }, [status.installed, status.mt5]);

  useEffect(() => {
    const updateFullscreen = () => {
      const active = document.fullscreenElement === desktopPanelRef.current;
      setNativeFullscreen(active);
      if (active) setExpandedDesktop(false);
    };
    const exitExpandedOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && expandedDesktop && !document.fullscreenElement) {
        setExpandedDesktop(false);
        setFullscreenMessage(undefined);
      }
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    document.addEventListener("keydown", exitExpandedOnEscape);
    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreen);
      document.removeEventListener("keydown", exitExpandedOnEscape);
    };
  }, [expandedDesktop]);

  async function runAction(action: PendingAction, request: () => Promise<Mt5Status>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(action);
    actionGeneration.current += 1;
    setError(undefined);
    try {
      setStatus(await request());
      setHasStatus(true);
      setOffline(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
    } finally {
      actionGeneration.current += 1;
      actionInFlight.current = false;
      setPending(undefined);
      void refresh().catch(() => undefined);
    }
  }

  function handleReloadDesktop(): void {
    setDesktopKey((key) => key + 1);
    void loadDesktopConfig();
  }

  async function toggleFullscreen() {
    const panel = desktopPanelRef.current;
    if (document.fullscreenElement === panel) {
      await document.exitFullscreen().catch(() => setFullscreenMessage("Unable to exit browser fullscreen. Press Escape to leave it."));
      return;
    }
    if (expandedDesktop) {
      setExpandedDesktop(false);
      setFullscreenMessage(undefined);
      return;
    }
    setFullscreenMessage(undefined);
    if (!panel?.requestFullscreen) {
      setExpandedDesktop(true);
      setFullscreenMessage("Native fullscreen is unavailable. Showing the expanded desktop view.");
      return;
    }
    try {
      await panel.requestFullscreen();
    } catch {
      setExpandedDesktop(true);
      setFullscreenMessage("Native fullscreen was unavailable or denied. Showing the expanded desktop view.");
    }
  }

  function leaveFullscreenForTool() {
    setFullscreenMessage(undefined);
    if (document.fullscreenElement === desktopPanelRef.current) {
      void document.exitFullscreen().catch(() => setFullscreenMessage("Unable to leave browser fullscreen."));
    }
    setExpandedDesktop(false);
  }

  async function handleExpertsUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (transferBlocked) { setUploadMessage(transferBlocked); return; }
    const input = event.currentTarget.elements.namedItem("files") as HTMLInputElement;
    if (!input.files?.length) {
      setUploadMessage("Choose one or more EA files first.");
      return;
    }

    const form = new FormData();
    for (const file of input.files) {
      form.append("files", file);
    }

    setUploadingExperts(true);
    expertsGeneration.current += 1;
    setUploadMessage(undefined);
    try {
      const response = await fetch("/api/mt5/experts", {
        body: form,
        headers: actionHeaders,
        method: "POST",
      });
      const data = (await response.json()) as ExpertsInfo | { error?: string };
      if (!response.ok) {
        throw new Error("error" in data && data.error ? data.error : "Upload failed.");
      }
      const nextExpertsInfo = data as ExpertsInfo;
      expertsGeneration.current += 1;
      setExpertsInfo(nextExpertsInfo);
      setFilesRefresh((value) => value + 1);
      setUploadMessage(`Uploaded ${nextExpertsInfo.uploaded?.join(", ") ?? "EA files"}.`);
      input.value = "";
    } catch (uploadError) {
      setUploadMessage(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUploadingExperts(false);
    }
  }

  const transitioning =
    status.mt5 === "launching" || status.mt5 === "stopping";
  const busy = Boolean(pending) || transitioning || status.installerRunning || status.mt5 === "installing";
  const unavailable = !hasStatus || offline;
  const commandBusy = busy || unavailable || importState.busy || Boolean(transfer) || uploadingExperts;
  const canInstall =
    status.desktop === "ready" &&
    !status.installed &&
    !status.installerRunning &&
    status.mt5 !== "installing" &&
    !commandBusy;
  const canLaunch = status.installed && status.mt5 !== "running" && !commandBusy && importState.ready && !importState.recoveryRequired;
  const canStop = status.mt5 === "running" && !commandBusy;
  const canRestart = status.installed && !commandBusy && importState.ready && !importState.recoveryRequired;
  const transferBlocked = !importState.ready ? "Checking transfer status. Open Files > Transfers to retry if this persists." : importState.active ? "An import is already staged. Review or cancel it before starting another transfer." : importState.recoveryRequired ? "Recover the interrupted import before transferring files." : importState.busy || transfer ? "An import operation is in progress." : busy || uploadingExperts ? "Wait for the current terminal or upload operation." : unavailable || !status.installed ? "The installed terminal and control server must be available." : undefined;
  const expertLabel = (!hasStatus ? "Awaiting status" : status.expert?.state === "loaded" ? "Attachment recorded" : status.expert?.state === "removed" ? "Detached" : status.expert?.state === "failed" ? "Initialisation failed" : "Unverified") + (offline ? " (stale)" : "");
  const expertTone = offline ? "neutral" : status.expert?.state === "failed" ? "bad" : status.expert?.state === "removed" ? "warn" : status.expert?.state === "loaded" ? "good" : "neutral";
  const terminalLabel = (!hasStatus ? "Awaiting status" : stateLabel(status)) + (offline ? " (stale)" : "");
  const terminalTone = offline || !hasStatus ? "neutral" : status.mt5 === "failed" ? "bad" : status.mt5 === "running" ? "good" : busy ? "warn" : "neutral";

  function openDrawer(next: Drawer | "evidence" | "import" | "paths") {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest(".drawer")) drawerTrigger.current = document.activeElement;
    leaveFullscreenForTool();
    if (next === "import") {
      setFilesTab("transfers");
      setDrawer("files");
    } else if (next === "evidence" || next === "paths") {
      setDrawer("diagnostics");
    } else {
      setDrawer(next);
    }
  }
  function closeDrawer() { setDrawer(undefined); drawerTrigger.current?.focus(); }
  function openTransfers() { openDrawer("import"); }
  const transferHandler = useRef<(files: SelectedImportFile[], destination: string) => boolean>(() => false);
  const transferSequence = useRef(0);
  transferHandler.current = (files, destination) => {
    if (transferBlocked || transferPending.current) { setError(transferBlocked ?? "A transfer is already pending."); openTransfers(); return false; }
    transferPending.current = true;
    setTransfer({ id: `transfer-${Date.now()}-${++transferSequence.current}`, files, destination });
    openTransfers();
    return true;
  };
  const queueTransfer = useCallback((files: SelectedImportFile[], destination: string) => transferHandler.current(files, destination), []);
  const consumeTransfer = useCallback((id: string) => {
    transferPending.current = false;
    setTransfer((previous) => previous?.id === id ? undefined : previous);
  }, []);
  function importApplied() {
    void refresh().catch(() => undefined);
    void refreshExperts().catch(() => undefined);
    setFilesRefresh((value) => value + 1);
  }

  const hasActiveError = offline || Boolean(error || status.lastError || status.expert?.lastError || status.expert?.state === "removed" || status.expert?.state === "failed" || importState.recoveryRequired);
  const errorMessage = offline
    ? "Control server unreachable. Displayed status is stale; terminal commands are disabled."
    : error ?? (importState.recoveryRequired ? "An interrupted import needs recovery before MT5 can launch." : status.lastError ?? status.expert?.lastError ?? (status.expert?.state === "removed" ? "EA detached. Review the journal evidence, then acknowledge if removal was deliberate." : "EA initialisation failure recorded. Review the journal evidence."));
  const warningMessage = !offline && !error && status.mt5 !== "failed" && status.expert?.state === "removed";
  function renderErrorBanner() {
    if (!hasActiveError) return null;
    return <section className={`error-strip${warningMessage ? " warning-strip" : ""}`} role="alert">
      <Activity size={17} aria-hidden="true" />
      <span>{errorMessage}</span>
      <button type="button" onClick={() => openDrawer(importState.recoveryRequired ? "import" : "evidence")}>{importState.recoveryRequired ? "Open transfers" : "View diagnostics"}</button>
      {error && <button className="icon-button" type="button" aria-label="Dismiss action error" onClick={() => setError(undefined)}><X size={15} /></button>}
    </section>;
  }

  return (
    <main className={`shell${expandedDesktop ? " expanded-desktop" : ""}`}>
      <header className="command-bar">
        <div className="brand-block"><div className="brand-mark"><Terminal size={18} aria-hidden="true" /></div><div><h1>Linux MT5</h1><p>Control Room</p></div></div>
        <div className="state-block" role="group" aria-label="Terminal and EA runtime signals">
          <StatusPill label="Terminal process" value={terminalLabel} tone={terminalTone} onClick={() => openDrawer("diagnostics")} />
          <StatusPill label="EA journal" value={expertLabel} tone={expertTone} onClick={() => openDrawer("diagnostics")} />
        </div>
        <div className="command-actions" aria-label="Terminal controls">
          {hasStatus && !status.installed ? <ActionButton disabled={!canInstall} icon={<Download size={16} />} label="Install" onClick={() => void runAction("install", () => postJson<Mt5Status>("/api/mt5/install"))} pending={pending === "install"} /> : status.mt5 === "running" || status.mt5 === "stopping" ? <ActionButton danger disabled={!canStop} icon={<Square size={15} />} label="Stop" onClick={() => setConfirmAction("stop")} pending={pending === "stop"} /> : <ActionButton disabled={!canLaunch} icon={<Play size={16} />} label="Launch" onClick={() => void runAction("launch", () => postJson<Mt5Status>("/api/mt5/launch"))} pending={pending === "launch"} />}
          <ActionButton disabled={!canRestart} icon={<RotateCcw size={16} />} label="Restart" onClick={() => setConfirmAction("restart")} pending={pending === "restart"} />
        </div>
      </header>

      {!nativeFullscreen && renderErrorBanner()}

      <div className="workspace">
        <nav className="workspace-nav" aria-label="Workspace">
          <div className="primary-nav">
            <button type="button" className="nav-button" aria-current={!drawer || drawer === "clipboard" ? "page" : undefined} aria-controls="desktop-content" onClick={() => setDrawer(undefined)}><Monitor size={17} aria-hidden="true" /><span>Desktop</span></button>
            <button type="button" className="nav-button" aria-current={drawer === "files" ? "page" : undefined} aria-controls="drawer-files" aria-expanded={drawer === "files"} aria-label={`Files${importState.active || importState.recoveryRequired || transfer ? " (transfers need attention)" : ""}`} onClick={() => openDrawer("files")}><Folder size={17} aria-hidden="true" /><span>Files</span>{(importState.active || importState.recoveryRequired || transfer) && <i className="nav-badge" aria-hidden="true" />}</button>
            <button type="button" className="nav-button" aria-current={drawer === "session" ? "page" : undefined} aria-controls="drawer-session" aria-expanded={drawer === "session"} onClick={() => openDrawer("session")}><ShieldCheck size={17} aria-hidden="true" /><span>Session</span></button>
          </div>
          <div className="secondary-nav"><button type="button" className="nav-secondary-button" aria-pressed={drawer === "diagnostics"} aria-controls="drawer-diagnostics" aria-expanded={drawer === "diagnostics"} onClick={() => openDrawer("diagnostics")}><Activity size={15} aria-hidden="true" />Diagnostics</button></div>
        </nav>

        <div className={`stage${drawer ? " with-drawer" : ""}`}>
          <div className="desktop-column">
            <section ref={desktopPanelRef} className="desktop-panel" id="desktop-content" aria-label="MT5 desktop">
              {nativeFullscreen && renderErrorBanner()}
              <header className="desktop-toolbar">
                <h2><Monitor size={16} aria-hidden="true" />MT5 desktop <small>noVNC</small></h2>
                <div className="button-row desktop-tools">
                  <button type="button" onClick={() => openDrawer("clipboard")} aria-controls="drawer-clipboard"><Clipboard size={15} aria-hidden="true" />Clipboard</button>
                  <button type="button" onClick={handleReloadDesktop}><RefreshCcw size={15} aria-hidden="true" />Reload view</button>
                  {runtimeConfig && <a className="button" href={runtimeConfig.noVncUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} aria-hidden="true" />New tab<span className="sr-only">: open noVNC</span></a>}
                  <button type="button" aria-pressed={nativeFullscreen || expandedDesktop} onClick={() => void toggleFullscreen()}>{nativeFullscreen || expandedDesktop ? <Minimize size={15} aria-hidden="true" /> : <Maximize size={15} aria-hidden="true" />}{nativeFullscreen ? "Exit full screen" : expandedDesktop ? "Exit expanded view" : "Full screen"}</button>
                </div>
              </header>
              {fullscreenMessage && <p className="fullscreen-message" role="status">{fullscreenMessage}</p>}
              <div className="desktop-surface">
                {runtimeConfig ? <iframe key={desktopKey} className="desktop-frame" src={runtimeConfig.noVncUrl} title="Linux MT5 noVNC desktop" allowFullScreen /> : <div className="desktop-placeholder" role="status"><Monitor size={30} aria-hidden="true" /><p>{desktopError ?? "Loading desktop configuration…"}</p>{desktopError && <button type="button" onClick={() => void loadDesktopConfig()}>Retry desktop connection</button>}</div>}
              </div>
              <footer className="desktop-footer"><span><i className={`led ${offline ? "neutral" : status.desktop === "failed" ? "bad" : "neutral"}`} aria-hidden="true" />Desktop service: {hasStatus ? `${status.desktop}${offline ? " (stale)" : ""}` : "awaiting status"}</span><span>Connection controls and scaling are inside noVNC.</span></footer>
            </section>
            <section className="activity-tray" aria-label="Runtime activity">
              <button type="button" className="activity-toggle" aria-expanded={activityOpen} aria-controls="runtime-log" onClick={() => setActivityOpen((value) => !value)}><ChevronDown size={16} aria-hidden="true" /><strong>Activity</strong><span className="count">{logLines.length}</span><span className="last-event">{logLines[0]?.message ?? "Waiting for container events."}</span></button>
              <div id="runtime-log" className="log-list" hidden={!activityOpen} tabIndex={0} aria-label="Runtime log">
                {logLines.length ? logLines.map((line) => <p className={`log-line log-${line.tone}`} key={line.key}><time>{line.time}</time><span>{line.message}</span></p>) : <p className="log-empty">Waiting for container events.</p>}
              </div>
            </section>
          </div>

          <aside className="drawer" hidden={!drawer} aria-label="Workspace tools">
            <DrawerSection name="diagnostics" title="Diagnostics" description="Runtime evidence and technical paths for support." active={drawer} onClose={closeDrawer}>
              <details className="diagnostic-details">
                <summary>Runtime evidence</summary>
                <div className="panel-section">
                  <div className="evidence-card"><i className={`led ${terminalTone}`} aria-hidden="true" /><div><h3>Terminal process · {terminalLabel}</h3><small>Source: supervisor process check{offline ? " (stale)" : ""}</small><p>Whether the MT5 process is running under Wine. This does not establish EA or broker health.</p></div></div>
                  <div className="evidence-card"><i className={`led ${expertTone}`} aria-hidden="true" /><div><h3>EA journal · {expertLabel}</h3><small>{status.expert ? `Source: MT5 journal for ${status.expert.name}${offline ? " (stale)" : ""}` : "No configured EA journal evidence reported"}</small><p>{status.expert?.state === "loaded" ? "MT5 recorded an attachment. This does not prove initialisation, trading or ongoing liveness." : status.expert?.state === "removed" ? "MT5 recorded an EA removal. Acknowledge only if the detach was deliberate." : status.expert?.state === "failed" ? "MT5 recorded an initialisation failure. Acknowledging a removal cannot clear this failure." : "No verified attachment or failure evidence is available."}</p>{status.expert?.lastError && <p className={status.expert.state === "removed" ? "warning-text" : "error-text"}>{status.expert.lastError}</p>}
                    {status.expert?.state === "removed" && <button type="button" className="secondary-button" disabled={commandBusy} onClick={() => void runAction("acknowledge", () => postJson<Mt5Status>("/api/mt5/expert/acknowledge-removals"))}>{pending === "acknowledge" ? "Acknowledging…" : "Acknowledge deliberate removal"}</button>}
                  </div></div>
                  <div className="evidence-card"><i className="led neutral" aria-hidden="true" /><div><h3>Heartbeat · Unverified</h3><small>No heartbeat integration</small><p>EA heartbeat, broker connectivity and account health are not verified by this control surface. Attachment evidence is not a heartbeat.</p></div></div>
                  {!importState.ready && <p className="note">Import status is not available yet. Launch and Restart wait for recovery checks. <button type="button" onClick={openTransfers}>Open Files transfers</button></p>}
                  {status.lastError && <p className="note error-text">{status.lastError}</p>}
                </div>
              </details>
              <details className="diagnostic-details">
                <summary>Technical paths and installer files</summary>
                <dl className="details">
                  {[ ["Data volume", status.paths.dataDir], ["Wine prefix", status.paths.winePrefix], ["Terminal", status.paths.mt5ExecutablePath], ["MT5 data folder", filesListing?.root], ["Windows data folder", filesListing?.windowsRoot], ["EA upload target", expertsInfo?.expertsDir], ["Installer cache", status.paths.cacheDir], ["MT5 installer", status.paths.mt5InstallerPath], ["WebView2 installer", status.paths.webviewInstallerPath]].map(([label, path]) => <div key={label}><dt>{label}</dt><dd>{path ? <code>{path}</code> : "Not reported"}</dd></div>)}
                </dl>
                <p className="upload-note">Open Files to resolve the active data-folder paths. Paths can be selected and copied with Ctrl/Cmd+C.</p>
                <p className="upload-note">MT5 setup: {hasStatus ? status.installerFiles.mt5Setup ? "cached" : "missing" : "not reported"}. WebView2 setup: {hasStatus ? status.installerFiles.webviewSetup ? "cached" : "missing" : "not reported"}.</p>
              </details>
            </DrawerSection>

            <DrawerSection name="files" title="Files" description="Browse MT5 files or review staged transfers." active={drawer} onClose={closeDrawer}>
              <div className="files-tabs" role="tablist" aria-label="Files">
                <button id="files-browse-tab" type="button" role="tab" aria-selected={filesTab === "browse"} aria-controls="files-browse-panel" tabIndex={filesTab === "browse" ? 0 : -1} onClick={() => setFilesTab("browse")} onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "browse" : event.key === "End" ? "transfers" : filesTab === "browse" ? "transfers" : "browse";
                  setFilesTab(next);
                  document.getElementById(`files-${next}-tab`)?.focus();
                }}>Browse</button>
                <button id="files-transfers-tab" type="button" role="tab" aria-selected={filesTab === "transfers"} aria-controls="files-transfers-panel" aria-label={`Transfers${importState.active || importState.recoveryRequired || transfer ? ", items need attention" : ""}`} tabIndex={filesTab === "transfers" ? 0 : -1} onClick={() => setFilesTab("transfers")} onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const next = event.key === "Home" ? "browse" : event.key === "End" ? "transfers" : filesTab === "browse" ? "transfers" : "browse";
                  setFilesTab(next);
                  document.getElementById(`files-${next}-tab`)?.focus();
                }}>Transfers{(importState.active || importState.recoveryRequired || transfer) && <i className="nav-badge" aria-hidden="true" />}</button>
              </div>
              <section id="files-browse-panel" className="files-tab-panel" role="tabpanel" aria-labelledby="files-browse-tab" tabIndex={0} hidden={filesTab !== "browse"}>
              <FilesPanel active={drawer === "files" && filesTab === "browse"} offline={offline} transferBlocked={transferBlocked} refreshKey={filesRefresh} onTransfer={queueTransfer} onReview={openTransfers} onListing={setFilesListing} />
              <details className="quick-upload"><summary>Quick EA upload · extension-based routing</summary>
                <form className="panel-section" encType="multipart/form-data" onSubmit={handleExpertsUpload}>
                  <h3>Quick EA upload</h3>
                  <p className="upload-note">This uses fixed routes, independent of the destination browser: .ex5 / .mq5 → Experts, .set → Presets, .mqh → Include, .dll → Libraries. It writes immediately and may replace existing files. Use destination staging above for conflict review and backups.</p>
                  <label>EA files<input className="file-input" disabled={Boolean(transferBlocked)} multiple name="files" type="file" accept=".ex5,.mq5,.mqh,.set,.dll" /></label>
                  <button className="secondary-button" disabled={Boolean(transferBlocked)} type="submit"><Upload size={16} aria-hidden="true" />{uploadingExperts ? "Uploading…" : "Upload EA now"}</button>
                  {expertsInfo && <p className="upload-note">Experts target: <code>{expertsInfo.expertsDir}</code></p>}
                  {uploadMessage && <p className="note" role="status">{uploadMessage}</p>}
                  {expertsInfo?.files.length ? <ul className="file-list">{expertsInfo.files.slice(0, 8).map((file) => <li key={file}>{file}</li>)}</ul> : null}
                  <p className="upload-note">No EA is compiled or attached. Right-click Expert Advisors in MT5’s Navigator and choose Refresh to discover new files. This does not reinitialise an EA already attached to a chart.</p>
                </form>
              </details>
              </section>
              <section id="files-transfers-panel" className="files-tab-panel" role="tabpanel" aria-labelledby="files-transfers-tab" tabIndex={0} hidden={filesTab !== "transfers"}>
                <DataImportPanel stopped={hasStatus && (status.mt5 === "idle" || status.mt5 === "failed")} disabled={busy || unavailable || !status.installed || uploadingExperts} onApplied={importApplied} transfer={transfer} onTransferConsumed={consumeTransfer} onStateChange={setImportState} refreshKey={`${offline}:${status.mt5}:${drawer === "files" && filesTab === "transfers"}`} />
              </section>
            </DrawerSection>

            <DrawerSection name="clipboard" title="Text clipboard" description="Move text between your device and the MT5 desktop." active={drawer} onClose={closeDrawer}><ClipboardPanel offline={offline} /></DrawerSection>

            <DrawerSection name="session" title="Startup" description="Choose what MT5 should open on its next launch." active={drawer} onClose={closeDrawer}>
              <StartupPanel offline={offline} activeMode={status.mt5 === "running" ? status.sessionMode : undefined} active={drawer === "session"} refreshKey={`${filesRefresh}:${status.installed}:${status.mt5}`} />
            </DrawerSection>

          </aside>
        </div>
      </div>

      {confirmAction && <ConfirmDialog title={confirmAction === "stop" ? "Stop the terminal?" : "Restart the terminal?"} confirmLabel={confirmAction === "stop" ? "Stop terminal" : "Restart terminal"} disabled={confirmAction === "stop" ? !canStop : !canRestart} onCancel={() => setConfirmAction(undefined)} onConfirm={() => {
        const action = confirmAction;
        setConfirmAction(undefined);
        void runAction(action, () => postJson<Mt5Status>(`/api/mt5/${action}`));
      }}><p>{confirmAction === "stop" ? "Running EAs stop until you launch MT5 again. The Linux desktop stays available." : "Running EAs stop while MT5 closes and starts again. Check their attachment after launch."}</p><p>MT5 is asked to close gracefully so it can save account and chart state. {confirmAction === "restart" && "The startup choice saved in Session will be used on launch."}</p></ConfirmDialog>}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
