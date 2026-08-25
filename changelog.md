# Changelog

## 1.3.3 - 2026-08-25 (Patch)

Release impact: Patch because this corrects MT5 restart/process detection and
reduces container overhead without changing the API contract or EA inputs.

- Detects the detached `terminal64.exe` process so repeated launch/restart
  requests no longer replay `[StartUp]` into the same terminal and add Gold
  charts.
- Uses a clean Wine shutdown for API and container restarts, with a Compose
  grace period before Docker forces termination.
- Copies only the bundled server and built web app into the runtime image
  instead of the build tree and `node_modules`.
- Loads the Experts directory when install state changes instead of polling it
  every 2.5 seconds.
- Corrected the Wine runtime documentation to WineHQ stable (Wine 11).

## 1.3.2 - 2026-07-26 (Patch)

Release impact: Patch because this restores the manual MT5 install fallback
and corrects release metadata without changing the API contract.

- Restored the control UI Install action for disabled or failed auto-installs.
- Aligned the README release version with `VERSION`.

## 1.3.1 - 2026-07-26 (Patch)

Release impact: Patch because this updates the container's Wine runtime for
compatibility with current MT5 builds without changing the application API.

- Switched from Debian Bookworm Wine 8 to the WineHQ stable branch (Wine 11).
- Added coverage for the newer Windows APIs required by the current MT5
  terminal executable.
- Documented the tested TelegramTC_EA v1.50 startup profile for persistent EA
  autoloading.

## 1.3.0 - 2026-06-27 (Minor)

Release impact: Minor because it changes the control-UI workflow (no manual
Install step) on top of a log-noise fix and a docs refresh, all
backward-compatible. The `/api/mt5/install` endpoint is unchanged.

- Control UI: removed the now-redundant Install button (MT5 auto-installs), the
  "LAN DESKTOP" label, and the always-"missing" WebView2 runtime row. Renamed
  the pre-install state label from "READY FOR INSTALL" to "STARTING".
- Silenced the ALSA "cannot find card '0'" log spam from Wine on headless
  hosts. On launch the container sets Wine's `HKCU\Software\Wine\Drivers`
  `Audio` value to match `ENABLE_AUDIO` — empty (no driver, no ALSA probing)
  when audio is disabled (the default), or `pulse` when enabled. Applied at
  launch so existing installs pick it up on the next restart.
- Refreshed the root README to reflect the current feature set (unattended
  auto-install, self-healing desktop watchdog, Docker healthcheck, optional S3
  tick-CSV sync, and the Wine 8 pin).

## 1.2.0 - 2026-06-27 (Minor)

Release impact: Minor because it adds backward-compatible automation and
operational features. Unattended install is on by default but only acts when no
MT5 install is present, so existing installs are untouched.

- Added unattended MT5 auto-install. The container now installs MetaTrader 5 by
  itself on first boot using `mt5setup.exe /auto` (no GUI click-through),
  controlled by `AUTO_INSTALL_MT5` (default `true`). After a successful install
  it auto-launches when `AUTO_LAUNCH_MT5` is set. Verified the silent `/auto`
  flag against the MetaQuotes installer documentation.
- Added a Docker `HEALTHCHECK` that polls `/api/status`, with a 180s start
  period to cover first-boot Wine prefix creation and the unattended install.
- Reworked `docker-compose.yml` into a minimal default that only auto-installs
  MT5. All optional features (official installer + `WINEDLLOVERRIDES`, EA
  pre-config via `MT5_STARTUP_*`, and S3 sync) are commented out with
  enable-by-uncommenting instructions, mirrored in
  `docker-compose.override.yml.example`.
- Hardened the optional S3 sync: it now defers a cycle whenever a `*.csv` was
  modified within `S3_SYNC_SETTLE_SECONDS` (default 60), so a file still being
  written is never uploaded partially. Still one-way (`aws s3 sync`, no
  `--delete`) and still off unless `S3_SYNC_ENABLED=true` and `S3_URI` are set.
- Documented MT5 pre-configuration (the existing `MT5_STARTUP_CONFIG` /
  `common.ini` `[StartUp]` mechanism) as the supported way to prefill startup
  and autoload an EA.
- Pinned and documented the Wine compatibility matrix in the Dockerfile and
  READMEs: official build 5836 installs and runs on Debian distro Wine 8 but its
  installer anti-debug trips on WineHQ 10/11, so the image stays on Wine 8.

## 1.1.0 - 2026-06-27 (Minor)

Release impact: Minor because this adds backward-compatible reliability and an
opt-in S3 feature without breaking existing deployments. S3 sync is off by
default and the default MT5 installer is unchanged.

- Fixed the dead-desktop-after-restart bug: the entrypoint now removes stale
  `/tmp/.X<n>-lock` and X11 sockets before starting Xvfb, so `docker restart`
  no longer fails with "Server is already active for display N" (which left the
  API up but Xvfb/x11vnc/openbox dead as zombies).
- Added a watchdog supervisor in the entrypoint that restarts Xvfb, openbox,
  x11vnc, and websockify if they die, reaps zombies, and stops the container if
  the API server itself exits. Closes the two known gaps in the README's
  "Future Improvements" (stale X locks, health watchdog).
- Added optional S3 sync of exported tick CSVs, turned on via Compose with
  `S3_SYNC_ENABLED=true` and `S3_URI`. Uses the EC2 instance role when AWS
  credentials are not provided, or `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` when they are. Configurable via
  `S3_SYNC_SOURCE_DIR` and `S3_SYNC_INTERVAL_SECONDS`. Installs the AWS CLI in
  the image.
- Added a `WINEDLLOVERRIDES` Compose passthrough so the official MetaTrader 5
  installer can run headlessly (`mscoree=d;mshtml=d`) without blocking on the
  Wine Mono/Gecko prompts.
- Kept the image on Debian's distro Wine (8.0). The current official MT5 build
  (5836) prints an advisory "unstable and unsupported Wine ... upgrade to Wine
  10.0+" line but still installs and runs on Wine 8. Upgrading to WineHQ 11 was
  tried and rejected: build 5836's installer protector then trips its
  anti-debug check ("A debugger has been found running in your system") and
  refuses to install. Distro Wine 8 is the working configuration.
- Removed the obsolete Compose `version` key to silence the Compose v2 warning.

## 1.0.0 - 2026-05-26 (Major)

Release impact: Major because this is the first released version of the
Linux-first MT5 Docker workflow. The release establishes the supported
Linux/Wine control UI, EA upload, optional `common.ini` autoload, raw VNC
streaming, and Windows fallback behavior. `VERSION` is the canonical version
source for the repo.

- Added optional Compose-controlled MT5 `common.ini` management so the Linux
  container can apply low-resource settings, autoload a configured EA, and
  write EA presets without creating a separate startup INI file.
- Launches MT5 with `/config:` pointing at the active `common.ini` so
  MetaTrader executes the Compose-managed `[StartUp]` block.
- Documented the Linux custom-EA setup flow and clarified that `MaxBars` is
  pinned to 5000 when startup config management is enabled.
- Published a configurable raw VNC/RFB host port for local stream tools such as
  `rdp-stream-studio`, and documented that noVNC browser URLs are not raw VNC
  endpoints.
- Added configurable Linux MT5 container naming for repeated local deployments
  and disabled PulseAudio by default for lower runtime overhead.
- Switched the Linux image runtime to Debian Bookworm's distro Wine with a
  `win64` prefix after Trixie/WineHQ staging repeatedly hung during fresh
  `wineboot --init`.
- Set Wine's Windows compatibility mode to Windows 10 because Debian Wine 8
  accepts `win10` but rejects `win11`.
- Made WebView2 installation opt-in with `MT5_INSTALL_WEBVIEW2=false` by
  default because the EdgeUpdate bootstrapper can hang under Wine before MT5
  itself starts.
- Fixed EA upload and managed `common.ini` discovery for official MetaQuotes
  installs that keep `Config/common.ini` and `MQL5/Experts` under
  `Program Files/MetaTrader 5`.
- Clarified that EA uploads can fail on a fresh MT5 install until MT5 has been
  launched once and has created its `MQL5/Experts` folders.
- Reworked the root README so it reflects the current Linux-first workflow,
  web-app EA upload path, local override pattern, and Windows-as-fallback
  guidance.
- Moved optional EA autoload and `common.ini` environment declarations out of
  the shared Linux Compose file and documented a local override file instead.
- Fixed the Linux Docker build so shared TypeScript declarations are emitted
  before the server package builds against them.

## 2026-05-17

- Changed the Windows MT5 Dockur default from Windows 10 LTSC evaluation
  (`10l`) to regular Windows 11 (`11`) to avoid evaluation shutdown loops.
- Added configurable Windows VM environment variables for version, disk, RAM,
  CPU, and OEM first-boot assets.
- Added a Dockur OEM first-boot hook that runs Chris Titus Tech Winutil's
  Standard preset on first Windows startup, with customizable unattended config
  support.
- Added a Windows `.env.example` covering the Windows 11 data directory and
  OEM mount.
- Documented the bind-mounted Windows data directory behaviour so Windows 11
  replacements use a fresh VM disk instead of reusing the old LTSC image.
