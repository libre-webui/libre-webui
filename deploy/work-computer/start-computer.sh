#!/bin/sh
# Libre Work Computer — GUI session bootstrap.
#
# Starts a virtual display, a minimal window manager, Chromium, and a
# localhost-only VNC server bridged to a WebSocket. Idempotent: safe to
# invoke again on a container that already has a session (exits 0).
#
# Everything binds to loopback inside the container; the backend reaches
# websockify over the Docker network and re-authenticates every viewer.
set -eu

DISPLAY_NUM="${LIBRE_COMPUTER_DISPLAY:-1}"
SCREEN_GEOMETRY="${LIBRE_COMPUTER_GEOMETRY:-1280x800x24}"
VNC_PORT="${LIBRE_COMPUTER_VNC_PORT:-5900}"
WS_PORT="${LIBRE_COMPUTER_WS_PORT:-6080}"
AUDIO_WS_PORT="${LIBRE_COMPUTER_AUDIO_WS_PORT:-6081}"
AUDIO_TCP_PORT="${LIBRE_COMPUTER_AUDIO_TCP_PORT:-4713}"
AUDIO_RATE=44100
AUDIO_CHANNELS=2
STATE_DIR="${LIBRE_COMPUTER_STATE_DIR:-/tmp/libre-computer}"
PROFILE_DIR="${LIBRE_COMPUTER_PROFILE_DIR:-/workspace/.browser-profile}"

mkdir -p "$STATE_DIR" "$PROFILE_DIR"

if [ -f "$STATE_DIR/websockify.pid" ] \
  && kill -0 "$(cat "$STATE_DIR/websockify.pid")" 2>/dev/null; then
  echo "computer session already running"
  exit 0
fi

export DISPLAY=":${DISPLAY_NUM}"

Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp &
echo $! > "$STATE_DIR/xvfb.pid"

# Wait for the display socket before starting clients.
tries=0
while [ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  tries=$((tries + 1))
  [ "$tries" -gt 50 ] && { echo "Xvfb did not come up" >&2; exit 1; }
  sleep 0.1
done

# Openbox has no bar of its own; tint2 provides the dock (launchers,
# running apps, clock) bottom-center over the wallpaper.
openbox >/dev/null 2>&1 &
echo $! > "$STATE_DIR/openbox.pid"

WALLPAPER="/usr/local/share/libre-computer/wallpaper.png"
if [ -f "$WALLPAPER" ]; then
  sleep 0.3
  display -window root "$WALLPAPER" >/dev/null 2>&1 &
  echo $! > "$STATE_DIR/wallpaper.pid"
fi

XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}" \
  tint2 -c /usr/local/share/libre-computer/tint2rc >/dev/null 2>&1 &
echo $! > "$STATE_DIR/tint2.pid"

# Audio: PulseAudio with a null sink is the container's "sound card".
# Chromium plays into it; the sink's monitor is captured as raw PCM and
# served, one capture per connection, over a second websockify bridge.
export XDG_RUNTIME_DIR="$STATE_DIR/runtime"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=file:"$STATE_DIR/pulseaudio.log" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pactl info >/dev/null 2>&1 && break
  sleep 0.2
done
pactl load-module module-null-sink sink_name=libre \
  sink_properties=device.description=LibreOutput >/dev/null 2>&1 || true
pactl set-default-sink libre >/dev/null 2>&1 || true

socat "TCP-LISTEN:${AUDIO_TCP_PORT},bind=127.0.0.1,reuseaddr,fork" \
  EXEC:"parec -d libre.monitor --format=s16le --rate=${AUDIO_RATE} --channels=${AUDIO_CHANNELS} --raw" \
  >/dev/null 2>&1 &
echo $! > "$STATE_DIR/audio-capture.pid"

websockify --daemon "0.0.0.0:${AUDIO_WS_PORT}" "127.0.0.1:${AUDIO_TCP_PORT}" \
  >/dev/null 2>&1
sleep 0.3
pgrep -f "websockify.*${AUDIO_WS_PORT}" | head -1 > "$STATE_DIR/audio-ws.pid"

# A container killed mid-session leaves Chromium's profile singleton lock
# behind; without clearing it the browser silently refuses to start and the
# desktop comes up empty.
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" \
  "$PROFILE_DIR/SingletonCookie" 2>/dev/null || true

# The DevTools port serves semantic observation signals (active-tab URL,
# focused element, page focus) to the agent's observe/act scripts. It binds
# to the container's loopback only — the same trust domain as the DISPLAY
# the agent already fully controls with xdotool.
chromium \
  --no-sandbox \
  --test-type \
  --remote-debugging-port=9222 \
  --hide-crash-restore-bubble \
  --autoplay-policy=no-user-gesture-required \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --user-data-dir="$PROFILE_DIR" \
  --start-maximized \
  "file:///usr/local/share/libre-computer/start-page.html" >/dev/null 2>&1 &
echo $! > "$STATE_DIR/chromium.pid"

# --start-maximized is unreliable under a bare WM; assert it once the
# window exists so the browser fills the screen above the dock.
(
  for _ in $(seq 1 60); do
    found=""
    # Chromium also maps tiny phantom windows; maximize every real one.
    for wid in $(xdotool search --class chromium 2>/dev/null); do
      width="$(xdotool getwindowgeometry --shell "$wid" 2>/dev/null \
        | sed -n 's/^WIDTH=//p')"
      if [ "${width:-0}" -gt 200 ]; then
        xdotool windowstate --add MAXIMIZED_VERT "$wid" 2>/dev/null || true
        xdotool windowstate --add MAXIMIZED_HORZ "$wid" 2>/dev/null || true
        found=1
      fi
    done
    [ -n "$found" ] && break
    sleep 0.2
  done
) &

# One VNC server, two privilege levels: the first password in the passwd
# file grants full control (handed out by the backend only to the current
# takeover-lease holder), passwords after __BEGIN_VIEWONLY__ only watch.
# -localhost keeps raw VNC off the network; websockify is the only
# reachable surface and the backend authenticates every connection.
PASSWD_FILE="$STATE_DIR/passwd"
if [ ! -s "$PASSWD_FILE" ]; then
  umask 077
  random_password() {
    head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | cut -c1-8
  }
  printf '%s\n__BEGIN_VIEWONLY__\n%s\n' \
    "$(random_password)" "$(random_password)" > "$PASSWD_FILE"
fi
x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -localhost \
  -passwdfile "$PASSWD_FILE" \
  -shared -forever -quiet -bg -o "$STATE_DIR/x11vnc.log"

websockify --daemon "0.0.0.0:${WS_PORT}" "127.0.0.1:${VNC_PORT}" \
  >/dev/null 2>&1
# websockify --daemon writes no pidfile by default; record the listener.
sleep 0.3
pgrep -f "websockify.*${WS_PORT}" | head -1 > "$STATE_DIR/websockify.pid"

echo "computer session ready on ws port ${WS_PORT}"
