# Handoff

Updated: 2026-11-13 08:48 SAST on MacBookPro

## State

- Branch: `main`.
- Release code: `d458e5e Merge reviewed Control Room 3.1.0 release`, including
  implementation commit `31faba0`. The merged tree exactly matches `31faba0`.
- Pushed: release code and checkpoint `79c1f8a` are on origin/main. This final
  deployment record follows that checkpoint in its own documentation commit.
  PR [#5](https://github.com/kamo62/mt5-dockerized/pull/5) was already merged as
  `35aa7d2`; the release preserves it and `006b96f`. No history was rewritten.
- Dirty: no uncommitted code. This file is the final delivery record. User
  explicitly authorised deployment and direct push to main on 2026-11-13,
  overriding the normal PR-only delivery policy for this task.
- Preserve `006b96f`: another actor committed the earlier in-flight work. The
  current changes deliberately build on it rather than reverting it.

## Done in the committed release

- Added guarded startup GET/POST integration and next-launch persistence at
  `/data/control-room/startup.json`. Save validates and writes privately without
  invoking Wine, restarting MT5, attaching an EA or changing active mode.
- Cold launches honour a saved restore/custom choice ahead of environment
  settings. Custom selects either an existing profile or one chart/EA/preset.
  INI control-character injection, mixed targets, traversal, missing files and
  symlinks are rejected. Generated launch files preserve trading permissions.
- Restore/custom cold launch uses the backed-up native `[StartUp]` cleanup from
  the base commit. It never hot-edits configuration owned by a running terminal.
  Existing saved charts, including old broker symbols, are not remapped.
- Launch of an already running terminal is idempotent, including corrupt future
  settings. Installer-left-running terminals are adopted, not restarted.
- Desktop/Files/Session navigation, secondary Diagnostics, persistent panels and
  real browser fullscreen are integrated. The desktop fills the available stage;
  denied fullscreen uses an explicitly labelled expanded view.
- Session refreshes choices and legacy-removal status while retaining dirty
  drafts. Legacy environment-managed permission behaviour is clearly separated
  from the saved Control Room policy. Save is above the detailed explanations.
- Files shortcuts match modern MT5 profile/preset paths. Staged review hides
  Select-step controls and irrelevant options; account/replacement guards remain.
- Nested EA journal matching recognises Windows paths and basenames. A saved UI
  restore clears the overridden environment EA monitor on a later cold launch.
  Environment-only restore retains its pre-existing journal subscription.
- Source version and changelog updated to `3.1.0` minor, dated 2026-11-13.
- Built and deployed `linux-mt5:3.1.0-d458e5e` on the home server. The image
  revision is `d458e5e71bc23c1b5a62655dc535cd482710e4e7`, image ID
  `sha256:410b30390767caf1d8ddd3c8e46ae071f8dcebf617fbbfa800915e8ea4139cf4`.
  The private Compose configuration preserves the old effective environment,
  hostname, data mount, ports and network. Only image/OCI labels changed.
- MT5 closed gracefully before its container was stopped. A complete private
  stopped-data archive was created and checked before recreation. The live cold
  launch removed native `[StartUp]` with an exact private migration backup.

Release files are committed. `git show --stat 31faba0` identifies the integration
and review-fix paths. The earlier import/startup work in `006b96f` is preserved.

## Verified vs unverified

- Verified: `bun test` in `linux/` passed 63 tests, 0 failures, 290 assertions.
- Verified: `bun run typecheck`, `bun run lint`, `bun run build` and
  `git diff --check` passed. After the final text-only Apply-label/comment fix,
  scoped ESLint, web production build and protected-transfer render passed.
- Verified: isolated real HTTP startup smoke passes guards, no-store, private
  persistence across API recreation, secret-free DTOs, invalid-input rejection
  and Save without Wine/native-config mutations. The harness now creates a fresh
  disposable data root each run; its initial rerun failed because it reused a
  previously saved fixture, not because of a product failure.
- Verified: 18 isolated CDP cases cover 390/728/1160px layouts, persistent iframe
  and drafts, Save-only startup POST, confirmation cancellation, metadata refresh,
  protected transfer options and denied-fullscreen fallback. The successful
  fullscreen case uses the actual Chromium API with trusted CDP input and checks
  viewport sizing, iframe identity and exiting for Clipboard.
- Verified: Council completed two rounds, all seats at high reasoning effort,
  with no remaining material blocker for source/UI scope:

  | Delegate | Round 1 | Round 2 |
  | --- | --- | --- |
  | Claude Opus 5.5 | 7.5/10 | 9/10 |
  | GPT-6.1 Sol | 8.5/10 | 9/10 |
  | Gemini 4 Carbon | 8/10 | 9.5/10 |

  Carbon's first attempt exceeded its ten-image limit; the same model completed
  a bounded retry. No council seat was substituted. Final optional Apply wording
  and stale-comment corrections were made locally without another general audit.
- Verified: the rebuilt Linux image passed an isolated startup/API/save/static
  asset smoke test with no live mounts, published ports or network access.
- Verified: real cold launch resumed and authorised the same saved broker account
  and synchronised with the broker, without password re-entry. Native `[StartUp]`
  is absent, its exact backup and restore launch copy are mode 0600. A baseline
  comparison covered 71 persisted files: no missing files, unchanged chart/EA/
  preset contents. Only `Config/accounts.dat` changed during MT5 authorisation.
- Verified: live startup GET enforces its header and returns restore mode with
  `legacyStartup=false`; the served production bundle matches the built image.
  Control API health is 200, Docker reports healthy, noVNC HTTP is 200 and raw VNC
  returns an RFB handshake. Detailed redacted results are saved server-side at
  `/home/kamo/mt5-releases/3.1.0-d458e5e/verification.json` (private mode 0600).
- Unverified: a custom profile/chart/EA/preset policy has not been applied to the
  live terminal. Save was checked in isolation only; the live choice remains
  environment-default restore. No EA was compiled, installed or manually attached.
- Unverified: fullscreen/scaling on the operator's monitor with live noVNC and
  Escape while focus is inside its cross-origin iframe. Chromium API evidence is
  not live MT5 or manual-browser proof.
- Live state: `HF-MT5` runs 3.1.0, hostname `1f1e2dbeaaa9`, bind
  `/var/lib/ssd/mt5-data:/data`, restore mode, unchanged 1440x900 display and VNC
  transport. No active/interrupted import existed at deployment. Preflight health
  was 503 from a recorded TelegramTC symbol synchronisation failure; post-launch
  health is 200. This is not proof every EA is operating: `EdgeEA` has a new
  attachment record, but configured `TelegramTC_EA_v1.67` remains unverified with
  no new attachment/failure record. It was not reattached or remapped to conceal
  the old broker-symbol problem. Existing saved chart and EA/preset bytes match
  the stopped-session baseline.

## Evidence and resume

Evidence is local and temporary, not committed:
`/private/var/folders/b6/87d2msqd6fdbtcddcw5k8gbw0000gn/T/opencode/mt5-startup-review-PYVEwT/`.
Read `REVIEW-EVIDENCE.md`, `cdp-results.json`, `api-smoke-results.json` and the PNGs.
`round-1/` preserves prior screenshots. `render-results.txt` is an obsolete CLI
prototype; the CDP results supersede it. `review-gallery.html` is a read-only
presentation of the scores and selected isolated screens.

```bash
cd /Users/kamogelo/Code/linux-mt5
git status --short --branch
git diff --stat
git diff --check
```

Delivery is complete. Refresh the Control Room page to load the new UI, then
manually verify Full screen/noVNC scaling in the operator's browser. An EA attach,
broker-symbol change, custom policy or EA compilation requires a separate explicit
request; do not make those changes merely to turn an unverified journal green.

Server SSH: `ssh -o BatchMode=yes 192.168.0.100` as configured user `kamo`.
Docker/Compose/buildx are available. Non-interactive sudo is unavailable; Docker
can perform the private stopped-data backup through an explicitly scoped bind.
Current private config: `/home/kamo/mt5-releases/3.1.0-d458e5e/deploy.compose.json`.
Rollback config: `/home/kamo/mt5-releases/3.0.0-b652396/deploy.compose.json`.
Both contain environment secrets: never print or copy them into the repository.
The prior image `linux-mt5:3.0.0-b652396` is retained. The complete stopped-data
backup is `/var/lib/ssd/mt5-deploy-backups/3.1.0-d458e5e/data.tar` (4,558,499,840
bytes, mode 0600), with `data.tar.sha256`, `baseline.json` and the original native
INI in the same private directory. No backup restore was required.

Background jobs still running from this task: none apart from the intended live
production container. Disposable Chrome/API/smoke/backup containers were stopped;
council delegates completed. No PR checks or review are being watched.
