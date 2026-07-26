# Bug: the EA is lost on container reset

**Reported:** 2026-07-20
**Severity:** High — silent. A live copy-trading account stops being managed and nothing says so.
**Version:** linux-mt5 1.3.0

## What happens

After the MT5 container resets, the attached Expert Advisor is gone. The terminal comes back up and
trades normally by hand, but the EA is no longer running on a chart, so anything that depends on it
stops without warning.

Observed on the HF Markets account (`54945785`) on 2026-07-20: the EA last reported at **09:03 UTC**
and was still silent **145 minutes later** at 11:27. During that window the account was clearly
alive — its balance moved from R424.37 to R435.74 — so the terminal was up and trading. Only the EA
was missing. A second account in the same setup (Trive, `3049603`) kept reporting normally
throughout, which points at per-container reset behaviour rather than a network or backend fault.

## Why it matters

The EA is the only channel through which the consuming system (telegram-tc) sees or acts on the
account. While it is detached:

- No heartbeats, no price snapshots, no position or order reporting.
- No server-side take-profit management for open trades on that account.
- Any signal routed to the account queues but does not execute; on reconnect it may execute late
  against a stale view of the market.
- The consuming dashboard still displays the account as **online**, because its heartbeat status is
  set on receipt and never aged out. (That staleness is a bug in the consumer and is tracked there;
  it is what makes this one invisible rather than merely annoying.)

The net effect is an account that looks healthy and is completely unmanaged.

## Reproduction

1. Attach the EA to a chart in the containerised terminal and confirm it is reporting.
2. Reset/recreate the container (`/code/linux-mt5`).
3. Terminal returns, account works normally by hand.
4. The EA is no longer attached; no further reports are emitted. Nothing surfaces an error.

## Notes for whoever picks this up

The repo already has the machinery to fix this — it looks configured-but-unused rather than missing.
`linux/apps/server/src/mt5-startup-config.ts` builds a startup config from environment variables and
can generate an EA preset and a chart to attach at launch:

- `MT5_STARTUP_CONFIG` — master switch, currently defaults to **false**
- `MT5_STARTUP_EXPERT` — expert name to attach
- `MT5_STARTUP_SYMBOL`, `MT5_STARTUP_PERIOD` (default `H1`)
- `MT5_STARTUP_PRESET` — preset filename
- `MT5_EA_*` — any EA input, passed through with the prefix stripped

Worth checking, in roughly this order:

1. Whether `MT5_STARTUP_CONFIG` is enabled in the deployed environment at all. If it defaults off,
   the auto-attach never runs and every reset needs a manual reattach.
2. Whether the compiled `.ex5` itself survives a reset. `linux/docker-compose.yml` mounts only
   `${MT5_DATA_DIR:-./linux-mt5-data}:/data`, and `WINEPREFIX` lives under that path — so confirm the
   terminal's `MQL5/Experts` directory genuinely resolves inside the mounted volume and is not being
   recreated from the image on reset.
3. Whether chart/EA attachment state (the terminal's chart profile) persists, or whether only the
   binary does. Persisting the `.ex5` but not the attachment still leaves the EA not running.

A fix should end with: reset the container, and within a minute the EA is attached and reporting
again with no human step. Ideally the container should also log loudly if startup config is enabled
but the expert could not be attached, so a failure is visible rather than silent.

## Related

The consuming system (telegram-tc) is adding an EA version/capability handshake in its v1.50
release. Once that ships, an account whose EA is missing or running an older compiled build will be
detected and held rather than sent commands it cannot honour. That makes this bug detectable, but it
does not fix it — a reset still leaves the account unmanaged until the EA is back.
