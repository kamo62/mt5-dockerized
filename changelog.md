# Changelog

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
