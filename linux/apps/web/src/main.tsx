import {
  Activity,
  Download,
  Monitor,
  Play,
  RefreshCcw,
  RotateCcw,
  Square,
  Terminal,
  Upload,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

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

type PendingAction = "install" | "launch" | "stop" | "restart";

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
    dataDir: "/data",
    cacheDir: "/data/cache",
    winePrefix: "/data/wine-prefix/.mt5",
    mt5InstallerPath: "/data/cache/mt5setup.exe",
    webviewInstallerPath: "/data/cache/webview2.exe",
  },
  logs: [],
};

const fallbackRuntimeConfig: RuntimeConfig = {
  noVncUrl:
    "http://localhost:6080/vnc.html?autoconnect=1&resize=scale&path=websockify",
};

async function postJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "POST" });
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
  return data as T;
}

function stateLabel(status: Mt5Status): string {
  if (status.mt5 === "running") {
    return "MT5 RUNNING";
  }
  if (status.installerRunning || status.mt5 === "installing") {
    return "INSTALLER ACTIVE";
  }
  if (status.installed) {
    return "MT5 INSTALLED";
  }
  if (status.mt5 === "failed") {
    return "ATTENTION";
  }
  return "STARTING";
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

  return {
    time: match?.groups?.iso
      ? new Date(match.groups.iso).toLocaleTimeString("en-GB")
      : "--:--:--",
    message,
    tone,
  };
}

function StatusPill({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <div className={`status-pill status-pill-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  pending,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="action-button"
      disabled={disabled || pending}
      onClick={onClick}
      type="button"
    >
      {pending ? <RefreshCcw className="spin" size={17} /> : icon}
      <span>{label}</span>
    </button>
  );
}

function App() {
  const [status, setStatus] = useState<Mt5Status>(emptyStatus);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(
    fallbackRuntimeConfig,
  );
  const [pending, setPending] = useState<PendingAction>();
  const [error, setError] = useState<string>();
  const [expertsInfo, setExpertsInfo] = useState<ExpertsInfo>();
  const [uploadingExperts, setUploadingExperts] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string>();
  const [desktopKey, setDesktopKey] = useState(0);

  const logLines = useMemo(
    () => status.logs.slice(-120).map(parseLog).reverse(),
    [status.logs],
  );

  async function refresh(): Promise<void> {
    const response = await fetch("/api/status");
    if (!response.ok) {
      throw new Error(`Status request failed with HTTP ${response.status}.`);
    }
    const nextStatus = (await response.json()) as Mt5Status;
    setStatus(nextStatus);
  }

  async function refreshExperts(): Promise<void> {
    const response = await fetch("/api/mt5/experts");
    if (!response.ok) {
      return;
    }
    setExpertsInfo((await response.json()) as ExpertsInfo);
  }

  useEffect(() => {
    void refresh().catch((refreshError) =>
      setError(refreshError instanceof Error ? refreshError.message : "Refresh failed."),
    );
    void fetch("/api/runtime-config")
      .then((response) => response.json())
      .then((config: RuntimeConfig) => setRuntimeConfig(config))
      .catch(() => undefined);

    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (status.installed) {
      void refreshExperts().catch(() => undefined);
    }
  }, [status.installed]);

  async function runAction(action: PendingAction, request: () => Promise<Mt5Status>) {
    setPending(action);
    setError(undefined);
    try {
      setStatus(await request());
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
      await refresh().catch(() => undefined);
    } finally {
      setPending(undefined);
    }
  }

  function handleReloadDesktop(event: FormEvent): void {
    event.preventDefault();
    setDesktopKey((key) => key + 1);
  }

  async function handleExpertsUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    setUploadMessage(undefined);
    try {
      const response = await fetch("/api/mt5/experts", {
        body: form,
        method: "POST",
      });
      const data = (await response.json()) as ExpertsInfo | { error?: string };
      if (!response.ok) {
        throw new Error("error" in data && data.error ? data.error : "Upload failed.");
      }
      const nextExpertsInfo = data as ExpertsInfo;
      setExpertsInfo(nextExpertsInfo);
      setUploadMessage(`Uploaded ${nextExpertsInfo.uploaded?.join(", ") ?? "EA files"}.`);
      input.value = "";
    } catch (uploadError) {
      setUploadMessage(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setUploadingExperts(false);
    }
  }

  const canInstall =
    status.desktop === "ready" &&
    !status.installed &&
    !status.installerRunning &&
    status.mt5 !== "installing";
  const canLaunch = status.installed && status.mt5 !== "running";
  const canStop = status.mt5 === "running" || status.mt5 === "launching";

  return (
    <main className="shell">
      <section className="topbar">
        <div className="brand-block">
          <div className="brand-mark">
            <Terminal size={22} />
          </div>
          <div>
            <h1>Linux MT5</h1>
          </div>
        </div>

        <div className="state-block">
          <StatusPill label="DESKTOP" value={status.desktop.toUpperCase()} />
          <StatusPill
            label="STATE"
            tone={status.mt5 === "failed" ? "bad" : status.installed ? "good" : "warn"}
            value={stateLabel(status)}
          />
        </div>
      </section>

      {error || status.lastError ? (
        <section className="error-strip">
          <Activity size={17} />
          <span>{error ?? status.lastError}</span>
        </section>
      ) : null}

      <section className="workspace">
        <aside className="control-panel">
          <div className="panel-section">
            <h2>Controls</h2>
            <div className="button-grid">
              <ActionButton
                disabled={!canInstall}
                icon={<Download size={17} />}
                label="Install"
                onClick={() =>
                  void runAction("install", () =>
                    postJson<Mt5Status>("/api/mt5/install"),
                  )
                }
                pending={pending === "install"}
              />
              <ActionButton
                disabled={!canLaunch}
                icon={<Play size={17} />}
                label="Launch"
                onClick={() =>
                  void runAction("launch", () =>
                    postJson<Mt5Status>("/api/mt5/launch"),
                  )
                }
                pending={pending === "launch"}
              />
              <ActionButton
                disabled={!status.installed}
                icon={<RotateCcw size={17} />}
                label="Restart"
                onClick={() =>
                  void runAction("restart", () =>
                    postJson<Mt5Status>("/api/mt5/restart"),
                  )
                }
                pending={pending === "restart"}
              />
              <ActionButton
                disabled={!canStop}
                icon={<Square size={17} />}
                label="Stop"
                onClick={() =>
                  void runAction("stop", () => postJson<Mt5Status>("/api/mt5/stop"))
                }
                pending={pending === "stop"}
              />
            </div>
          </div>

          <div className="panel-section">
            <h2>Runtime</h2>
            <dl className="details">
              <div>
                <dt>Wine prefix</dt>
                <dd>{status.paths.winePrefix}</dd>
              </div>
              <div>
                <dt>MT5 setup</dt>
                <dd>{status.installerFiles.mt5Setup ? "cached" : "missing"}</dd>
              </div>
              <div>
                <dt>Terminal</dt>
                <dd>{status.paths.mt5ExecutablePath ?? "not detected"}</dd>
              </div>
            </dl>
          </div>

          <form className="panel-section" encType="multipart/form-data" onSubmit={handleExpertsUpload}>
            <h2>Expert Advisors</h2>
            <p className="upload-note">
              Upload .ex5, .mq5, .mqh, .set, or .dll files into MT5's MQL5/Experts directory.
            </p>
            <input
              className="file-input"
              disabled={!status.installed || uploadingExperts}
              multiple
              name="files"
              type="file"
            />
            <button
              className="secondary-button"
              disabled={!status.installed || uploadingExperts}
              type="submit"
            >
              <Upload size={17} />
              <span>{uploadingExperts ? "Uploading" : "Upload EA"}</span>
            </button>
            {expertsInfo ? (
              <p className="upload-note">Target: {expertsInfo.expertsDir}</p>
            ) : null}
            {uploadMessage ? <p className="upload-note">{uploadMessage}</p> : null}
            {expertsInfo?.files.length ? (
              <ul className="file-list">
                {expertsInfo.files.slice(0, 8).map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            ) : null}
          </form>

          <form className="panel-section" onSubmit={handleReloadDesktop}>
            <h2>Desktop</h2>
            <button className="secondary-button" type="submit">
              <Monitor size={17} />
              <span>Reload View</span>
            </button>
          </form>
        </aside>

        <section className="desktop-panel">
          <iframe
            key={desktopKey}
            className="desktop-frame"
            src={runtimeConfig.noVncUrl}
            title="Linux MT5 noVNC desktop"
          />
        </section>
      </section>

      <section className="log-dock">
        <header>
          <h2>Runtime Log</h2>
          <span>{logLines.length} lines</span>
        </header>
        <div className="log-list">
          {logLines.length > 0 ? (
            logLines.map((line, index) => (
              <p className={`log-line log-${line.tone}`} key={`${line.time}-${index}`}>
                <time>{line.time}</time>
                <span>{line.message}</span>
              </p>
            ))
          ) : (
            <p className="log-empty">Waiting for container events.</p>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
