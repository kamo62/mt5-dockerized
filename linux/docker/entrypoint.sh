#!/usr/bin/env bash
set -uo pipefail

export DISPLAY="${DISPLAY_ID:-:99}"
export HOME="${HOME:-/data/home}"
export MT5_DATA_DIR="${MT5_DATA_DIR:-/data}"
export WINEPREFIX="${WINEPREFIX:-${MT5_DATA_DIR}/wine-prefix/.mt5}"
export ENABLE_AUDIO="${ENABLE_AUDIO:-false}"

mkdir -p "$HOME" "$MT5_DATA_DIR/cache" "$MT5_DATA_DIR/wine-prefix" "$MT5_DATA_DIR/exports"

display_number="${DISPLAY#*:}"
display_number="${display_number%%.*}"
display_socket="/tmp/.X11-unix/X${display_number}"

# Remove stale X locks/sockets left by a previous run so Xvfb can rebind the
# display after a `docker restart` (otherwise: "Server is already active for
# display N" -> Xvfb dies -> x11vnc/openbox die -> dead desktop, live API).
cleanup_x_locks() {
  rm -f "/tmp/.X${display_number}-lock" "$display_socket" 2>/dev/null || true
}

case "${ENABLE_AUDIO,,}" in
  1 | true | yes | on)
    audio_enabled=true
    ;;
  *)
    audio_enabled=false
    ;;
esac

if [ "$audio_enabled" = "true" ]; then
  export PULSE_SERVER="${PULSE_SERVER:-unix:/tmp/pulse/native}"
  mkdir -p /tmp/pulse
  rm -f /tmp/pulse/native

  pulseaudio \
    --daemonize=yes \
    --exit-idle-time=-1 \
    --log-target=stderr \
    --load="module-native-protocol-unix socket=/tmp/pulse/native auth-anonymous=1" || true

  pulse_ready=false
  for _ in $(seq 1 30); do
    if pactl --server="$PULSE_SERVER" info >/dev/null 2>&1; then
      pulse_ready=true
      break
    fi
    sleep 0.2
  done

  if [ "$pulse_ready" != true ]; then
    echo "PulseAudio did not become ready; continuing without blocking MT5 desktop startup." >&2
  fi
else
  unset PULSE_SERVER
  echo "PulseAudio disabled; MT5 desktop will run without container audio." >&2
fi

# --- desktop stack (each component restartable by the watchdog) ---

start_xvfb() {
  cleanup_x_locks
  Xvfb "$DISPLAY" -screen 0 "${DESKTOP_WIDTH:-1920}x${DESKTOP_HEIGHT:-1080}x24" -nolisten tcp &
  XVFB_PID=$!
}

wait_for_display() {
  for _ in $(seq 1 50); do
    if [ -S "$display_socket" ] && kill -0 "$XVFB_PID" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
      return 1
    fi
    sleep 0.2
  done
  [ -S "$display_socket" ]
}

start_openbox() { openbox & OPENBOX_PID=$!; }
start_x11vnc() {
  x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -quiet &
  X11VNC_PID=$!
}
start_websockify() {
  websockify --web=/usr/share/novnc/ --heartbeat="${WEBSOCKIFY_HEARTBEAT_SECONDS:-30}" 6080 localhost:5900 &
  WEBSOCKIFY_PID=$!
}

start_display_stack() {
  start_xvfb
  if ! wait_for_display; then
    echo "Xvfb failed to become ready on $DISPLAY" >&2
    return 1
  fi
  start_openbox
  start_x11vnc
  start_websockify
}

# --- optional S3 sync of exported tick CSVs (turned on via Compose) ---

s3_enabled() {
  [ -n "${S3_URI:-}" ] || return 1
  case "${S3_SYNC_ENABLED:-false}" in
    1 | true | yes | on | TRUE | True | YES | ON) return 0 ;;
    *) return 1 ;;
  esac
}

s3_sync_loop() {
  local src="${S3_SYNC_SOURCE_DIR:-$MT5_DATA_DIR/exports}"
  local interval="${S3_SYNC_INTERVAL_SECONDS:-60}"
  local settle="${S3_SYNC_SETTLE_SECONDS:-60}"
  mkdir -p "$src"
  while true; do
    # ponytail: defer the whole sync if any *.csv was modified within the
    # settle window, so a file still being written is never uploaded partial.
    # aws s3 sync then mirrors *.csv one-way (no --delete) and skips unchanged
    # files. Coarse but correct; upgrade path is per-file settle tracking.
    # Uses the EC2 instance role when AWS_* env vars are unset.
    if find "$src" -type f -name '*.csv' -newermt "-${settle} seconds" 2>/dev/null | grep -q .; then
      echo "s3-sync: csv still being written; deferring this cycle"
    else
      aws s3 sync "$src" "$S3_URI" --exclude "*" --include "*.csv" --no-progress 2>&1 \
        | sed 's/^/s3-sync: /'
    fi
    sleep "$interval"
  done
}
start_s3_sync() { s3_sync_loop & S3SYNC_PID=$!; }

# --- boot ---

if ! start_display_stack; then
  echo "Initial display stack failed to start" >&2
  exit 1
fi

bun --cwd /app/apps/server src/index.ts &
BUN_PID=$!

if s3_enabled; then
  echo "S3 sync enabled -> ${S3_URI} every ${S3_SYNC_INTERVAL_SECONDS:-60}s (source: ${S3_SYNC_SOURCE_DIR:-$MT5_DATA_DIR/exports})."
  start_s3_sync
else
  echo "S3 sync disabled. Set S3_SYNC_ENABLED=true and S3_URI to enable."
fi

# --- watchdog: restart dead desktop components, exit if the API dies ---
# `wait <pid>` after a child dies reaps the zombie; tini (init: true) backstops.
while true; do
  sleep 3

  if ! kill -0 "$BUN_PID" >/dev/null 2>&1; then
    wait "$BUN_PID" 2>/dev/null
    code=$?
    echo "API server exited (code ${code}); stopping container." >&2
    exit "$code"
  fi

  if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
    wait "$XVFB_PID" 2>/dev/null
    echo "Xvfb died; restarting the whole display stack." >&2
    for pid in "${OPENBOX_PID:-}" "${X11VNC_PID:-}" "${WEBSOCKIFY_PID:-}"; do
      [ -n "$pid" ] && kill "$pid" >/dev/null 2>&1
    done
    for pid in "${OPENBOX_PID:-}" "${X11VNC_PID:-}" "${WEBSOCKIFY_PID:-}"; do
      [ -n "$pid" ] && wait "$pid" 2>/dev/null
    done
    start_display_stack || echo "display stack restart failed; will retry." >&2
    continue
  fi

  if ! kill -0 "$OPENBOX_PID" >/dev/null 2>&1; then
    wait "$OPENBOX_PID" 2>/dev/null
    echo "openbox died; restarting." >&2
    start_openbox
  fi
  if ! kill -0 "$X11VNC_PID" >/dev/null 2>&1; then
    wait "$X11VNC_PID" 2>/dev/null
    echo "x11vnc died; restarting." >&2
    start_x11vnc
  fi
  if ! kill -0 "$WEBSOCKIFY_PID" >/dev/null 2>&1; then
    wait "$WEBSOCKIFY_PID" 2>/dev/null
    echo "websockify died; restarting." >&2
    start_websockify
  fi

  if s3_enabled && [ -n "${S3SYNC_PID:-}" ] && ! kill -0 "$S3SYNC_PID" >/dev/null 2>&1; then
    wait "$S3SYNC_PID" 2>/dev/null
    echo "s3 sync loop died; restarting." >&2
    start_s3_sync
  fi
done
