#!/usr/bin/env bash
# scripts/docker/persist-agent-home.sh
#
# Seed / refresh the host-side persistence root for agent-installed tooling in
# the openclaw-gateway container (mounted via OPENCLAW_AGENT_HOME in
# docker-compose.yml). Without this, everything the agents set up at runtime
# (Proton Pass CLI + session, ProjectDiscovery configs, pip --user tools,
# agent dotfiles) lives in the container overlay and dies on every recreate.
#
# Usage:
#   persist-agent-home.sh seed    # copy container state -> host (merge, idempotent)
#   persist-agent-home.sh check   # report expected bind sources missing on host
#
# Run `seed` BEFORE the first `docker compose up -d` with the OPENCLAW_AGENT_HOME
# mounts, and re-run after re-authing anything (e.g. a fresh Proton Pass session).
# This script never runs automatically at boot: a fresh/empty container must not
# be able to overwrite seeded host state.
#
# Notes:
#   - Never prints secret material; only path names.
#   - .config/openclaw is deliberately NOT copied: it is its own host bind
#     (OPENCLAW_AUTH_PROFILE_SECRET_DIR) and would duplicate secret key material.
#   - Regenerable caches (~/.cache) stay ephemeral by design.
set -euo pipefail

CONTAINER="${PERSIST_CONTAINER:-$(docker ps -qf 'name=openclaw-gateway' | head -1)}"
HOST_ROOT="${OPENCLAW_AGENT_HOME:-$HOME/.openclaw-agent-home}"

CONFIG_SUBDIRS=(pass-cli pass-agent-lexi dnsx nuclei subfinder uncover pdhttpx)
CONFIG_FILES=(ig-session-lexi.json)
HOME_DIRS=(.ssh .codex .kimi .openclaw-browser .npm .bundle nuclei-templates backups-offload openclaw-backup-git)
HOME_FILES=(.proton-pat)

need_container() {
  if [ -z "$CONTAINER" ]; then
    echo "error: no running openclaw-gateway container found (set PERSIST_CONTAINER)" >&2
    exit 1
  fi
}

# docker cp a container path into a host dir, merging. Silently skips missing
# container paths so the script is safe to re-run after partial cleanup.
cp_from_container() {
  local src="$1" dest="$2"
  if docker exec "$CONTAINER" test -e "$src" 2>/dev/null; then
    mkdir -p "$dest"
    docker cp "$CONTAINER:$src" "$dest" >/dev/null
    echo "  ok: $src -> $dest"
  else
    echo "  skip (not in container): $src"
  fi
}

seed() {
  need_container
  echo "Seeding $HOST_ROOT from container $CONTAINER"

  echo "[config]"
  local d f
  for d in "${CONFIG_SUBDIRS[@]}"; do
    cp_from_container "/home/node/.config/$d/." "$HOST_ROOT/config/$d"
  done
  for f in "${CONFIG_FILES[@]}"; do
    cp_from_container "/home/node/.config/$f" "$HOST_ROOT/config"
  done

  echo "[local] (pip --user site + binaries incl. pass-cli)"
  cp_from_container "/home/node/.local/." "$HOST_ROOT/local"

  echo "[home dirs]"
  for d in "${HOME_DIRS[@]}"; do
    cp_from_container "/home/node/$d/." "$HOST_ROOT/home/$d"
  done

  echo "[home files]"
  for f in "${HOME_FILES[@]}"; do
    cp_from_container "/home/node/$f" "$HOST_ROOT/home"
  done

  # Compose file binds need every source to exist (a missing FILE source would
  # be auto-created as an empty directory by Docker). Create anything the
  # container did not have, and lock down secret-adjacent files.
  local target
  for target in \
    "$HOST_ROOT/config" "$HOST_ROOT/local" \
    "${HOME_DIRS[@]/#/$HOST_ROOT/home/}"; do
    mkdir -p "$target"
  done
  for f in "${CONFIG_FILES[@]}" "${HOME_FILES[@]}"; do
    touch "$HOST_ROOT/config/$f" "$HOST_ROOT/home/$f" 2>/dev/null || true
  done
  chmod 700 "$HOST_ROOT/home/.ssh" 2>/dev/null || true
  chmod 600 "$HOST_ROOT/home/.proton-pat" 2>/dev/null || true

  echo "seed done -> $HOST_ROOT"
  echo "next: docker compose up -d  (recreates the gateway with the new mounts)"
}

check() {
  need_container
  local missing=0 d f
  echo "Checking $HOST_ROOT against container $CONTAINER"
  for d in "${CONFIG_SUBDIRS[@]}"; do
    if [ ! -e "$HOST_ROOT/config/$d" ]; then
      echo "  MISSING on host: config/$d"
      missing=1
    fi
  done
  for f in "${CONFIG_FILES[@]}"; do
    if [ ! -f "$HOST_ROOT/config/$f" ]; then
      echo "  MISSING on host: config/$f"
      missing=1
    fi
  done
  if [ ! -d "$HOST_ROOT/local/bin" ]; then
    echo "  MISSING on host: local/bin"
    missing=1
  fi
  for d in "${HOME_DIRS[@]}"; do
    if [ ! -d "$HOST_ROOT/home/$d" ]; then
      echo "  MISSING on host: home/$d"
      missing=1
    fi
  done
  for f in "${HOME_FILES[@]}"; do
    if [ ! -f "$HOST_ROOT/home/$f" ]; then
      echo "  MISSING on host: home/$f"
      missing=1
    fi
  done
  if [ "$missing" -eq 0 ]; then
    echo "all expected bind sources present on host"
  else
    echo "run: $0 seed"
    exit 1
  fi
}

case "${1:-}" in
  seed) seed ;;
  check) check ;;
  *) echo "usage: $0 {seed|check}" >&2; exit 2 ;;
esac
