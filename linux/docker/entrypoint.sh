#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY_ID:-:99}"
export HOME="${HOME:-/data/home}"
export MT5_DATA_DIR="${MT5_DATA_DIR:-/data}"
export WINEPREFIX="${WINEPREFIX:-${MT5_DATA_DIR}/wine-prefix/.mt5}"
export ENABLE_AUDIO="${ENABLE_AUDIO:-false}"

mkdir -p "$HOME" "$MT5_DATA_DIR/cache" "$MT5_DATA_DIR/wine-prefix"

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

Xvfb "$DISPLAY" -screen 0 "${DESKTOP_WIDTH:-1920}x${DESKTOP_HEIGHT:-1080}x24" -nolisten tcp &
xvfb_pid=$!

display_number="${DISPLAY#*:}"
display_number="${display_number%%.*}"
display_socket="/tmp/.X11-unix/X${display_number}"

for _ in $(seq 1 50); do
  if [ -S "$display_socket" ] && kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    echo "Xvfb exited before display $DISPLAY was ready" >&2
    exit 1
  fi

  sleep 0.2
done

if [ ! -S "$display_socket" ]; then
  echo "Timed out waiting for Xvfb display socket $display_socket" >&2
  exit 1
fi

openbox &
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -quiet &
websockify --web=/usr/share/novnc/ --heartbeat="${WEBSOCKIFY_HEARTBEAT_SECONDS:-30}" 6080 localhost:5900 &

exec bun --cwd /app/apps/server src/index.ts
