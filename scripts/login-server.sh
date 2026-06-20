#!/usr/bin/env bash
# Headless-server one-time Google login.
#
# On a server with no display, this starts a virtual X display (Xvfb), exposes it
# over VNC (x11vnc) through a browser-friendly noVNC proxy, then runs the headed
# login (scripts/login.js) on that display. Connect to the noVNC URL, sign in to
# Google, then press Enter in this terminal to save the profile and shut down.
#
# Prerequisites (Debian/Ubuntu): sudo apt-get install -y xvfb x11vnc novnc websockify
# Override any tool path via env if you ship your own binaries:
#   X11VNC=/path/to/x11vnc NOVNC_PROXY=/path/to/novnc_proxy ./scripts/login-server.sh
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
X11VNC="${X11VNC:-x11vnc}"
NOVNC_PROXY="${NOVNC_PROXY:-novnc_proxy}"   # ships with the `novnc` package
LOG_DIR="${LOG_DIR:-$REPO_ROOT/logs}"
DISPLAY_ADDR=":${DISPLAY_NUM}"

mkdir -p "$PROFILE" "$LOG_DIR"

for tool in Xvfb "$X11VNC" "$NOVNC_PROXY" "$NODE_BIN"; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Required tool not found: $tool" >&2; exit 1; }
done

XVFB_PID="" X11VNC_PID="" NOVNC_PID=""
cleanup() {
  set +e
  [[ -n "$NOVNC_PID" ]] && kill "$NOVNC_PID" 2>/dev/null
  [[ -n "$X11VNC_PID" ]] && kill "$X11VNC_PID" 2>/dev/null
  [[ -n "$XVFB_PID" ]] && kill "$XVFB_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY_ADDR" -screen 0 "$SCREEN" -ac >"$LOG_DIR/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1

"$X11VNC" -display "$DISPLAY_ADDR" -localhost -nopw -forever -shared -rfbport "$VNC_PORT" \
  >"$LOG_DIR/x11vnc.log" 2>&1 &
X11VNC_PID=$!
sleep 1

"$NOVNC_PROXY" --listen "127.0.0.1:${NOVNC_PORT}" --vnc "127.0.0.1:${VNC_PORT}" \
  >"$LOG_DIR/novnc.log" 2>&1 &
NOVNC_PID=$!
sleep 1

cat <<EOF

Google Maps login browser is starting on display ${DISPLAY_ADDR}.

noVNC URL (open in a browser):
  http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=scale

From your laptop, tunnel first:
  ssh -L ${NOVNC_PORT}:127.0.0.1:${NOVNC_PORT} ${USER}@<this-server>

Profile: ${PROFILE}
Sign in via noVNC, then press Enter here to save and exit.
EOF

cd "$REPO_ROOT"
DISPLAY="$DISPLAY_ADDR" GOOGLE_MAPS_PROFILE="$PROFILE" "$NODE_BIN" scripts/login.js
