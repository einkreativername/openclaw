#!/usr/bin/env python3
"""
Idempotente Config-Migration fuer openclaw-docker (31.10.2026).

Setzt die im FIX-BUNDLE "FD-Skills 31.10." beschriebenen Config-Aenderungen:
  P0-5  google-Auth-Profil (media-analyst lebt)
  P2-2  agents.entries.*.skills entfernen  -> "skills stay unrestricted"
        verhaltenskritische Skills global sperren (skills.entries.*.enabled=false)
  P2-3  plugins.allow erweitern, diagnostics-otel + onepassword aktivieren

Idempotent: mehrfache Ausfuehrung erzeugt denselben Zustand.
Nur agents/skills/plugins-Bereiche werden angefasst; der Rest der Config
bleibt byte-identisch (Key-Reihenfolge erhalten via OrderedDict).
"""

from __future__ import annotations

import json
import sys
from collections import OrderedDict
from pathlib import Path

CONFIG = Path("/Users/sk/.openclaw-docker/openclaw.json")

# Verhaltenskritische Skills: bleiben global gesperrt, bis Sebi sie einzeln freigibt.
# Begruendung (verifiziert 31.10.):
#   hard-enforcement      - loggt Verletzungen, zieht Score ab, verlaengert Locks, Wall-of-Shame
#   fd-task-enforcer      - POST /api/fd/scores/event (mutierend)
#   fd-autonomy-engine    - referenziert /api/fd/safeword + /api/fd/cron/lexi-autonomy-tick
#   fd-voice-lock         - erstellt/entsperrt CL-Locks
#   fd-master-control     - 10 Endpoints inkl. /api/fd/system/handover
CRITICAL_SKILLS = [
    "hard-enforcement",
    "fd-task-enforcer",
    "fd-autonomy-engine",
    "fd-voice-lock",
    "fd-master-control",
]

# Bereits gesperrt und bleiben gesperrt.
KEEP_DISABLED_SKILLS = ["emotion-detect", "fd-homekit", "pixel-grok-hub"]

# Plugins, die geladen (allow) sein sollen, aber nicht zwingend aktiv.
# -> hier nur die 5 disabled Plugins, die laut Audit "pruefen" waren.
PLUGINS_TO_ALLOW = [
    "anthropic",
    "fd-perception-control",
    "github",
    "whatsapp",
    "workboard",
]

# Plugins, die explizit aktiviert werden.
PLUGINS_TO_ENABLE = ["diagnostics-otel", "onepassword"]


def load() -> OrderedDict:
    with CONFIG.open(encoding="utf-8") as fh:
        return json.load(fh, object_pairs_hook=OrderedDict)


def save(cfg: OrderedDict) -> None:
    tmp = CONFIG.with_suffix(".json.tmp-mavis")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    tmp.replace(CONFIG)


def main() -> int:
    cfg = load()
    changed: list[str] = []

    # ---- P0-5: google-Auth-Profil -------------------------------------------
    auth = cfg.setdefault("auth", OrderedDict())
    profiles = auth.setdefault("profiles", OrderedDict())
    if "google:default" not in profiles:
        profiles["google:default"] = OrderedDict([("provider", "google"), ("mode", "api_key")])
        changed.append("P0-5: auth.profiles['google:default'] angelegt")

    # ---- P2-2: Skills unrestricted + kritische Skills sperren ----------------
    agents = cfg.setdefault("agents", OrderedDict())
    entries = agents.setdefault("entries", OrderedDict())
    for agent_id, agent in entries.items():
        if "skills" in agent:
            removed = len(agent.pop("skills"))
            changed.append(f"P2-2: agents.entries.{agent_id}.skills entfernt ({removed} Eintraege)")

    defaults = agents.setdefault("defaults", OrderedDict())
    if "skills" in defaults:
        defaults.pop("skills")
        changed.append("P2-2: agents.defaults.skills entfernt (kein Default-Limit)")

    skills = cfg.setdefault("skills", OrderedDict())
    skill_entries = skills.setdefault("entries", OrderedDict())
    for skill_name in CRITICAL_SKILLS + KEEP_DISABLED_SKILLS:
        entry = skill_entries.setdefault(skill_name, OrderedDict())
        if entry.get("enabled") is not False:
            entry["enabled"] = False
            changed.append(f"P2-2: skills.entries.{skill_name}.enabled=false")

    # ---- P2-3: Plugins -----------------------------------------------------
    plugins = cfg.setdefault("plugins", OrderedDict())
    allow = plugins.setdefault("allow", [])
    for plugin_id in PLUGINS_TO_ALLOW:
        if plugin_id not in allow:
            allow.append(plugin_id)
            changed.append(f"P2-3: plugins.allow += {plugin_id}")

    plugin_entries = plugins.setdefault("entries", OrderedDict())
    for plugin_id in PLUGINS_TO_ENABLE:
        entry = plugin_entries.setdefault(plugin_id, OrderedDict())
        if entry.get("enabled") is not True:
            entry["enabled"] = True
            changed.append(f"P2-3: plugins.entries.{plugin_id}.enabled=true")

    if not changed:
        print("Keine Aenderungen noetig (bereits idempotent angewendet).")
        return 0

    save(cfg)
    print(f"{len(changed)} Aenderungen angewendet:")
    for line in changed:
        print(f"  - {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
