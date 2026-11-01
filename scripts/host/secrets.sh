#!/bin/bash
# Secrets-Werkzeug (Schnitt 5): sops/age-Verwaltung für den openclaw-docker-Stack.
# age-Privatkey: ~/.config/sops/age/keys.txt — SCHÜTZEN und zusätzlich an einem
# sicheren Ort lagern (ohne diesen Key sind secrets/*.enc unlesbar).
set -euo pipefail
cd "$(dirname "$0")/../.."
export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"

cmd=${1:-help}
case "$cmd" in
  recover)
    # Klartext-Backups aus dem verschlüsselten Bundle zurückholen:
    #   scripts/host/secrets.sh recover            -> Liste
    #   scripts/host/secrets.sh recover DATEI      -> nach stdout
    if [ -z "${2:-}" ]; then
      sops --input-type binary --output-type binary -d secrets/env-backups.tar.enc | tar -tf -
    else
      sops --input-type binary --output-type binary -d secrets/env-backups.tar.enc | tar -xOf - "$2"
    fi
    ;;
  bundle-add)
    # Weitere Geheimnis-Datei ans Bundle anhängen: secrets.sh bundle-add PFAD
    f=${2:?Datei angeben}
    tmp=$(mktemp)
    sops --input-type binary --output-type binary -d secrets/env-backups.tar.enc > "$tmp.tar" 2>/dev/null || tar -cf "$tmp.tar" --files-from /dev/null
    tar -rf "$tmp.tar" "$f"
    sops --input-type binary --output-type binary -e "$tmp.tar" > secrets/env-backups.tar.enc
    rm -f "$tmp.tar"
    echo "$f ans Bundle angehängt, Klartemp entfernt. Original bitte selbst löschen: rm '$f'"
    ;;
  rotate)
    # Rotations-Runbook für eine Variable:
    v=${2:?Variablenname angeben}
    cat <<EOF
Rotations-Runbook für $v:
  1. Neuen Wert beim Anbieter erzeugen (alter bleibt bis Schritt 4 gültig).
  2. In .env ersetzen:  sed -i '' 's|^$v=.*|$v=<NEU>|' .env
  3. Stack neu aufsetzen, damit der Container die Variable zieht:
       docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
  4. Funktion prüfen (Bot antwortet / API-Call ok), DANN alten Wert beim Anbieter widerrufen.
  5. Nightly-Backup hält ab nächstem Lauf den neuen Stand.
EOF
    ;;
  *)
    echo "Usage: secrets.sh {recover [DATEI]|bundle-add PFAD|rotate VAR}" ;;
esac
