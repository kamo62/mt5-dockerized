# Changelog

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
