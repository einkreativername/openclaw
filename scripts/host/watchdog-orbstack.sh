#!/bin/bash
# OrbStack watchdog: ensure the menu bar app is running and the Docker engine
# socket exists. Recovers from app crashes, engine stops, and missed logins.
# Installed by ~/Library/LaunchAgents/com.sk.orbstack-watchdog.plist (5 min interval).

ORB_APP="/Applications/OrbStack.app"
SOCKET="$HOME/.orbstack/run/docker.sock"
LOG="$HOME/Library/Logs/orbstack-watchdog.log"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

# 1. App läuft? Sonst starten (deckt verpassten Login ab).
if ! pgrep -qf "$ORB_APP/Contents/MacOS/OrbStack"; then
  log "OrbStack app not running; launching"
  open -a "$ORB_APP"
  sleep 10
fi

# 2. Docker-Socket da? Sonst Engine anwerfen.
if [ ! -S "$SOCKET" ]; then
  log "docker socket missing; running orb start"
  if ! /usr/local/bin/orb start >> "$LOG" 2>&1; then
    log "ERROR: orb start failed"
    exit 1
  fi
fi

# 3. Socket jetzt da? Dann Erfolg (Container kommen via restart:unless-stopped hoch).
if [ -S "$SOCKET" ]; then
  # 4. Stack-Recovery: nach einem VM-/App-Neustart können einzelne Compose-
  #    Projekte liegen bleiben, obwohl restart:unless-stopped gesetzt ist
  #    (z.B. wenn der Compose-Stack zum Neustart-Zeitpunkt nicht "up" war).
  #    Deshalb explizit prüfen und ggf. hochfahren.
  recover_stack() {
    local dir="$1" label="$2"
    [ -f "$dir/docker-compose.yml" ] || return 0
    local running
    running=$(docker ps --filter "label=com.docker.compose.project.working_dir=$dir" \
      --filter "status=running" -q 2>/dev/null | wc -l | tr -d ' ')
    if [ "${running:-0}" -eq 0 ]; then
      log "$label stack not running; bringing up"
      docker compose -f "$dir/docker-compose.yml" up -d >> "$LOG" 2>&1 \
        || log "ERROR: $label compose up failed"
    fi
  }
  recover_stack "/Users/sk/Projects/einkreativesprojekt/lexiclaw" "lexiclaw"
  recover_stack "/Users/sk/Projects/openclaw-docker" "openclaw-docker"

  # Log nur bei vorheriger Aktion — stilles OK sonst.
  exit 0
else
  log "ERROR: socket still missing after orb start"
  exit 1
fi
