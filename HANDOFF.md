# Handoff

Updated: 2026-11-13 08:36 SAST on MacBookPro

## State

- Branch: `main`.
- Release code: `d458e5e Merge reviewed Control Room 3.1.0 release`, including
  implementation commit `31faba0`. The merged tree exactly matches `31faba0`.
- Remote state at this checkpoint: origin/main is `35aa7d2`, the merge of PR
  [#5](https://github.com/kamo62/mt5-dockerized/pull/5). The release merge preserves
  it and `006b96f`; no history was rewritten. Push of this handoff and release is
  the next action before building the deployment image.
- Dirty: only this handoff awaits its separate commit. All reviewed code is
  committed. User explicitly authorised deployment and direct push to main on
  2026-11-13, overriding the normal PR-only delivery policy for this task.
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
- Unverified: native MT5 honouring the new profile/chart/EA/preset launch copy,
  private backup/removal on the live prefix and account/profile/EA retention after
  that cold launch. No EA was compiled, installed or deployed.
- Unverified: fullscreen/scaling on the operator's monitor with live noVNC and
  Escape while focus is inside its cross-origin iframe. Chromium API evidence is
  not live MT5 or manual-browser proof.
- Fresh preflight: live `HF-MT5` still runs `linux-mt5:3.0.0-b652396`, hostname
  `1f1e2dbeaaa9`, bind `/var/lib/ssd/mt5-data:/data`, restore mode and 1440x900
  display. Terminal is running; health is already 503 from the existing EA symbol
  synchronisation failure. No active or interrupted import exists. The native
  legacy block remains pending the authorised deployment and safe cold launch.
  VNC remains the transport. No live mutation has happened at this checkpoint.

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

Next: push main normally, archive committed Linux source to the server, rebuild
image `linux-mt5:3.1.0-d458e5e`, then perform a backed-up cold deployment. Derive a
private Compose file from the current one and change only image; retain hostname,
mount, environment, ports and network. Build before downtime. Gracefully stop
MT5, stop the old container and snapshot the complete data directory before
recreating it. Keep the prior image and configuration for rollback. Validate the
private Compose file without printing its environment values. Verify new image
revision, UI assets, guarded startup GET, terminal authorisation/synchronisation,
native startup removal/backup and account/profile/chart/EA preservation. Do not
attach/recompile/remap an EA to hide the pre-existing symbol failure.

Server SSH: `ssh -o BatchMode=yes 192.168.0.100` as configured user `kamo`.
Docker/Compose/buildx are available. Non-interactive sudo is unavailable; Docker
can perform the private stopped-data backup through an explicitly scoped bind.
Previous private config: `/home/kamo/mt5-releases/3.0.0-b652396/deploy.compose.json`.
It contains environment secrets: never print or copy it into the repository.

Background jobs still running from this task: none. Disposable Chrome and API
processes were stopped; council delegates completed. Deployment is in progress
at the pre-build checkpoint; live MT5 is still running unchanged.
