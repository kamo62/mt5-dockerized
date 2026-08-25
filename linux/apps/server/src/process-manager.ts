import { existsSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
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
  buildWineShutdownCommand,
  buildWebViewInstallCommand,
  buildWineBootCommand,
  buildWineEnv,
  buildWineWindowsVersionCommand,
} from "./command-builder";
import { findMt5Executable, findMt5ExpertsDirectory, getRuntimePaths } from "./paths";
import {
  mt5StartupConfigFromEnv,
  writeMt5StartupFiles,
  type Mt5StartupConfig,
} from "./mt5-startup-config";

const defaultMt5Url =
  "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe";
const defaultWebViewUrl =
  "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/f2910a1e-e5a6-4f17-b52d-7faf525d17f8/MicrosoftEdgeWebview2Setup.exe";

export const DEFAULT_WINE_BOOT_TIMEOUT_MS = 900_000;
export const DEFAULT_WINECFG_TIMEOUT_MS = 180_000;
export const DEFAULT_WEBVIEW_TIMEOUT_MS = 600_000;

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
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly logs: string[] = [];
  private lifecyclePromise: Promise<void> = Promise.resolve();
  private mt5State: Mt5ProcessState = "idle";
  private lastError?: string;
  private installPromise?: Promise<void>;

  constructor(options: ManagerOptions = {}) {
    this.paths = options.paths ?? getRuntimePaths();
    this.display = options.display ?? process.env.DISPLAY_ID ?? ":99";
    this.pulseServer = this.resolvePulseServer(options.pulseServer);
    this.autoLaunch =
      options.autoLaunch ?? readBooleanEnv("AUTO_LAUNCH_MT5", true);
    this.autoInstall =
      options.autoInstall ?? readBooleanEnv("AUTO_INSTALL_MT5", true);
    this.installWebView =
      options.installWebView ?? readBooleanEnv("MT5_INSTALL_WEBVIEW2", false);
    this.mt5InstallerUrl = options.mt5InstallerUrl ?? process.env.MT5_INSTALLER_URL ?? defaultMt5Url;
    this.webViewInstallerUrl =
      options.webViewInstallerUrl ??
      process.env.WEBVIEW2_INSTALLER_URL ??
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

    this.log(`Linux MT5 data directory: ${this.paths.dataDir}.`);
    const bootDelayMs = Number(process.env.AUTO_LAUNCH_DELAY_MS ?? 2500);
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
      lastError: this.lastError,
      logs: this.logs.slice(-250),
    };

    return redactPathsForStatus(status);
  }

  async install(): Promise<Mt5Status> {
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

    this.mt5State = "launching";
    if (this.processes.has("mt5") || (await this.isMt5Running())) {
      this.mt5State = "running";
      this.log("MT5 is already running.");
      return this.getState();
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
    const startupFiles = await writeMt5StartupFiles(
      this.paths.winePrefix,
      this.startupConfig,
    );
    if (startupFiles?.commonIniPath) {
      this.log(`Updated MT5 common.ini: ${startupFiles.commonIniPath}.`);
    }
    if (startupFiles?.presetPath) {
      this.log(`Generated MT5 EA preset: ${startupFiles.presetPath}.`);
    }
    this.startProcess(
      "mt5",
      buildMt5LaunchCommand(executable, startupFiles?.commonIniWindowsPath),
    );
    this.mt5State = "running";
    this.log("MT5 terminal launched.");
    return this.getState();
  }

  stop(): Promise<Mt5Status> {
    return this.runLifecycle(() => this.stopOnce());
  }

  private async stopOnce(): Promise<Mt5Status> {
    this.mt5State = "stopping";
    try {
      if (this.processes.has("mt5") || (await this.isMt5Running())) {
        await this.runOneShot(
          "wine-shutdown",
          buildWineShutdownCommand(),
          this.wineCfgTimeoutMs,
        );
      }
      await this.stopProcess("mt5", { intentional: true });
      if (await this.isMt5Running()) {
        throw new Error("MT5 is still running after Wine shutdown.");
      }
    } catch (error) {
      this.mt5State = "failed";
      this.captureError(error);
      throw error;
    }
    this.mt5State = "idle";
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

  async uploadExperts(files: File[]): Promise<ExpertUploadResult> {
    if (files.length === 0) {
      throw new Error("No expert advisor files were uploaded.");
    }

    const expertsDir = this.expertsDirectory();
    await mkdir(expertsDir, { recursive: true });
    const uploaded: string[] = [];

    for (const file of files) {
      const filename = this.safeUploadFilename(file.name);
      await Bun.write(`${expertsDir}/${filename}`, file);
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
    if (hasFile(path)) {
      this.log(`${label} already cached.`);
      return;
    }

    this.log(`Downloading ${label}.`);
    await mkdir(dirname(path), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${label} download failed with HTTP ${response.status}.`);
    }
    await Bun.write(path, await response.arrayBuffer());
    this.log(`${label} downloaded.`);
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
            void this.launch().catch((error) => this.captureError(error));
          }, Number(process.env.AUTO_LAUNCH_DELAY_MS ?? 2500));
        }
      }
      if (name === "mt5" && !managed.intentionalStop) {
        if (await this.isMt5Running()) {
          this.mt5State = "running";
          this.log("Wine launcher exited; MT5 terminal continues running.");
          return;
        }
        this.mt5State = code === 0 ? "idle" : "failed";
        if (this.mt5State === "failed") {
          this.lastError = `MT5 exited unexpectedly with code ${code}.`;
        }
      }
    });
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

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const code = await child.exited.finally(() => clearTimeout(timeout));
    if (code !== 0) {
      if (timedOut) {
        throw new Error(
          `${name} timed out after ${Math.round(timeoutMs / 1000)}s and exited with code ${code}.`,
        );
      }
      throw new Error(`${name} exited with code ${code}.`);
    }
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

  private runLifecycle(operation: () => Promise<Mt5Status>): Promise<Mt5Status> {
    const result = this.lifecyclePromise.then(operation);
    this.lifecyclePromise = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    await managed.process.exited.catch(() => undefined);
    this.processes.delete(name);
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
  }
}
