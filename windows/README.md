# Windows MT5

This setup uses [dockur/windows](https://github.com/dockur/windows) with
Windows 10 LTSC (`VERSION=10l`) for a full Windows MT5 runtime. Use this when Expert Advisors, DLL imports, broker
installers, or Windows desktop behavior are required.

## Requirements

- Host with Docker and Compose.
- KVM support available at `/dev/kvm`.
- ~12–20 GB of free disk space (Windows 10 LTSC install + MT5 data).
  The default virtual disk is `64G` in the Compose file — you can lower this
  after the initial Windows install has completed.
- A Windows password **must** be provided via `WINDOWS_PASSWORD` in your
  `.env` file or environment, otherwise the container will not start.
- RAM (`RAM_SIZE`), CPU cores (`CPU_CORES`), and disk size (`DISK_SIZE`)
  are configurable in `docker-compose.yml`.

Check KVM on the server:

```bash
ls -l /dev/kvm
```

## Configuration

Copy `windows/.env.example` to `windows/.env` and edit:

```text
WINDOWS_PASSWORD=<choose-a-strong-password>
WINDOWS_USERNAME=user
WINDOWS_WEB_PORT=18006
WINDOWS_RDP_PORT=13389
WINDOWS_DATA_DIR=/path/to/windows-mt5-data
WINDOWS_SHARED_DIR=/path/to/windows-mt5-shared
```

## Deploy

```bash
mkdir -p "$WINDOWS_DATA_DIR" "$WINDOWS_SHARED_DIR"
docker-compose up -d
```

Open the web console:

```text
http://<your-host-ip>:18006
```

RDP is exposed on:

```text
<your-host-ip>:13389
```

## MT5 Install

Download and install your broker's MT5 installer inside Windows. The Linux
setup defaults to the HFM SA5 build but that is not required — pick any
broker or server. Once installed you can log in with any account.

For HFM:

```text
https://download.terminal.free/cdn/web/12040/mt5/hfmarketssa5setup.exe
```

## Expert Advisors

Use the shared host folder for transfers (`WINDOWS_SHARED_DIR`).

It is mounted into the Windows VM as a shared directory by dockur/windows. Copy
EA files from the shared folder into the terminal data path inside Windows:

```text
C:\Users\<windows-user>\AppData\Roaming\MetaQuotes\Terminal\<terminal-id>\MQL5\Experts
```

Restart MT5 or refresh Navigator after copying EAs.

## Notes

- Keep the web console and RDP on the trusted LAN or behind authenticated access.
- The Windows disk persists in `WINDOWS_DATA_DIR`.
- Snapshots/backups should include both `WINDOWS_DATA_DIR` and
  `WINDOWS_SHARED_DIR` if you keep EA files there.
