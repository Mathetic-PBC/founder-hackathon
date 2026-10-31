#!/usr/bin/env bash
# Try the whole device on a Mac before it goes on the Pi: wake word → OpenAI Realtime → agents →
# spoken reply, with the Mac's mic, speaker and webcam standing in for the puck and Camera Module.
#
#   pi/run-mac.sh                    # say "hey bart" or "hey jarvis", then talk; "quit" to stop
#   pi/run-mac.sh --image page.jpg   # send this photo instead of using the webcam
#   pi/run-mac.sh --engelbart        # mirror reading notes into the Engelbart project
#   pi/run-mac.sh --check            # set up and test camera + server, don't start listening
#
# Any other flags go to wake_word.py (--device, --threshold, --silence, ...).
# Starts web/ on localhost:3000 if it isn't running, and stops it again on exit.
set -euo pipefail
cd "$(dirname "$0")"
PI_DIR=$(pwd)
WEB_DIR="$PI_DIR/../web"
PORT=3000
ENGELBART_NOTES="$HOME/.engelbart/founder-hackathon/Reading notes"

check=false
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --image) export BART_TEST_IMAGE="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --engelbart) export VAULT_DIR="$ENGELBART_NOTES"; shift ;;
    --check) check=true; shift ;;
    *) args+=("$1"); shift ;;
  esac
done

# 1. Python env: the Pi's requirements, plus OpenCV for the webcam
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/bin/pip install -q -r requirements.txt opencv-python 2>&1 | grep -v -i "notice" || true

# 2. pi/.env: fill in anything missing from web/.env.local (existing values are kept)
touch .env && chmod 600 .env
add() { grep -q "^$1=" .env || { echo "$1=$2" >> .env; echo "pi/.env: added $1"; }; }
from_web() { grep "^$1=" "$WEB_DIR/.env.local" | cut -d= -f2-; }
add OPENAI_API_KEY "$(from_web OPENAI_API_KEY)"
add BART_TOKEN "$(from_web BART_TOKEN)"
add BART_URL "http://localhost:$PORT"

# 3. The agents server
server_pid=""
if ! curl -sf "localhost:$PORT/api/health" >/dev/null; then
  echo "starting web/ on localhost:$PORT (log: /tmp/bart-web.log)"
  [ -d "$WEB_DIR/node_modules" ] || (cd "$WEB_DIR" && npm install --silent)
  (cd "$WEB_DIR" && exec npx next dev -p "$PORT" > /tmp/bart-web.log 2>&1) &
  server_pid=$!
  trap '[ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null' EXIT
  for _ in $(seq 1 60); do curl -sf "localhost:$PORT/api/health" >/dev/null && break; sleep 1; done
  curl -sf "localhost:$PORT/api/health" >/dev/null || { echo "web/ didn't start; see /tmp/bart-web.log"; exit 1; }
fi

if $check; then
  .venv/bin/python - <<'EOF'
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(".env"))
import agents, vault
tools, _ = agents.start()
print("server:", "ok" if tools else "NO TOOLS (check BART_URL / BART_TOKEN)")
cam = agents._open_camera()
if os.environ.get("BART_TEST_IMAGE"):
    print("camera: using", os.environ["BART_TEST_IMAGE"])
elif not cam:
    print("camera: none found. Allow camera access for your terminal in System Settings > Privacy & Security > Camera")
else:
    photo = cam.take(); cam.close()
    Path("/tmp/bart-camera-check.jpg").write_bytes(photo)
    print(f"camera: {type(cam).__name__.strip('_')} ok, {len(photo) // 1024} KB -> /tmp/bart-camera-check.jpg")
print("notes mirror:", vault.vault_dir())
EOF
  exit 0
fi

# Audio: the JV801 puck if it's plugged in, else the MacBook's own mic and speakers. The system default is
# often AirPods or another Bluetooth headset, and opening its mic drops it into low-quality call audio.
if [[ " ${args[*]-} " != *" --device "* ]]; then
  if .venv/bin/python -c "import sounddevice as sd, sys; sys.exit(0 if any('jv801' in d['name'].lower() for d in sd.query_devices()) else 1)"; then
    args+=(--device JV801)
  else
    args+=(--device "MacBook Pro")
  fi
fi

echo "notes mirror: ${VAULT_DIR:-$PI_DIR/vault}"
.venv/bin/python wake_word.py --keyword "HEY BART" --keyword "HEY JARVIS" ${args[@]+"${args[@]}"}
