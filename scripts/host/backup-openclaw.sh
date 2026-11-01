#!/bin/bash
# Nightly-Backup: openclaw-Zustand + .env + Compose-Config, tar.gz | gpg symmetrisch.
# Passphrase liegt im macOS-Schlüsselbund (Service openclaw-backup) — nie im Klartext.
# Retention: 14 Nightly-Backups. Log: ~/Library/Logs/openclaw-backup.log
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$HOME/.openclaw-backups"
LOG="$HOME/Library/Logs/openclaw-backup.log"
LOCK="/tmp/openclaw-backup.lock"
KS_SERVICE="openclaw-backup"
KS_ACCOUNT="passphrase"
PROJECT="$HOME/Projects/openclaw-docker"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
die() { log "ERROR: $1"; exit 1; }

# launchd startet Jobs mit PATH=/usr/bin:/bin:/usr/sbin:/sbin — Homebrew ist dort NICHT
# enthalten (gpg liegt in /opt/homebrew/bin/gpg). Binaries daher explizit auflösen,
# statt auf $PATH zu vertrauen. Reihenfolge: PATH -> Homebrew -> System.
resolve_bin() {
  local name="$1" cand
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  for cand in "/opt/homebrew/bin/$name" "/usr/local/bin/$name" "/usr/bin/$name" "/bin/$name"; do
    if [ -x "$cand" ]; then
      printf '%s' "$cand"
      return 0
    fi
  done
  return 1
}

GPG_BIN=$(resolve_bin gpg)      || die "gpg nicht gefunden (weder im PATH noch in /opt/homebrew/bin)"
TAR_BIN=$(resolve_bin tar)      || die "tar nicht gefunden"
SECURITY_BIN=$(resolve_bin security) || die "security (Schlüsselbund) nicht gefunden"
OPENSSL_BIN=$(resolve_bin openssl)   || die "openssl nicht gefunden"

# Concurrency-Lock
if ! mkdir "$LOCK" 2>/dev/null; then
  log "SKIP: Lock belegt ($LOCK)"
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

mkdir -p "$DEST"

# Passphrase aus dem Schlüsselbund; fehlt sie, wird sie erzeugt und hinterlegt.
PASS=$("$SECURITY_BIN" find-generic-password -s "$KS_SERVICE" -a "$KS_ACCOUNT" -w 2>/dev/null || true)
if [ -z "$PASS" ]; then
  PASS=$("$OPENSSL_BIN" rand -base64 32)
  "$SECURITY_BIN" add-generic-password -s "$KS_SERVICE" -a "$KS_ACCOUNT" -w "$PASS" -U
  log "Neue Backup-Passphrase im Schlüsselbund hinterlegt (Service: $KS_SERVICE)"
fi

OUT="$DEST/openclaw-backup-$STAMP.tar.gz.gpg"
TMPARCHIVE="$DEST/.openclaw-backup-$STAMP.tar.gz.part"
log "Backup start -> $OUT"

cleanup() { rm -f "$TMPARCHIVE"; }
trap 'cleanup; rmdir "$LOCK"' EXIT

# Schritt 1: tar in eine Temp-Datei. So kann ein tar-Fehler kein leeres/kaputtes
# .gpg hinterlassen — das Archiv wird erst danach verschluesselt.
# Excludes: regenerierbare Verzeichnisse (Tools, tmp, Browser-Profile, Caches)
# sowie Unix-Sockets (pax kann keine Sockets archivieren).
TAR_RC=0
"$TAR_BIN" -czf "$TMPARCHIVE" \
  --exclude='.openclaw/tools' \
  --exclude='.openclaw/tmp' \
  --exclude='.openclaw/browser' \
  --exclude='.openclaw/cache' \
  --exclude='.openclaw/npm' \
  --exclude='.openclaw/completions' \
  --exclude='.openclaw/sandboxes' \
  --exclude='*.sock' \
  -C "$HOME" .openclaw .openclaw-tailscale-state \
  -C "$PROJECT" .env docker-compose.yml docker-compose.override.yml \
    docker-compose.observability.yml config >> "$LOG" 2>&1 || TAR_RC=$?

if [ "$TAR_RC" -ne 0 ]; then
  # "socket ignored" ist harmlos; harte Fehler sind es nicht.
  if grep -qi 'socket' "$LOG" && [ ! -s "$TMPARCHIVE" ]; then
    die "tar scheiterte (rc=$TAR_RC) und lieferte kein Archiv"
  fi
  log "WARN: tar beendet mit rc=$TAR_RC — Archiv wird dennoch geprüft"
fi

if [ ! -s "$TMPARCHIVE" ]; then
  die "tar hat kein Archiv erzeugt (rc=$TAR_RC)"
fi

# Schritt 2: verschluesseln.
# Passphrase wird ueber File-Descriptor 3 uebergeben, NICHT als Kommandozeilenargument.
# Grund: so taucht das Secret weder in der Prozessliste (ps) noch im
# Process-Creation-Telemetry eines EDR auf. Funktional identisch.
GPG_RC=0
"$GPG_BIN" --batch --yes --symmetric --cipher-algo AES256 \
  --passphrase-fd 3 --output "$OUT" "$TMPARCHIVE" 3<<<"$PASS" >> "$LOG" 2>&1 || GPG_RC=$?

if [ "$GPG_RC" -ne 0 ]; then
  rm -f "$OUT"
  die "gpg-Verschluesselung fehlgeschlagen (rc=$GPG_RC)"
fi

# Schritt 3: Integritaet pruefen — Archiv laesst sich mit der Passphrase oeffnen.
if ! "$GPG_BIN" --batch --quiet --passphrase-fd 3 --decrypt "$OUT" 3<<<"$PASS" 2>> "$LOG" | "$TAR_BIN" -tzf - > /dev/null 2>&1; then
  rm -f "$OUT"
  die "Integritaetspruefung fehlgeschlagen — Archiv entfernt"
fi

rm -f "$TMPARCHIVE"
log "Backup verschluesselt und verifiziert"

# Retention: alles aelter als die 14 neuesten loeschen.
ls -1t "$DEST"/openclaw-backup-*.tar.gz.gpg 2>/dev/null | tail -n +15 | while read -r old; do
  rm -f "$old" || log "WARN: Retention konnte $(basename "$old") nicht loeschen"
  log "Retention: geloescht $(basename "$old")"
done

SIZE=$(du -h "$OUT" | cut -f1)
log "Backup fertig ($SIZE)"

# Offsite: verschlüsseltes Blob per Tailscale Taildrop an openclaw-gateway-2.
# Best-effort — ein Ausfall des Ziels killt das lokale Backup nicht.
# Abruf auf dem Ziel: /var/lib/tailscale/files (root). Retention dort manuell.
if TAILSCALE_BIN=$(resolve_bin tailscale) && "$TAILSCALE_BIN" status >/dev/null 2>&1; then
  if "$TAILSCALE_BIN" file cp "$OUT" openclaw-gateway-2: >> "$LOG" 2>&1; then
    log "Offsite: nach openclaw-gateway-2 gesendet"
  else
    log "WARN: Offsite-Übertragung fehlgeschlagen (lokales Backup ist sicher)"
  fi
else
  log "WARN: Tailscale nicht erreichbar — Offsite-Schritt übersprungen"
fi

echo "OK $OUT ($SIZE)"
