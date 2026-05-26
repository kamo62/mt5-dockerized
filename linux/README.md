# Linux MT5

Linux MT5 is a Docker-hosted browser desktop for running MetaTrader 5 on Linux
through Wine. It exposes the virtual desktop through noVNC and provides a small
Bun/React control surface for first-run installation, launching, stopping, and
restarting MT5.

This project follows the official MetaQuotes Linux approach: MetaTrader 5 runs
on Linux through Wine, and the MT5 installer remains a GUI installer. The Docker
image therefore installs Wine and the desktop runtime, while the MT5 installer
runs on first use inside the browser desktop and persists into a Docker volume.

![Linux MT5 control UI](../docs/control-ui.png)

*The control surface: install / launch / stop / restart, runtime status, EA
upload, the embedded noVNC desktop (blurred here), and a live runtime log.*

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

Only Docker with Compose v2 is required to run the container — the image build
installs Bun, Wine, and the desktop runtime itself. The Bun steps below are
**optional** local checks for development before building the image, and need
Bun on the host only if you run them:

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
- Raw VNC/RFB for local stream tools: `localhost:15900`

## Home Server Deployment

Set environment variables, or create a `.env` file in `linux/` next to
`docker-compose.yml` (that is where Docker Compose reads it from), before
deploying:

```text
APP_PORT=17300
NOVNC_PORT=17080
VNC_PORT=15900
LINUX_MT5_CONTAINER_NAME=linux-mt5
MT5_DATA_DIR=/path/to/linux-mt5-data
PUBLIC_NOVNC_URL=http://<your-host-ip>:17080/vnc.html?autoconnect=1&resize=scale&path=websockify
```

Deploy to the target server (adjust host, user, and paths):

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude dist-types \
  ./ user@<your-host>:/opt/linux-mt5/

ssh user@<your-host> 'cd /opt/linux-mt5 && docker-compose up -d --build'
```

## Streaming With rdp-stream-studio

The container publishes raw VNC/RFB on `VNC_PORT` for local stream tools. Point
`rdp-stream-studio` at this raw VNC endpoint, not at the noVNC browser URL:

```text
Source type: VNC
Host: <your-host-ip>
Port: 15900
Password: leave empty
```

For the home server used during this setup, that means:

```text
Host: 192.168.0.100
Port: 15900
```

The noVNC URL on `NOVNC_PORT` is still useful for browser control, but it is an
HTTP/WebSocket wrapper around VNC. TigerVNC and other VNC clients need the raw
`host:port` endpoint.

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

Expert Advisors can run under Wine when they are custom/non-DRM builds and do
not depend on unsupported Windows APIs or CPU features unavailable on the host.
Commercial MQL5 Market EAs, EAs with native DLL dependencies, and binaries
compiled for newer CPU instruction sets may still fail. Use the Windows setup
(`../windows/`) only when you really need those Windows-specific behaviours,
because the Windows container uses gigabytes of RAM rather than the lighter
Linux/Wine footprint.

The upload endpoint is still available for compiled indicators and scripts
(`.ex5`). Files are written into the active terminal data folder under
`MQL5/Experts`:

```text
/data/wine-prefix/.mt5/drive_c/users/root/AppData/Roaming/MetaQuotes/Terminal/<terminal-id>/MQL5/Experts
/data/wine-prefix/.mt5/drive_c/Program Files/MetaTrader 5/MQL5/Experts
```

The official MetaQuotes installer can run in a portable-style layout where
`Config/common.ini` and `MQL5/Experts` live under the install folder in
`Program Files`. Broker-branded installs may instead use the roaming MetaQuotes
terminal folder. The app checks both layouts.

The upload endpoint accepts common EA-related files:

```text
.ex5 .mq5 .mqh .set .dll
```

In the control UI, the EA upload panel shows the detected `Target:` path before
and after upload. That is the exact folder the app writes into.

If the terminal data folder is missing, the upload button cannot resolve a
target yet. Launch MT5 once from the control UI, let MetaTrader finish creating
its `MQL5/Experts` folders, then retry the upload. After that first run, the
upload button should work normally and show the detected `Target:` path.
Restart MT5 after uploading compiled EAs if the Navigator does not refresh.

### Managed common.ini and EA Presets

Set `MT5_STARTUP_CONFIG=true` to have the container update the active
terminal's persisted `config/common.ini` before launching MT5. The update keeps
account login, server, encrypted WebRequest allow-list, and other terminal state
inside the mounted Wine prefix, then overlays the low-resource chart settings
and optional EA startup settings controlled by Compose.

The shared `docker-compose.yml` intentionally does not include these optional
EA and `common.ini` variables, because they are account- and EA-specific. Put
them in a local `docker-compose.override.yml` file next to `docker-compose.yml`.
That file is ignored by git.

No separate startup INI is created. The app launches `terminal64.exe` with
MetaTrader's `/config:` flag pointing at that active `common.ini`, which is what
causes MetaTrader to execute the `[StartUp]` block. Empty startup values are
ignored. That means the container can manage resource settings without adding a
`[StartUp]` block, and EA autoload only turns on when `MT5_STARTUP_EXPERT` is
set. Any existing `[StartUp]` block is replaced by the Compose-managed settings
so stale EA autoload values do not linger.

Example `docker-compose.override.yml` for auto-loading an EA:

```yaml
services:
  linux-mt5:
    environment:
      MT5_STARTUP_CONFIG: "true"
      MT5_STARTUP_EXPERT: "TelegramTC_EA"
      MT5_STARTUP_SYMBOL: "XAUUSDr"
      MT5_STARTUP_PERIOD: "H1"
      MT5_STARTUP_PRESET: "TelegramTC_EA.set"
      MT5_PRELOAD_CHARTS: "0"
      MT5_EA_BackendBaseUrl: "http://<HOST-IP>:18787/api"
      MT5_EA_LinkCode: "<link-code-from-the-app>"
      MT5_EA_PollSeconds: "1"
      MT5_EA_HeartbeatSeconds: "5"
```

`MaxBars` is intentionally pinned to `5000` when startup config management is
enabled. Any environment variable beginning with `MT5_EA_` is written into the
generated EA preset after the prefix is removed. For example,
`MT5_EA_LinkCode` becomes `LinkCode=...` in
`MQL5/Presets/TelegramTC_EA.set`.

The example above is for one specific EA (`TelegramTC_EA`); its `MT5_EA_*` lines
are that EA's own inputs. To autoload **your own** EA instead:

1. Upload or mount the compiled `.ex5` into `MQL5/Experts`.
2. Set `MT5_STARTUP_EXPERT` to the file name without `.ex5`.
3. Set `MT5_STARTUP_SYMBOL` and `MT5_STARTUP_PERIOD` for the chart that should
   open.
4. Set `MT5_STARTUP_PRESET` if the EA should load a preset file.
5. Add one local override entry per EA input using `MT5_EA_<InputName>` (the
   prefix is stripped, so `MT5_EA_LinkCode` becomes `LinkCode=` in the preset).
6. Recreate the container with `docker compose up -d` to apply the new
   `[StartUp]` block.

## Configuration

The project defaults to the HFM SA5 MT5 installer (`hfmarketssa5setup.exe`)
because it installs cleanly under Wine with no extra workarounds. This is just
the MT5 terminal — once installed you can log in with **any** broker account
or trading server. To use a different installer, set `MT5_INSTALLER_URL` to
your broker's MT5 download link.

For broker-neutral testing, use the official MetaQuotes installer URL:

```text
MT5_INSTALLER_URL=https://download.terminal.free/cdn/web/metaquotes.ltd/mt5/mt5setup.exe
```

The image uses Debian Bookworm's distro Wine with a `win64` Wine prefix. During
this setup, the newer Debian Trixie/WineHQ staging combination repeatedly hung
at `wineboot --init` when creating a fresh prefix.

Useful environment variables:

```text
APP_PORT=17300
NOVNC_PORT=17080
VNC_PORT=15900
LINUX_MT5_CONTAINER_NAME=linux-mt5
MT5_DATA_DIR=/path/to/linux-mt5-data
PUBLIC_NOVNC_URL=http://<your-host-ip>:17080/vnc.html?autoconnect=1&resize=scale&path=websockify
WEBSOCKIFY_HEARTBEAT_SECONDS=30
ENABLE_AUDIO=false
AUTO_LAUNCH_MT5=true
AUTO_LAUNCH_DELAY_MS=2500
MT5_WINEBOOT_TIMEOUT_MS=900000
MT5_WINECFG_TIMEOUT_MS=180000
MT5_WEBVIEW2_TIMEOUT_MS=600000
MT5_INSTALLER_URL=https://download.terminal.free/cdn/web/12040/mt5/hfmarketssa5setup.exe
MT5_INSTALL_WEBVIEW2=false
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
- Audio is disabled by default because MT5 and this EA do not need it. Set
  `ENABLE_AUDIO=true` only if you need PulseAudio inside the container.
- WebView2 install is skipped by default because the EdgeUpdate bootstrapper can
  hang under Wine. Set `MT5_INSTALL_WEBVIEW2=true` only if a workflow needs
  MT5's embedded web surfaces.
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
and no TLS termination. Raw VNC is also published without a VNC password because
the local streaming workflow needs direct desktop capture. Do not expose this
container directly to the public internet. If it needs to be reachable outside
the LAN, put it behind a protected network boundary and add authentication/TLS
for the browser surfaces.

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
