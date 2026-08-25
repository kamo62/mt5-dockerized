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

export function buildWineShutdownCommand(): string[] {
  return ["wineboot", "--shutdown"];
}

export function buildMt5ProcessCheckCommand(): string[] {
  return ["pgrep", "-f", "[t]erminal(64)?\\.exe"];
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

// Set Wine's audio driver. When audio is disabled we set it to empty so Wine
// loads no audio driver and never probes ALSA (which otherwise floods the logs
// with "cannot find card '0'" noise on a headless host with no sound device).
export function buildWineAudioDriverCommand(audioEnabled: boolean): string[] {
  return [
    "wine",
    "reg",
    "add",
    "HKCU\\Software\\Wine\\Drivers",
    "/v",
    "Audio",
    "/t",
    "REG_SZ",
    "/d",
    audioEnabled ? "pulse" : "",
    "/f",
  ];
}

export function buildWebViewInstallCommand(installerPath: string): string[] {
  return ["wine", installerPath, "/silent", "/install"];
}

export function buildMt5InstallerCommand(installerPath: string): string[] {
  // `/auto` runs the MetaTrader installer unattended (no GUI click-through),
  // which is what makes a hands-off auto-install possible.
  return ["wine", installerPath, "/auto"];
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
