export type WineEnvInput = {
  display: string;
  pulseServer?: string;
  winePrefix: string;
};

export function buildWineEnv(input: WineEnvInput): Record<string, string> {
  return {
    DISPLAY: input.display,
    HOME: process.env.HOME ?? "/data/home",
    ...(input.pulseServer ? { PULSE_SERVER: input.pulseServer } : {}),
    WINEPREFIX: input.winePrefix,
    WINEDEBUG: process.env.WINEDEBUG ?? "-all",
  };
}

export function buildWineBootCommand(): string[] {
  return ["wineboot", "--init"];
}

export function buildWineWindowsVersionCommand(): string[] {
  return ["winecfg", "-v=win10"];
}

export function buildWineAntiDebugCommand(): string[] {
  return [
    "sh",
    "-lc",
    [
      "wine reg add 'HKCU\\Software\\Wine' /v HideWineExports /t REG_SZ /d Y /f",
      "(wine reg delete 'HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug' /f || true)",
      "(wine reg delete 'HKLM\\Software\\Wow6432Node\\Microsoft\\Windows NT\\CurrentVersion\\AeDebug' /f || true)",
    ].join(" && "),
  ];
}

export function buildWebViewInstallCommand(installerPath: string): string[] {
  return ["wine", installerPath, "/silent", "/install"];
}

export function buildMt5InstallerCommand(installerPath: string): string[] {
  return ["wine", installerPath];
}

export function buildMt5LaunchCommand(
  executablePath: string,
  configPath?: string,
): string[] {
  return [
    "wine",
    executablePath,
    ...(configPath ? [`/config:${configPath}`] : []),
  ];
}
