# MT5 Dockerized

This repository contains two Docker approaches for running MetaTrader 5 from a
home server or any Linux host.

## Layout

```text
linux/
  Wine-based Linux MT5 desktop with Bun/React control UI and EA upload support.

windows/
  Windows 10 LTSC setup using dockur/windows (github.com/dockur/windows)
  for full Windows MT5 compatibility.
```

## Storage Requirements

| Setup   | Approximate Disk | Notes |
|---------|------------------|-------|
| Linux   | 3–8 GB           | Docker image (~2 GB) + Wine prefix + MT5 data |
| Windows | 12–20 GB         | Full Windows 10 LTSC install + MT5 data |

## Recommendation

Use the Windows setup for Expert Advisors, broker-specific installers, and full
desktop compatibility. Expert Advisors are **not** reliable under Wine — DLL
imports, anti-debug checks, and Windows-specific API calls used by most EAs
will fail. The Linux/Wine setup is useful as a lightweight terminal-only
fallback for charting and manual trading.

## Which MT5?

The Linux Compose file defaults to the HFM SA5 installer because it works
reliably under Wine without install-time issues. This is **just the MT5
application** — once installed you can log in with any broker or server.
Swap the installer by setting `MT5_INSTALLER_URL` to your preferred broker's
MT5 `.exe` download.

## Configuration

Both setups use environment variables for paths and ports. See the
`docker-compose.yml` and `.env.example` files in each directory. Set up a
`.env` file before starting any service.

## Getting Started

- **Linux/Wine**: See `linux/README.md`.
- **Windows 10 LTSC**: See `windows/README.md`. Note that a Windows password
  **must** be provided via `WINDOWS_PASSWORD` — the container will refuse to
  start without one.
