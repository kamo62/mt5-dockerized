# Linux MT5

Linux MT5 is a Docker-hosted browser desktop for running MetaTrader 5 on Linux
through Wine. It exposes the virtual desktop through noVNC and provides a small
Bun/React control surface for first-run installation, launching, stopping, and
restarting MT5.

This project follows the official MetaQuotes Linux approach: MetaTrader 5 runs
on Linux through Wine, and the MT5 installer remains a GUI installer. The Docker
image therefore installs Wine and the desktop runtime, while the MT5 installer
runs on first use inside the browser desktop and persists into a Docker volume.

## Architecture

```text
apps/web
  React + Vite control surface with embedded noVNC

apps/server
  Bun API and MT5/Wine process supervisor

packages/shared
  Runtime status schemas and shared helpers

docker
  Xvfb, openbox, x11vnc, websockify, Wine, and Bun startup
```

Runtime processes:

- `Xvfb` provides the virtual Linux display.
- `openbox` manages windows inside the virtual desktop.
- `x11vnc` exposes the X display as VNC.
- `websockify` serves noVNC in the browser with heartbeat pings.
- Wine runs WebView2 setup, the MT5 installer, and `terminal64.exe`.

## Requirements

- Docker with Compose (v2).
- ~3–8 GB of free disk space for the image, Wine prefix, and MT5 data.
- RAM and CPU are not constrained by the Compose file — adjust via Docker
  resource limits if needed.

## Quick Start

Install dependencies and verify the app:

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

Build and run the image:

```bash
docker build --platform linux/amd64 -t linux-mt5 .
docker compose up -d
```

For hosts with legacy Compose:

```bash
docker-compose up -d --build
```

Open:

- Control UI: `http://localhost:17300`
- noVNC directly:
  `http://localhost:17080/vnc.html?autoconnect=1&resize=scale&path=websockify`

## Home Server Deployment

Set environment variables or create a `.env` file at the project root before
deploying:

```text
APP_PORT=17300
NOVNC_PORT=17080
MT5_DATA_DIR=/path/to/linux-mt5-data
PUBLIC_NOVNC_URL=http://<your-host-ip>:17080/vnc.html?autoconnect=1&resize=scale&path=websockify
```

Deploy to the target server (adjust host, user, and paths):

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude dist-types \
  ./ user@<your-host>:/opt/linux-mt5/

ssh user@<your-host> 'cd /opt/linux-mt5 && docker-compose up -d --build'
```

## First Run

1. Open the control UI.
2. Click `Install`.
3. Wait for the WebView2 and MetaTrader 5 installer flow to start.
4. Complete the MT5 installer inside the noVNC desktop.
5. Restart the container or click `Launch` after `terminal64.exe` is detected.

The Wine prefix is persisted at:

```text
/data/wine-prefix/.mt5
```

When using the default Compose file this is backed by the host directory
configured via `MT5_DATA_DIR`.

## Expert Advisors

After MT5 has launched once, the control UI exposes an `Expert Advisors`
upload panel. Uploads are written directly into the active terminal data
folder under `MQL5/Experts`, for example:

```text
/data/wine-prefix/.mt5/drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/<terminal-id>/MQL5/Experts
```

The upload endpoint accepts common EA-related files:

```text
.ex5 .mq5 .mqh .set .dll
```

If the terminal data folder is missing, launch MT5 once and retry the upload.
Restart MT5 after uploading compiled EAs if the Navigator does not refresh.

## Configuration

The project defaults to the HFM SA5 MT5 installer (`hfmarketssa5setup.exe`)
because it installs cleanly under Wine with no extra workarounds. This is just
the MT5 terminal — once installed you can log in with **any** broker account
or trading server. To use a different installer, set `MT5_INSTALLER_URL` to
your broker's MT5 download link.

Useful environment variables:

```text
APP_PORT=17300
NOVNC_PORT=17080
MT5_DATA_DIR=/path/to/linux-mt5-data
PUBLIC_NOVNC_URL=http://<your-host-ip>:17080/vnc.html?autoconnect=1&resize=scale&path=websockify
WEBSOCKIFY_HEARTBEAT_SECONDS=30
AUTO_LAUNCH_MT5=true
AUTO_LAUNCH_DELAY_MS=2500
MT5_WINEBOOT_TIMEOUT_MS=900000
MT5_WINECFG_TIMEOUT_MS=180000
MT5_WEBVIEW2_TIMEOUT_MS=600000
MT5_INSTALLER_URL=https://download.terminal.free/cdn/web/12040/mt5/hfmarketssa5setup.exe
WEBVIEW2_INSTALLER_URL=https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/f2910a1e-e5a6-4f17-b52d-7faf525d17f8/MicrosoftEdgeWebview2Setup.exe
```

## API

```text
GET  /api/status
GET  /api/runtime-config
GET  /api/mt5/experts
POST /api/mt5/experts
POST /api/mt5/install
POST /api/mt5/launch
POST /api/mt5/stop
POST /api/mt5/restart
```

## Operations Notes

Current benign runtime warnings:

- `Openbox-Message: Unable to find a valid menu file` means no desktop menu is
  configured. MT5 still runs.
- `Xlib: extension "DPMS" missing` is expected under Xvfb.
- PulseAudio may warn about running as root. Audio is not required for MT5.
- The installer may try to open an MQL5 welcome URL through `xdg-open`; this
  image intentionally does not include a browser.

Built-in safeguards:

- Docker `init: true` is enabled to reap Wine child processes.
- `SYS_PTRACE` and `seccomp=unconfined` are enabled because some MT5 installers
  use anti-debug checks that can misread Docker confinement.
- Wine anti-debug registry hardening runs before installer startup.
- EA uploads sanitize filenames and restrict accepted extensions.

## Security Notes

This is intended for trusted local-network use. It has no built-in browser auth
and no TLS termination. Do not expose this container directly to the public
internet. If it needs to be reachable outside the LAN, put it behind a reverse
proxy with authentication and TLS.

The project does not store broker credentials or automate trading account login.
Any account credentials entered into MT5 are handled by MT5/Wine inside the
persisted Docker volume.

## Future Improvements

- Add optional authentication for the control UI and EA upload endpoint.
- Add upload size limits, overwrite confirmation, and automatic backups for EA
  uploads.
- Add a terminal restart prompt after successful EA uploads.
- Add a health watchdog for `Xvfb`, `openbox`, `x11vnc`, `websockify`, and MT5.
- Clean stale X locks on startup before launching `Xvfb`.
- Add a lightweight full desktop environment such as XFCE or LXDE so popups,
  secondary windows, and basic file management are easier to access.
- Add a simple window switcher or window-list helper if keeping the minimal
  `openbox` desktop.
- Consider a `dockur/windows` backend using Windows 10 LTSC (`VERSION=10l`) if
  Wine compatibility becomes the limiting factor.
