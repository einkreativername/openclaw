#!/bin/bash
# Extrahiert OPENCLAW_GATEWAY_TOKEN aus .env in eine Datei für den
# Prometheus-Bearer-Scrape — ohne den Wert je auf stdout zu geben.
set -euo pipefail
cd "$(dirname "$0")/../.."
TOKEN=$(grep -E '^OPENCLAW_GATEWAY_TOKEN=' .env | head -1 | cut -d= -f2-)
if [ -z "$TOKEN" ]; then
  echo "OPENCLAW_GATEWAY_TOKEN nicht in .env gefunden — nichts zu tun." >&2
  exit 1
fi
umask 077
printf '%s' "$TOKEN" > config/observability/gateway-token
echo "config/observability/gateway-token geschrieben (0600). Prometheus-Job in prometheus.yml aktivieren + credentials_file-Mount ergänzen."
