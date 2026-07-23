#!/usr/bin/env bash
# Headless-server one-time Google login.
#
# On a server with no display, this starts a virtual X display (Xvfb), exposes it
# over VNC (x11vnc) through a browser-friendly noVNC proxy, then runs the headed
# login (scripts/login.js) on that display. Connect to the noVNC URL, enter the
# printed one-time VNC password, sign in to Google, then press Enter in this
# terminal to save the profile and shut down.
#
# The display is protected with an MIT-MAGIC-COOKIE (xauth) and the VNC server
# with a random one-time password, so other local users on a shared server
# cannot watch or drive the login session.
#
# Prerequisites (Debian/Ubuntu):
#   sudo apt-get install -y xvfb x11vnc novnc websockify xauth
# Override any tool path via env if you ship your own binaries:
#   XVFB=/path/to/Xvfb X11VNC=/path/to/x11vnc NOVNC_PROXY=/path/to/novnc_proxy \
#     ./scripts/login-server.sh
#
# Required: GOOGLE_MAPS_PROFILE (where the persistent browser profile is stored).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${GOOGLE_MAPS_PROFILE:?Set GOOGLE_MAPS_PROFILE to the persistent profile path}"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN="${SCREEN:-1366x900x24}"
VNC_PORT="${VNC_PORT:-5901}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
NODE_BIN="${NODE_BIN:-node}"
XVFB="${XVFB:-Xvfb}"
X11VNC="${X11VNC:-x11vnc}"
NOVNC_PROXY="${NOVNC_PROXY:-novnc_proxy}"   # ships with the `novnc` package
# Debian/Ubuntu's novnc package installs the proxy outside PATH; fall back to
# its packaged location when the plain name doesn't resolve.
if ! command -v "$NOVNC_PROXY" >/dev/null 2>&1 && [[ -x /usr/share/novnc/utils/novnc_proxy ]]; then
  NOVNC_PROXY=/usr/share/novnc/utils/novnc_proxy
fi
LOG_DIR="${LOG_DIR:-$REPO_ROOT/logs}"
DISPLAY_ADDR=":${DISPLAY_NUM}"

mkdir -p "$PROFILE" "$LOG_DIR"

for tool in "$XVFB" "$X11VNC" "$NOVNC_PROXY" "$NODE_BIN" xauth mcookie; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool not found: $tool" >&2; exit 1; }
done

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&-; return 0; }
  return 1
}

die_with_log() {
  echo "$1" >&2
  [[ -f "$2" ]] && { echo "--- last lines of $2 ---" >&2; tail -n 20 "$2" >&2; }
  exit 1
}

# Fail early on a display or port that is already taken instead of printing a
# working-looking URL backed by someone else's (or a dead) service.
[[ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]] \
  && { echo "Display ${DISPLAY_ADDR} is already in use; set DISPLAY_NUM to a free one." >&2; exit 1; }
for port in "$VNC_PORT" "$NOVNC_PORT"; do
  port_in_use "$port" \
    && { echo "Port ${port} is already in use; override VNC_PORT / NOVNC_PORT." >&2; exit 1; }
done

AUTH_FILE="$(mktemp)"
VNC_PASS_FILE="$(mktemp)"
XVFB_PID="" X11VNC_PID="" NOVNC_PID=""
cleanup() {
  set +e
  [[ -n "$NOVNC_PID" ]] && kill "$NOVNC_PID" 2>/dev/null
  [[ -n "$X11VNC_PID" ]] && kill "$X11VNC_PID" 2>/dev/null
  [[ -n "$XVFB_PID" ]] && kill "$XVFB_PID" 2>/dev/null
  rm -f "$AUTH_FILE" "$VNC_PASS_FILE"
}
trap cleanup EXIT INT TERM

xauth -q -f "$AUTH_FILE" add "$DISPLAY_ADDR" MIT-MAGIC-COOKIE-1 "$(mcookie)"
VNC_PASSWORD="$(mcookie | cut -c1-8)"
"$X11VNC" -storepasswd "$VNC_PASSWORD" "$VNC_PASS_FILE" >/dev/null 2>&1

"$XVFB" "$DISPLAY_ADDR" -screen 0 "$SCREEN" -auth "$AUTH_FILE" >"$LOG_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 50); do
  kill -0 "$XVFB_PID" 2>/dev/null || die_with_log "Xvfb died during startup" "$LOG_DIR/xvfb.log"
  [[ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]] && break
  sleep 0.2
done
[[ -e "/tmp/.X11-unix/X${DISPLAY_NUM}" ]] \
  || die_with_log "Xvfb did not create display ${DISPLAY_ADDR} within 10s" "$LOG_DIR/xvfb.log"

"$X11VNC" -display "$DISPLAY_ADDR" -auth "$AUTH_FILE" -localhost -rfbauth "$VNC_PASS_FILE" \
  -forever -shared -rfbport "$VNC_PORT" >"$LOG_DIR/x11vnc.log" 2>&1 &
X11VNC_PID=$!
for _ in $(seq 1 50); do
  kill -0 "$X11VNC_PID" 2>/dev/null || die_with_log "x11vnc died during startup" "$LOG_DIR/x11vnc.log"
  port_in_use "$VNC_PORT" && break
  sleep 0.2
done
port_in_use "$VNC_PORT" \
  || die_with_log "x11vnc did not listen on port ${VNC_PORT} within 10s" "$LOG_DIR/x11vnc.log"

"$NOVNC_PROXY" --listen "127.0.0.1:${NOVNC_PORT}" --vnc "127.0.0.1:${VNC_PORT}" \
  >"$LOG_DIR/novnc.log" 2>&1 &
NOVNC_PID=$!
for _ in $(seq 1 50); do
  kill -0 "$NOVNC_PID" 2>/dev/null || die_with_log "noVNC proxy died during startup" "$LOG_DIR/novnc.log"
  port_in_use "$NOVNC_PORT" && break
  sleep 0.2
done
port_in_use "$NOVNC_PORT" \
  || die_with_log "noVNC proxy did not listen on port ${NOVNC_PORT} within 10s" "$LOG_DIR/novnc.log"

cat <<EOF

Google Maps login browser is starting on display ${DISPLAY_ADDR}.

noVNC URL (open in a browser):
  http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=scale
One-time VNC password: ${VNC_PASSWORD}

From your laptop, tunnel first:
  ssh -L ${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT} ${USER:-$(id -un)}@<this-server>

Profile: ${PROFILE}
Sign in via noVNC, then press Enter here to save and exit.
EOF

cd "$REPO_ROOT"
DISPLAY="$DISPLAY_ADDR" XAUTHORITY="$AUTH_FILE" GOOGLE_MAPS_PROFILE="$PROFILE" \
  "$NODE_BIN" scripts/login.js
