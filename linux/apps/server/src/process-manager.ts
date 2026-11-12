import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { spawn, type Subprocess } from "bun";
import {
  createInitialMt5Status,
  redactPathsForStatus,
  type Mt5ProcessState,
  type Mt5Status,
  type RuntimePaths,
} from "@linux-mt5/shared";
import {
  buildMt5InstallerCommand,
  buildMt5LaunchCommand,
  buildMt5ProcessCheckCommand,
  buildWineAntiDebugCommand,
  buildWineAudioDriverCommand,
  buildWineKillCommand,
  buildWineShutdownCommand,
  buildWebViewInstallCommand,
  buildWineBootCommand,
  buildWineEnv,
  buildWineWindowsVersionCommand,
} from "./command-builder";
import { findMt5Executable, findMt5ExpertsDirectory, findMt5TerminalDataRoot, getRuntimePaths } from "./paths";
import { ExpertLogMonitor } from "./expert-health";
import { DataImportStore, type ImportOptions } from "./data-import";
import { listTerminalFiles } from "./terminal-files";
import {
  mt5StartupConfigFromEnv,
  writeMt5StartupFiles,
  writeMt5RestoreFile,
  type Mt5StartupConfig,
} from "./mt5-startup-config";

const defaultMt5Url =
  "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe";
const defaultWebViewUrl =
  "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/f2910a1e-e5a6-4f17-b52d-7faf525d17f8/MicrosoftEdgeWebview2Setup.exe";

export const DEFAULT_WINE_BOOT_TIMEOUT_MS = 900_000;
export const DEFAULT_WINECFG_TIMEOUT_MS = 180_000;
export const DEFAULT_WEBVIEW_TIMEOUT_MS = 600_000;
export const DEFAULT_MT5_STOP_TIMEOUT_MS = 20_000;
export const DEFAULT_RECONCILE_INTERVAL_MS = 10_000;

type ManagedProcess = {
  name: string;
  process: Subprocess;
  intentionalStop?: boolean;
};

type ManagerOptions = {
  paths?: RuntimePaths;
  display?: string;
  pulseServer?: string;
  autoLaunch?: boolean;
  autoInstall?: boolean;
  installWebView?: boolean;
  mt5InstallerUrl?: string;
  webViewInstallerUrl?: string;
};

export type ExpertsDirectoryInfo = {
  expertsDir: string;
  files: string[];
};

export type ExpertUploadResult = ExpertsDirectoryInfo & {
  uploaded: string[];
};

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

export function readTimeoutMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Delays allow 0 (launch immediately), unlike timeouts where 0 means unset.
function readDelayMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// MT5 only looks for presets in MQL5/Presets, DLLs in MQL5/Libraries, and
// includes in MQL5/Include. Everything else (source/compiled experts) belongs
// in MQL5/Experts.
export function uploadTargetDirectory(expertsDir: string, filename: string): string {
  const mql5Root = dirname(expertsDir);
  switch (extname(filename).toLowerCase()) {
    case ".set":
      return join(mql5Root, "Presets");
    case ".dll":
      return join(mql5Root, "Libraries");
    case ".mqh":
      return join(mql5Root, "Include");
    default:
      return expertsDir;
  }
}

async function waitForExit(child: Subprocess, timeoutMs: number): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hasFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

export class Mt5ProcessManager {
  private readonly paths: RuntimePaths;
  private readonly display: string;
  private readonly pulseServer?: string;
  private readonly autoLaunch: boolean;
  private readonly autoInstall: boolean;
  private readonly installWebView: boolean;
  private readonly mt5InstallerUrl: string;
  private readonly webViewInstallerUrl: string;
  private readonly startupConfig: Mt5StartupConfig;
  private readonly wineBootTimeoutMs: number;
  private readonly wineCfgTimeoutMs: number;
  private readonly webViewTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly logs: string[] = [];
  private lifecyclePromise: Promise<void> = Promise.resolve();
  private mt5State: Mt5ProcessState = "idle";
  private lastError?: string;
  private installPromise?: Promise<void>;
  private startupApplied = false;
  private reconciling = false;
  private reconcileFailure = false;
  private lifecycleGeneration = 0;
  private expertMonitor?: ExpertLogMonitor;
  private readonly imports: DataImportStore;
  private readonly sessionMode: "restore" | "managed";
  private importApplying = false;

  constructor(options: ManagerOptions = {}) {
    this.paths = options.paths ?? getRuntimePaths();
    this.imports = new DataImportStore(this.paths.dataDir);
    const mode = process.env.MT5_SESSION_MODE ?? "restore";
    if (mode !== "restore" && mode !== "managed") throw new Error("MT5_SESSION_MODE must be restore or managed.");
    this.sessionMode = mode;
    this.display = options.display ?? process.env.DISPLAY_ID ?? ":99";
    this.pulseServer = this.resolvePulseServer(options.pulseServer);
    this.autoLaunch =
      options.autoLaunch ?? readBooleanEnv("AUTO_LAUNCH_MT5", true);
    this.autoInstall =
      options.autoInstall ?? readBooleanEnv("AUTO_INSTALL_MT5", true);
    this.installWebView =
      options.installWebView ?? readBooleanEnv("MT5_INSTALL_WEBVIEW2", false);
    this.mt5InstallerUrl =
      options.mt5InstallerUrl || process.env.MT5_INSTALLER_URL || defaultMt5Url;
    this.webViewInstallerUrl =
      options.webViewInstallerUrl ||
      process.env.WEBVIEW2_INSTALLER_URL ||
      defaultWebViewUrl;
    this.startupConfig = mt5StartupConfigFromEnv(process.env);
    this.wineBootTimeoutMs = readTimeoutMs(
      "MT5_WINEBOOT_TIMEOUT_MS",
      DEFAULT_WINE_BOOT_TIMEOUT_MS,
    );
    this.wineCfgTimeoutMs = readTimeoutMs(
      "MT5_WINECFG_TIMEOUT_MS",
      DEFAULT_WINECFG_TIMEOUT_MS,
    );
    this.webViewTimeoutMs = readTimeoutMs(
      "MT5_WEBVIEW2_TIMEOUT_MS",
      DEFAULT_WEBVIEW_TIMEOUT_MS,
    );
    this.stopTimeoutMs = readTimeoutMs(
      "MT5_STOP_TIMEOUT_MS",
      DEFAULT_MT5_STOP_TIMEOUT_MS,
    );

    this.startReconcileLoop();
    this.log(`Linux MT5 data directory: ${this.paths.dataDir}.`);
    const bootDelayMs = readDelayMs("AUTO_LAUNCH_DELAY_MS", 2500);
    if (this.installedExecutable()) {
      if (this.autoLaunch) {
        this.log("Detected existing MT5 install; scheduling automatic launch.");
        setTimeout(() => {
          void this.launch().catch((error) => this.captureError(error));
        }, bootDelayMs);
      }
    } else if (this.autoInstall) {
      this.log("No MT5 install detected; scheduling automatic unattended install.");
      setTimeout(() => {
        void this.install().catch((error) => this.captureError(error));
      }, bootDelayMs);
    }
  }

  getState(): Mt5Status {
    const executable = this.installedExecutable();
    const status: Mt5Status = {
      ...createInitialMt5Status(this.paths.dataDir),
      mt5: this.mt5State,
      installed: Boolean(executable),
      installerRunning: this.processes.has("installer"),
      installerFiles: {
        mt5Setup: hasFile(this.paths.mt5InstallerPath),
        webviewSetup: hasFile(this.paths.webviewInstallerPath),
      },
      paths: {
        ...this.paths,
        mt5ExecutablePath: executable,
      },
      lastError: this.lastError ?? this.expertMonitor?.status.lastError,
      expert: this.expertMonitor?.status,
      sessionMode: this.sessionMode,
      // The control UI renders the most recent 120 lines; sending more only
      // inflates every status poll.
      logs: this.logs.slice(-120),
    };

    return redactPathsForStatus(status);
  }

  async install(): Promise<Mt5Status> {
    if (this.importApplying) throw new Error("Wait for the data import to finish.");
    if (this.installPromise || this.processes.has("installer")) {
      this.log("MT5 installer is already running.");
      return this.getState();
    }

    if (this.installedExecutable()) {
      this.log("MT5 is already installed.");
      return this.getState();
    }

    this.mt5State = "installing";
    this.lastError = undefined;
    this.installPromise = this.bootstrapInstaller().finally(() => {
      this.installPromise = undefined;
    });

    return this.getState();
  }

  launch(): Promise<Mt5Status> {
    return this.runLifecycle(() => this.launchOnce());
  }

  private async launchOnce(): Promise<Mt5Status> {
    const executable = this.installedExecutable();
    if (!executable) {
      throw new Error("MT5 is not installed yet. Start the installer first.");
    }

    this.lifecycleGeneration += 1;
    this.mt5State = "launching";
    try {
      if (await this.imports.pending()) throw new Error("An interrupted data import needs recovery. Use Recover import before launching MT5.");
      if (this.processes.has("mt5") || (await this.isMt5Running())) {
        // Startup config is applied through MT5's `/config:` launch flag, so a
        // terminal that is already running has not seen this boot's [StartUp].
        // Restart once to apply it, then leave repeated launches idempotent.
        if (this.sessionMode === "managed" && this.startupConfig.enabled && !this.startupApplied) {
          this.log(
            "MT5 is running without the configured startup state; restarting to apply it.",
          );
          await this.stopOnce();
        } else {
          this.mt5State = "running";
          this.lastError = undefined;
          this.reconcileFailure = false;
          await this.monitorExpert(true);
          this.log("MT5 is already running.");
          return this.getState();
        }
      }

      this.lastError = undefined;
      await this.ensureDataDirectories();
      // Match Wine's audio driver to ENABLE_AUDIO. Empty driver (audio off)
      // stops the ALSA "cannot find card" log noise on headless hosts. Non-fatal.
      try {
        await this.runOneShot(
          "wine-audio",
          buildWineAudioDriverCommand(Boolean(this.pulseServer)),
          this.wineCfgTimeoutMs,
        );
      } catch (error) {
        this.log(
          `Audio driver setup skipped: ${error instanceof Error ? error.message : "unknown error"}.`,
        );
      }
      const startupFiles = this.sessionMode === "managed" ? await writeMt5StartupFiles(
        this.paths.winePrefix,
        this.startupConfig,
      ) : undefined;
      const restoreFile = this.sessionMode === "restore" ? await writeMt5RestoreFile(this.paths.winePrefix, this.paths.cacheDir) : undefined;
      if (this.sessionMode === "restore") this.log("Resuming MT5's saved account and chart profile without rewriting startup configuration.");
      await this.monitorExpert(false);
      if (startupFiles?.commonIniPath) {
        this.log(`Updated MT5 common.ini: ${startupFiles.commonIniPath}.`);
      }
      if (startupFiles?.presetPath) {
        this.log(`Generated MT5 EA preset: ${startupFiles.presetPath}.`);
      }
      this.startProcess(
        "mt5",
        buildMt5LaunchCommand(executable, startupFiles?.commonIniWindowsPath ?? restoreFile?.windowsPath),
      );
      this.startupApplied = true;
      this.mt5State = "running";
      this.reconcileFailure = false;
      this.log("MT5 terminal launched.");
    } catch (error) {
      this.mt5State = "failed";
      this.reconcileFailure = false;
      this.captureError(error);
      throw error;
    }
    return this.getState();
  }

  stop(): Promise<Mt5Status> {
    return this.runLifecycle(() => this.stopOnce());
  }

  private async stopOnce(): Promise<Mt5Status> {
    this.lifecycleGeneration += 1;
    this.mt5State = "stopping";
    try {
      // Mark the child intentional before Wine starts closing it so its exit
      // handler does not report a normal stop as an unexpected MT5 crash.
      this.markIntentionalStop("mt5");
      if (this.processes.has("mt5") || (await this.isMt5Running())) {
        // A hung or failed wineboot must not skip the force-kill fallback; that
        // is precisely the case the fallback exists for.
        try {
          await this.runOneShot(
            "wine-shutdown",
            buildWineShutdownCommand(),
            this.stopTimeoutMs,
          );
        } catch (error) {
          this.log(
            `Graceful Wine shutdown failed: ${error instanceof Error ? error.message : "unknown error"}. Continuing with process wait.`,
          );
        }
      }
      if (!(await this.waitForMt5Exit(this.stopTimeoutMs))) {
        this.log(
          `MT5 did not exit within ${this.stopTimeoutMs}ms; forcing wineserver shutdown.`,
        );
        try {
          await this.runOneShot(
            "wineserver-kill",
            buildWineKillCommand(),
            this.stopTimeoutMs,
          );
        } catch (error) {
          this.log(
            `wineserver -k failed: ${error instanceof Error ? error.message : "unknown error"}.`,
          );
        }
        if (!(await this.waitForMt5Exit(this.stopTimeoutMs))) {
          throw new Error("MT5 is still running after wineserver shutdown.");
        }
      }
      // Do not SIGTERM the tracked launcher until the terminal has flushed its
      // account/profile state and exited (or the force-kill fallback completed).
      await this.stopProcess("mt5", { intentional: true });
    } catch (error) {
      this.mt5State = "failed";
      this.captureError(error);
      throw error;
    }
    this.mt5State = "idle";
    this.lastError = undefined;
    this.startupApplied = false;
    this.expertMonitor = undefined;
    this.reconcileFailure = false;
    this.log("MT5 terminal stopped.");
    return this.getState();
  }

  restart(): Promise<Mt5Status> {
    return this.runLifecycle(async () => {
      await this.stopOnce();
      return this.launchOnce();
    });
  }

  async getExpertsInfo(): Promise<ExpertsDirectoryInfo> {
    const expertsDir = this.expertsDirectory();
    await mkdir(expertsDir, { recursive: true });
    return { expertsDir, files: await this.listExpertsFiles(expertsDir) };
  }

  async getImportInfo() {
    return { ...await this.imports.info(), target: findMt5TerminalDataRoot(this.paths.winePrefix), sessionMode: this.sessionMode };
  }

  async listFiles(path: string) {
    const root = findMt5TerminalDataRoot(this.paths.winePrefix);
    if (!root) throw new Error("MT5 data folder was not found. Launch MT5 once to create it.");
    const driveC = `${this.paths.winePrefix}/drive_c/`;
    const windowsRoot = root.startsWith(driveC) ? `C:\\${root.slice(driveC.length).replace(/\//g, "\\")}` : undefined;
    return listTerminalFiles(root, path, windowsRoot);
  }

  async createImport(manifest: unknown) {
    const root = findMt5TerminalDataRoot(this.paths.winePrefix);
    if (!root) throw new Error("MT5 data folder was not found. Launch MT5 once to create it.");
    return this.imports.create(root, manifest);
  }

  previewImport(id: string) { return this.imports.preview(id); }
  uploadImportChunk(id: string, index: number, offset: number, bytes: Uint8Array, sha256?: string) { return this.imports.chunk(id, index, offset, bytes, sha256); }
  cancelImport(id: string) { return this.imports.cancel(id); }

  applyImport(id: string, options: ImportOptions) {
    return this.runLifecycle(async () => {
      this.importApplying = true;
      try {
        const running = this.processes.has("mt5") || await this.isMt5Running();
        const root = findMt5TerminalDataRoot(this.paths.winePrefix);
        if (!root) throw new Error("MT5 data folder was not found.");
        const result = await this.imports.apply(id, root, options, running);
        if (!running) {
          this.expertMonitor = undefined;
          this.lastError = undefined;
        }
        this.log(`Data-folder import applied (${result.applied} files). Backup: ${result.backup}. ${running ? "MT5 kept running; use Navigator > Refresh." : "MT5 remains stopped."}`);
        return result;
      } finally { this.importApplying = false; }
    });
  }

  recoverImport() {
    return this.runLifecycle(async () => {
      this.importApplying = true;
      try {
        if (this.processes.has("mt5") || await this.isMt5Running()) throw new Error("Stop MT5 before recovering an import.");
        const result = await this.imports.recover();
        this.lastError = undefined;
        this.mt5State = "idle";
        return result;
      } finally { this.importApplying = false; }
    });
  }

  acknowledgeExpertRemovals(): Mt5Status {
    this.expertMonitor?.acknowledgeRemovals();
    return this.getState();
  }

  uploadExperts(files: File[]): Promise<ExpertUploadResult> {
    return this.runLifecycle(() => this.uploadExpertsOnce(files));
  }

  private async uploadExpertsOnce(files: File[]): Promise<ExpertUploadResult> {
    if (this.importApplying) throw new Error("Wait for the data import to finish before uploading EA files.");
    if (files.length === 0) {
      throw new Error("No expert advisor files were uploaded.");
    }

    const expertsDir = this.expertsDirectory();
    await mkdir(expertsDir, { recursive: true });
    const uploaded: string[] = [];

    for (const file of files) {
      const filename = this.safeUploadFilename(file.name);
      const targetDir = uploadTargetDirectory(expertsDir, filename);
      await mkdir(targetDir, { recursive: true });
      await Bun.write(join(targetDir, filename), file);
      uploaded.push(filename);
    }

    this.log(`Uploaded EA files: ${uploaded.join(", ")}.`);
    return { expertsDir, files: await this.listExpertsFiles(expertsDir), uploaded };
  }

  appendLog(message: string): void {
    this.log(message);
  }

  private expertsDirectory(): string {
    const expertsDir = findMt5ExpertsDirectory(this.paths.winePrefix);
    if (!expertsDir) {
      throw new Error("MT5 Experts directory was not found. Launch MT5 once, then retry.");
    }
    return expertsDir;
  }

  private async listExpertsFiles(expertsDir: string): Promise<string[]> {
    const entries = await readdir(expertsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  private safeUploadFilename(name: string): string {
    const filename = basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
    if (!filename || filename === "." || filename === "..") {
      throw new Error(`Invalid upload filename: ${name}`);
    }
    if (!/\.(ex5|mq5|mqh|set|dll)$/i.test(filename)) {
      throw new Error(
        `Unsupported EA file type for ${filename}. Upload .ex5, .mq5, .mqh, .set, or .dll files.`,
      );
    }
    return filename;
  }

  private async bootstrapInstaller(): Promise<void> {
    try {
      await this.ensureDataDirectories();
      await this.ensureInstallerFiles();
      await this.runOneShot("wineboot", buildWineBootCommand(), this.wineBootTimeoutMs);
      await this.runOneShot(
        "winecfg",
        buildWineWindowsVersionCommand(),
        this.wineCfgTimeoutMs,
      );
      await this.runOneShot(
        "wine-antidebug",
        buildWineAntiDebugCommand(),
        this.wineCfgTimeoutMs,
      );
      if (this.installWebView) {
        await this.runOneShot(
          "webview2",
          buildWebViewInstallCommand(this.paths.webviewInstallerPath),
          this.webViewTimeoutMs,
        );
      } else {
        this.log("Skipping WebView2 install because MT5_INSTALL_WEBVIEW2 is not enabled.");
      }
      this.startProcess("installer", buildMt5InstallerCommand(this.paths.mt5InstallerPath));
      this.log("MT5 GUI installer opened in the browser desktop.");
    } catch (error) {
      this.mt5State = "failed";
      this.captureError(error);
    }
  }

  private async ensureDataDirectories(): Promise<void> {
    await mkdir(this.paths.cacheDir, { recursive: true });
    await mkdir(dirname(this.paths.winePrefix), { recursive: true });
    await mkdir(this.paths.winePrefix, { recursive: true });
    await mkdir(process.env.HOME ?? "/data/home", { recursive: true });
  }

  private async ensureInstallerFiles(): Promise<void> {
    await this.downloadFile(
      this.mt5InstallerUrl,
      this.paths.mt5InstallerPath,
      "MetaTrader 5 installer",
    );
    if (this.installWebView) {
      await this.downloadFile(
        this.webViewInstallerUrl,
        this.paths.webviewInstallerPath,
        "WebView2 installer",
      );
    }
  }

  private async downloadFile(
    url: string,
    path: string,
    label: string,
  ): Promise<void> {
    // Keep the source URL next to the cached file so changing
    // MT5_INSTALLER_URL does not silently reuse the previous installer.
    const markerPath = `${path}.url`;
    let cachedUrl: string | undefined;
    try {
      cachedUrl = readFileSync(markerPath, "utf8").trim() || undefined;
    } catch {
      cachedUrl = undefined;
    }

    const cached = hasFile(path);
    if (cached && cachedUrl === url) {
      this.log(`${label} already cached.`);
      return;
    }
    if (cached) {
      this.log(
        cachedUrl
          ? `${label} source URL changed; replacing the cached file.`
          : `${label} has no source metadata; re-downloading to verify provenance.`,
      );
    }

    this.log(`Downloading ${label}.`);
    try {
      await mkdir(dirname(path), { recursive: true });
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${label} download failed with HTTP ${response.status}.`);
      }
      await Bun.write(path, await response.arrayBuffer());
      await Bun.write(markerPath, url);
      this.log(`${label} downloaded.`);
    } catch (error) {
      // Only fall back to a cached file when its source is unknown. A changed
      // URL must fail rather than silently install the previous broker build.
      if (!cached || cachedUrl) {
        throw error;
      }
      // Offline or transient failure: keep the existing installer usable, but
      // leave the source marker unset so the next boot retries verification.
      this.log(
        `Could not verify the cached ${label} (${error instanceof Error ? error.message : "download failed"}); using the existing file.`,
      );
    }
  }

  private installedExecutable(): string | undefined {
    return findMt5Executable(this.paths.winePrefix);
  }

  private resolvePulseServer(configuredPulseServer?: string): string | undefined {
    if (configuredPulseServer) {
      return configuredPulseServer;
    }
    if (!readBooleanEnv("ENABLE_AUDIO", false)) {
      return undefined;
    }
    return process.env.PULSE_SERVER ?? "unix:/tmp/pulse/native";
  }

  private startProcess(name: string, command: string[]): void {
    const [cmd, ...args] = command;
    if (!cmd) {
      throw new Error("Cannot start an empty command.");
    }

    this.log(`Starting ${name}: ${command.join(" ")}`);
    const child = spawn({
      cmd: [cmd, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...buildWineEnv({
          display: this.display,
          pulseServer: this.pulseServer,
          winePrefix: this.paths.winePrefix,
        }),
      },
    });

    const generation = this.lifecycleGeneration;
    this.processes.set(name, { name, process: child });
    this.captureOutput(name, child.stdout);
    this.captureOutput(name, child.stderr);

    void child.exited.then(async (code) => {
      const managed = this.processes.get(name);
      if (managed?.process !== child) {
        this.log(`${name} exited with code ${code} for a stale process.`);
        return;
      }

      this.processes.delete(name);
      this.log(`${name} exited with code ${code}.`);
      if (name === "installer") {
        this.mt5State = this.installedExecutable() ? "idle" : "failed";
        if (this.mt5State === "failed") {
          this.lastError = "MT5 installer exited before terminal64.exe was detected.";
        } else if (this.autoLaunch && !this.processes.has("mt5")) {
          this.log("Unattended install finished; scheduling automatic launch.");
          setTimeout(() => {
            // launchOnce handles the case where the installer left the
            // terminal running: it restarts once to apply [StartUp] and stays
            // idempotent if a manual launch already did so.
            void this.launch().catch((error) => this.captureError(error));
          }, readDelayMs("AUTO_LAUNCH_DELAY_MS", 2500));
        }
      }
      if (name === "mt5" && !managed.intentionalStop) {
        const running = await this.isMt5Running();
        if (generation !== this.lifecycleGeneration || this.processes.has(name)) return;
        if (running) {
          this.mt5State = "running";
          this.log("Wine launcher exited; MT5 terminal continues running.");
          return;
        }
        this.mt5State = "failed";
        this.reconcileFailure = true;
        this.lastError = `MT5 exited unexpectedly with code ${code}.`;
      }
    }).catch((error) => this.captureError(error));
  }

  private async runOneShot(
    name: string,
    command: string[],
    timeoutMs: number,
  ): Promise<void> {
    const [cmd, ...args] = command;
    if (!cmd) {
      throw new Error("Cannot start an empty command.");
    }

    this.log(`Running ${name}: ${command.join(" ")} (timeout ${timeoutMs}ms)`);
    const child = spawn({
      cmd: [cmd, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...buildWineEnv({
          display: this.display,
          pulseServer: this.pulseServer,
          winePrefix: this.paths.winePrefix,
        }),
      },
    });
    this.captureOutput(name, child.stdout);
    this.captureOutput(name, child.stderr);

    const code = await waitForExit(child, timeoutMs);
    if (code === undefined) {
      child.kill("SIGKILL");
      throw new Error(`${name} timed out after ${timeoutMs}ms.`);
    }
    if (code !== 0) throw new Error(`${name} exited with code ${code}.`);
  }

  private async isMt5Running(): Promise<boolean> {
    const child = spawn({
      cmd: buildMt5ProcessCheckCommand(),
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await child.exited;
    if (code > 1) {
      throw new Error(`MT5 process check exited with code ${code}.`);
    }
    return code === 0;
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecyclePromise.then(() => {
      if (this.installPromise || this.processes.has("installer")) {
        throw new Error("Wait for the MT5 installer to finish before changing terminal state.");
      }
      return operation();
    });
    this.lifecyclePromise = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // MT5 detaches from its Wine launcher, so once that child exits it is no
  // longer supervised. Poll the terminal process while the manager believes it
  // is running, otherwise a later crash is invisible in the UI and healthcheck.
  private startReconcileLoop(): void {
    const interval = readTimeoutMs(
      "MT5_RECONCILE_INTERVAL_MS",
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    const timer = setInterval(() => {
      void this.reconcileMt5State();
    }, interval);
    (timer as { unref?: () => void }).unref?.();
  }

  private async reconcileMt5State(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const monitor = this.expertMonitor;
      if (this.mt5State === "running" && monitor) {
        try {
          const before = monitor.status.lastError;
          await monitor.poll();
          if (this.expertMonitor === monitor && monitor.status.lastError && before !== monitor.status.lastError) {
            this.log(monitor.status.lastError);
          }
        } catch (error) {
          this.log(`EA log check failed: ${error instanceof Error ? error.message : "unknown error"}.`);
        }
      }
      if (this.processes.has("mt5")) return;

      const previousState = this.mt5State;
      const recovering = previousState === "failed" && this.reconcileFailure;
      if (!recovering && previousState !== "running") {
        return;
      }

      const generation = this.lifecycleGeneration;
      const running = await this.isMt5Running();

      // A launch/stop may have completed while pgrep was running, and the
      // result may describe the previous terminal. Discard it in that case.
      if (
        generation !== this.lifecycleGeneration ||
        this.mt5State !== previousState ||
        this.processes.has("mt5")
      ) {
        return;
      }

      if (running) {
        if (recovering) {
          this.mt5State = "running";
          this.reconcileFailure = false;
          this.lastError = undefined;
          this.log("MT5 terminal is running again; clearing reconcile failure.");
        }
        return;
      }

      if (recovering) {
        return;
      }

      this.mt5State = "failed";
      this.reconcileFailure = true;
      this.lastError = "MT5 terminal is no longer running.";
      this.log("Detached MT5 terminal disappeared; marking status failed.");
    } catch (error) {
      this.log(
        `MT5 reconciliation check failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      );
    } finally {
      this.reconciling = false;
    }
  }

  private async monitorExpert(adopting: boolean): Promise<void> {
    if (!this.startupConfig.enabled || !this.startupConfig.expertName) return;
    if (adopting && this.expertMonitor) return;
    const root = findMt5TerminalDataRoot(this.paths.winePrefix);
    if (!root) throw new Error("MT5 data folder for EA log monitoring was not found.");
    this.expertMonitor = await ExpertLogMonitor.create(root, this.startupConfig.expertName, adopting);
  }

  private markIntentionalStop(name: string): void {
    const managed = this.processes.get(name);
    if (managed) {
      managed.intentionalStop = true;
    }
  }

  private async waitForMt5Exit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (!(await this.isMt5Running())) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await Bun.sleep(250);
    }
  }

  private async stopProcess(
    name: string,
    options: { intentional?: boolean } = {},
  ): Promise<void> {
    const managed = this.processes.get(name);
    if (!managed) {
      return;
    }

    managed.intentionalStop = options.intentional ?? false;
    managed.process.kill();
    if (await waitForExit(managed.process, this.stopTimeoutMs) === undefined) {
      managed.process.kill("SIGKILL");
      await waitForExit(managed.process, 1000);
    }
    if (this.processes.get(name) === managed) this.processes.delete(name);
  }

  private captureOutput(
    name: string,
    stream: ReadableStream<Uint8Array>,
  ): void {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        this.log(`${name}: ${decoder.decode(value).trim()}`);
      }
    })();
  }

  private captureError(error: unknown): void {
    const message = error instanceof Error ? error.message : "Unknown error";
    this.lastError = message;
    this.log(`Error: ${message}`);
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message.trim()}`;
    this.logs.push(line);
    if (this.logs.length > 500) {
      this.logs.shift();
    }
    // Mirror the in-memory runtime log to stdout so `docker logs` retains it
    // across API restarts and container recreation.
    console.log(line);
  }
}
