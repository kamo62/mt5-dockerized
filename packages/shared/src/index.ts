import { z } from "zod";

export const DesktopStateSchema = z.enum(["starting", "ready", "failed"]);
export const Mt5ProcessStateSchema = z.enum([
  "idle",
  "installing",
  "launching",
  "running",
  "stopping",
  "failed",
]);

export const RuntimePathsSchema = z.object({
  dataDir: z.string().min(1),
  cacheDir: z.string().min(1),
  winePrefix: z.string().min(1),
  mt5InstallerPath: z.string().min(1),
  webviewInstallerPath: z.string().min(1),
  mt5ExecutablePath: z.string().optional(),
});

export const InstallerFilesSchema = z.object({
  mt5Setup: z.boolean(),
  webviewSetup: z.boolean(),
});

export const Mt5StatusSchema = z.object({
  desktop: DesktopStateSchema,
  mt5: Mt5ProcessStateSchema,
  installed: z.boolean(),
  installerRunning: z.boolean(),
  installerFiles: InstallerFilesSchema,
  paths: RuntimePathsSchema,
  lastError: z.string().optional(),
  logs: z.array(z.string()).default([]),
});

export const RuntimeConfigSchema = z.object({
  noVncUrl: z.string().url(),
});

export type DesktopState = z.infer<typeof DesktopStateSchema>;
export type Mt5ProcessState = z.infer<typeof Mt5ProcessStateSchema>;
export type RuntimePaths = z.infer<typeof RuntimePathsSchema>;
export type InstallerFiles = z.infer<typeof InstallerFilesSchema>;
export type Mt5Status = z.infer<typeof Mt5StatusSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

function cleanDir(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/data";
}

export function createRuntimePaths(dataDir = "/data"): RuntimePaths {
  const root = cleanDir(dataDir);

  return {
    dataDir: root,
    cacheDir: `${root}/cache`,
    winePrefix: `${root}/wine-prefix/.mt5`,
    mt5InstallerPath: `${root}/cache/mt5setup.exe`,
    webviewInstallerPath: `${root}/cache/webview2.exe`,
  };
}

export function createInitialMt5Status(dataDir = "/data"): Mt5Status {
  return {
    desktop: "ready",
    mt5: "idle",
    installed: false,
    installerRunning: false,
    installerFiles: {
      mt5Setup: false,
      webviewSetup: false,
    },
    paths: createRuntimePaths(dataDir),
    logs: [],
  };
}

export function redactPathsForStatus(status: Mt5Status): Mt5Status {
  const safePaths = createRuntimePaths("/data");

  return {
    ...status,
    paths: {
      ...safePaths,
      mt5ExecutablePath: status.paths.mt5ExecutablePath
        ? status.paths.mt5ExecutablePath.replace(status.paths.dataDir, "/data")
        : undefined,
    },
  };
}
