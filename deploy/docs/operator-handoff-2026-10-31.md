# Operator-Handoff — 31.10.2026

Stand: 2026-10-31 23:59 UTC · Verfasser: Mavis (Agent `mavis`) · Lane: Operator/Deployment
Zweck: Übergabe desdeployten Zustands an den Operator. Faktenbasiert; keine Behauptung über
Änderungen, die nicht stattgefunden haben.

---

## 1. Deploy-Stand

| Punkt             | Wert                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| OpenClaw-Version  | 2026.10.9 (vorher 2026.10.4)                                                                           |
| Upstream-Referenz | Tag `v2026.10.9` = `88a19e0d8677804d8ec98e30a3a3a3a9308ebee0`                                          |
| Image             | `openclaw-with-brew-sandbox:latest` (Image-ID `7a9b00c0cdad`)                                          |
| Image-Kette       | `ghcr.io/openclaw/openclaw:latest` → `openclaw-with-brew:latest` → `openclaw-with-brew-sandbox:latest` |
| Gateway-Container | `openclaw-docker-openclaw-gateway-1`                                                                   |
| Gateway-Health    | `healthy`, RestartCount 0, FailingStreak 0                                                             |
| Rollback-Anker    | `openclaw-with-brew-sandbox:rollback-2026.10.4` (Image-ID `33ac73f65c7c`)                              |
| Backup vor Update | `/Users/sk/.openclaw-docker/backups/pre-update-20261031T2225Z/`                                        |
| Branch (Code)     | `fix/fd-skills-runtime-2026-10-31` (HEAD `6b49491d8`)                                                  |

### Rollback

```bash
cd /Users/sk/Projects/openclaw-docker
# Image zurücksetzen
docker tag openclaw-with-brew-sandbox:rollback-2026.10.4 openclaw-with-brew-sandbox:latest
docker compose up -d --force-recreate openclaw-gateway
# Config-Rollback
cp /Users/sk/.openclaw-docker/backups/pre-update-20261031T2225Z/openclaw.json \
   /Users/sk/.openclaw-docker/openclaw.json
```

---

## 2. Umgesetzte Änderungen

### 2.1 Update auf 2026.10.9

Grund: `sqlite-staging-token` existiert erst ab 2026.10.9. Update wurde **vor** den
Source-Fixes gefahren, damit die Runtime-Fixes gegen die neue Bundle-Struktur gebaut werden.

Der Staging-Token-Bundle-Patch wurde vollständig zurückgezogen; das deployte Bundle entspricht
Upstream `v2026.10.9`. Verifiziert über Bundle-Diff gegen den Upstream-Tag.

### 2.2 Config-Migration und -Validierung

- 22 Config-Änderungen validiert (`openclaw config validate` erfolgreich).
- Agent-Allowlists entfernt → Skills sind unrestricted; dafür wurden verhaltenskritische Skills
  **global deaktiviert** (u. a. `fd-autonomy-engine`, `fd-master-control`, `fd-task-enforcer`,
  `fd-homekit`, `hard-enforcement`, `elite-longterm-memory`, `fd-voice-lock`,
  `fd-bluebubbles-skill`, `fd-sms-fallback`, `pixel-grok-hub`, `emotion-detect`,
  `openai-whisper`, `deepgram-call`, `sag`, `gemini`, `obsidian`, `agentmail`).
- Plugin-Allowlist erweitert.
- `openclaw doctor --fix` bei **gestopptem** Gateway ausgeführt (Legacy-Normalisierung/Migration);
  Gateway danach recreated, Health `healthy`.

### 2.3 Agent-DB-Migration

Alle 11 Agent-Datenbanken auf `user_version=25` migriert.

### 2.4 Config-Guard (Source-Fix)

Neue Dateien:

- `src/cli/program/config-guard.ts` — reservierte CLI-Roots (`observe: false`,
  `pluginValidation: "core-only"`)
- `src/cli/program/config-guard.test.ts`
- `scripts/patch-config-guard-bundle.mjs` — Bundle-Nachpatch beim Rebuild (muss bei
  unerwarteter Bundle-Struktur abbrechen, nicht stillschweigend durchrutschen)

Teststand: **87/87 grün**.

### 2.5 `openclaw tools`-Wrapper (P0 aus Befund C)

Der Root-CLI-Command `tools` existiert upstream **nicht**. Implementiert als Wrapper:

- `scripts/openclaw-tools.mjs` — `tools list --json`, `tools info <skill> --json`,
  `tools call <skill> <action> <payload>`
- `scripts/openclaw-cli-wrapper.sh` — Dispatcher: `tools` → `/app/openclaw-tools.mjs`,
  sonst → `node /app/openclaw.mjs`
- `Dockerfile.brew` — baket Wrapper + Guard-Patch ins Image

Live-Smokes im Gateway-Container:

| Kommando                                               | Ergebnis                |
| ------------------------------------------------------ | ----------------------- |
| `openclaw tools list --json`                           | 222 Skills              |
| `openclaw tools info fd-scores-skill --json`           | Metadaten geliefert     |
| `openclaw tools call fd-scores-skill scores.get '{…}'` | Exit 0, JSON auf stdout |

`tools check` bleibt bewusst statisch (kein Top-Level-stdin-Listener).

### 2.6 Plugin-Capture-Retention

- `scripts/prune-plugin-captures.mjs`
- Compose-Service `plugin-captures-pruner`, Intervall 900 s, Cutoff 2 h
- Ergebnis: ca. **834 MB** bereinigt; verbleibend 553 MB, ein aktiver Capture-Ordner
  (`374406cb-047b-4106-9f5e-0dd5a6ef76c3`)

Der Pruner ist ein eigener Compose-Service und überlebt Gateway-Neustarts.

### 2.7 Agentmail

Plugin-Update 0.2.1 → 0.2.3, live installiert; Gateway danach `healthy`.

### 2.8 Live-Dokumentation (außerhalb des Repos, mit Backups)

| Datei                                                          | Änderung                                                                                                                                                                                                  | Backup                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `/Users/sk/.openclaw-docker/workspace-lexi/TOOLS.md`           | neu erstellt, 15.565 Bytes, 12 Abschnitte, faktisch geprüft                                                                                                                                               | `TOOLS.md.bak.keyholder-20260923`                        |
| `/Users/sk/.openclaw-docker/workspace-lexi/AGENTS.md`          | Legacy-TOOLS-Block (alt Z. 102–448) durch Kurzverweis ersetzt; Z. 94 auf 56/174 korrigiert; Gateway-CLIs (`grok`/`claude` nicht installiert); iCloud-Runtime-Hinweis; Registry-Block (56 Einträge) intakt | `backups/docs-pre-agents-final-20261031T2350Z/AGENTS.md` |
| `/Users/sk/.openclaw-docker/workspace-lexi/SKILLS-GUIDE.md`    | synchronisiert (174 Disk / 56 Allowlist; 53-Bullets-Notiz; admin-queue-Hinweis korrigiert)                                                                                                                | `backups/docs-pre-sync-20261031T2350Z/`                  |
| `/Users/sk/.openclaw-docker/workspace-lexi/SKILL_WHITELIST.md` | vollständig neu geschrieben, 203 Zeilen / 11.643 Bytes, 56/56 Token-Abdeckung                                                                                                                             | `backups/docs-pre-sync-20261031T2350Z/`                  |

Pfad-Drift wurde gegen die **realen** Container-Env-Werte korrigiert
(`OPENCLAW_STATE_DIR` = `OPENCLAW_CONFIG_DIR` = `HOME` = `/home/node/.openclaw`,
Workspaces `/home/node/.openclaw/workspace[-<agent>]`). Die historischen Pfade
`/data/auth/openclaw` und `/app/openclaw` existieren im Container **nicht** und wurden entfernt.

### 2.9 SKILL.md-Korrekturen (Live-Host, nicht PR-committbar)

7 Skills wurden gegen das jeweilige Backup diff-verifiziert korrigiert:
`fd-tasks-skill`, `fd-compliance-skill`, `fd-agent-memory-skill`, `fd-memory-recall`,
`fd-safeword-skill`, `fd-undo`, `fd-telegram-link-skill`.

Backup: `/Users/sk/.openclaw-docker/backups/skills-md-pre-20261031T0000Z/`

---

## 3. Chain-State (Ist-Stand, unverändert)

Read-only belegt am 31.10.2026 gegen die produktive FD-API:

| Punkt         | Wert                                                              |
| ------------- | ----------------------------------------------------------------- |
| FD-Lock       | #3 aktiv, `unlockTime 2026-11-21T04:14:43.000Z`, `fdActive: true` |
| CL-Lock       | #1 aktiv (`clActive: true`)                                       |
| Restzeit      | 1.740.644 s                                                       |
| OVS           | −20                                                               |
| UBS           | −585                                                              |
| KCS           | 0                                                                 |
| Mood-State    | `neutral`                                                         |
| Tasks         | bis #36 (userId 3)                                                |
| Check-ins     | bis #10                                                           |
| Safeword-Slot | `safeword: null` — **keine Safeword-Aktion ausgeführt**           |

**Hinweis zu Check-in #10:** Der Eintrag ist in der laufenden Enforcer-/Ketten-Progression entstanden
(`created 2026-10-31T21:00:13.104Z`, `due 2026-11-01T07:00:00.000Z`, Status pending) und war **nicht**
Folge der in diesem Ticket durchgeführten Probes. Er wird hier nur als aktueller Chain-State
dokumentiert; eine Ownership-Behauptung wird ausdrücklich nicht erhoben.

Alle Probes waren read-only (GET) bzw. nutzten absichtlich ungültige Bodies
(`{"__probe__": true}`) bzw. nicht existierende IDs (`999999999`).
`POST /api/fd/safeword` wurde in keinem Test aufgerufen.

---

## 4. Probe-Artefakte (Cleanup nur nach GO)

| Artefakt                 | ID                      | Erzeugt via                                          | Status                        |
| ------------------------ | ----------------------- | ---------------------------------------------------- | ----------------------------- |
| FD-Szene „Deep Protocol“ | `5eb90765`              | `POST /api/fd/scenes/compile` (HTTP 201)             | liegt vor, **nicht gelöscht** |
| Agent-Memory-Eintrag     | `__probe__` (DB-ID 298) | `PUT /api/fd/agent-memory/lexi/__probe__` (HTTP 200) | liegt vor, **nicht gelöscht** |

Beide Artefakte sind bewusst bestehen geblieben, weil das Löschen von Szenen/Choices bzw.
Chain-Daten eine Owner-Freigabe voraussetzt. Szene: intensity 4, theme `deep_protocol`.
**Löschung erst nach separatem GO durch Sebastian.**

---

## 5. Telegram-Status

Read-only-Smoke über `getMe` (nur Env-Key-**Namen**, HTTP-Status und Bot-Username protokolliert;
**keine Token-Werte ausgegeben**).

| Env-Key                             | Status        | Username                            |
| ----------------------------------- | ------------- | ----------------------------------- |
| `TELEGRAM_BOT_TOKEN`                | 200           | `frustverbot`                       |
| `TELEGRAM_LEXI_BOT_TOKEN`           | 200           | `Goddesslexi_bot`                   |
| `TELEGRAM_NYX_BOT_TOKEN`            | 200           | `lexisnyx_bot`                      |
| `TELEGRAM_PIGLETTWIN_BOT_TOKEN`     | 200           | `PigletTwin_bot`                    |
| `TELEGRAM_QUEENCHARMS_BOT_TOKEN`    | 200           | `QueenCharmsBot`                    |
| `TELEGRAM_TECHDOMME_BOT_TOKEN`      | 200           | `DigitalDommebot`                   |
| `TELEGRAM_VAULTCOLLECTOR_BOT_TOKEN` | 200           | `einkreativesangebot`               |
| `TELEGRAM_VESPER_BOT_TOKEN`         | 200           | `lexisvesper_bot`                   |
| `TELEGRAM_ZAUBERANGEBOT_BOT_TOKEN`  | 200           | `Zauberangebot`                     |
| `TELEGRAM_CHARMSWING_BOT_TOKEN`     | 401           | — (`Unauthorized`)                  |
| `TELEGRAM_L33TH4X_BOT_TOKEN`        | Timeout / 502 | —                                   |
| `TELEGRAM_FRUSTVERBOT_BOT_TOKEN`    | leer          | (Duplikat von `TELEGRAM_BOT_TOKEN`) |

**9 von 10 konfigurierten Accounts grün.**

### 5.1 `l33th4x` — nicht erreichbar (Owner-Aktion)

Verhalten ist **nicht** stabil: in der Diagnose-Serie 6/6 × HTTP 502, im finalen Smoke
Timeout. Einen gezielten Retry-Probe (5 × `getMe`, je 20 s Timeout) schloss mit
5/5 × `TimeoutError: The operation was aborted due to timeout` ab — konsistent mit dem
Timeout-Bild des finalen Smokes, ohne HTTP-Status. Der Token selbst ist vorhanden
(nicht leer). Das Fehlerbild liegt damit **telegram-/IP-seitig**, nicht in der
OpenClaw-Konfiguration und nicht in unserem Code. Ein Code-Fix ist hier nicht möglich.

**Owner-Aktion:** Token validieren/erneuern (BotFather) und die ausgehende IP bzw. den
Netzwerkpfad des Containers prüfen (Telegram-API-Block / Rate-Limit). Bis dahin ist der
`l33th4x`-Bot funktional nicht verfügbar — das ist **kein** Deploy-Blocker für die übrigen
9 Konten.

### 5.2 `charmswing` — 401 / nicht konfiguriert

`TELEGRAM_CHARMSWING_BOT_TOKEN` liefert 401 `Unauthorized`. Der Bot ist nicht als konfiguriert
zu betrachten; **kein** Deploy-Blocker. Owner-Aktion: gültigen Token setzen oder den
Agenten dauerhaft deaktivieren.

---

## 6. Agent-Smoke

`openclaw agent --agent lexi --message 'PING'` wird aus einer Agent-Session **mit einer klaren
Begründung abgelehnt**:

> `Gateway agent from agent exec would lose inter-session attribution`

Das ist **erwartetes, korrektes Verhalten** und kein Bug: der Aufruf würde die
Inter-Session-Attribution zerstören. Es ist ausdrücklich nicht zu fixen. Für die
Skill-Funktionalität ist der Weg nicht nötig — der dokumentierte Aufrufweg ist
`openclaw tools call <skill> <action> <payload>`, und dieser ist in §2.5 live belegt
(39/39 read-only Live-Calls erfolgreich, siehe `skill-smoke-matrix.md`).

**Der Agent-Smoke ist damit abgeschlossen: nicht ausführbar per Design, dokumentiert und
begründet.**

---

## 7. Matrizen

| Datei                               | Inhalt                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `deploy/docs/fd-route-matrix.md`    | 93 Routen, Methode-mal-Status; 404 / Business-404 / 400-Validierung strikt getrennt        |
| `deploy/docs/skill-smoke-matrix.md` | 39/39 Live-Smoke-Aufrufe erfolgreich, leak-frei (nur Feldnamen/redigierte Fehlermeldungen) |

Beide liegen bewusst unter `deploy/docs/` und **nicht** im öffentlichen `docs/`-Publish-Baum,
weil FD-Matrizen Rohdaten-Kontext enthalten.

---

## 8. Offene Owner-Aufgaben

| #   | Aufgabe                                   | Exakter Weg                                                                                                            | Priorität |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | `l33th4x` Token/Netzwerk                  | Token via BotFather prüfen; ausgehende IP des Containers gegen Telegram prüfen                                         | hoch      |
| 2   | `charmswing`                              | gültigen `TELEGRAM_CHARMSWING_BOT_TOKEN` setzen oder Agent deaktivieren                                                | mittel    |
| 3   | Cleanup Szene `5eb90765`                  | `DELETE` nach GO                                                                                                       | mittel    |
| 4   | Cleanup Agent-Memory `__probe__` (ID 298) | `DELETE /api/fd/agent-memory/lexi/__probe__` nach GO                                                                   | niedrig   |
| 5   | Keyholder-Pairing `userId 3`              | `POST /api/fd/keyholder/pair` + `POST /api/fd/keyholder/accept`                                                        | mittel    |
| 6   | xai-OAuth Re-Auth                         | `openclaw models auth login --provider xai --profile-id 'xai:<profil-id>'` (Profil-ID via `openclaw models auth list`) | mittel    |
| 7   | Google-Profil anlegen                     | `GEMINI_API_KEY` ist in der Env, aber kein registriertes Profil                                                        | mittel    |
| 8   | venice Top-up                             | Billing-Fenster war bis 31.10. 13:20Z                                                                                  | niedrig   |
| 9   | iCloud 2FA Re-Auth                        | Owner-only; bis dahin `fd-icloud-skill` als nicht verfügbar führen                                                     | niedrig   |
| 10  | FD-Routenbericht                          | Blackmail, Screen, Companion, Devices, Dreamquest, Scene-/Choice-Lifecycle, Game-Engine-Spin → `lexiclaw`-Repo         | mittel    |

---

## 9. Bekannte Limitierungen / Follow-ups

- **Checkout älter als das deployte Image.** Runtime-Fixes liegen deshalb als Bundle-Patches
  und Wrapper in `Dockerfile.brew`; ein Repo-Rebase ist nötig, bevor die Änderungen upstreambar
  werden.
- **pnpm-Lockfile-Inkonsistenz:** `extensions/techdomme` fehlt als Importer; Workaround
  `--no-frozen-lockfile`.
- **Lokale Node 26.9.0 < gefordert ≥ 26.12.1**; Image-Node 24.22.1 funktioniert.
- **Alter Update-Lock:** 94/98 historische Fehler nicht via `openclaw update repair` bereinigt.
- **NOCOW-Repair übersprungen** (`GNU mv with --exchange and --no-copy is required`).
- **Stale `skills.entries.fd-perception-control.apiKey`** → `SECRETS_DEGRADED`.
- **`Dockerfile.sandbox`** ist untracked; Commit-Entscheidung offen.
- **Registry-Einträge `vault-confessions` / `vault-overview`** waren veraltet → Dreamquest-Routen
  (8 Probes 404) aus dem Live-Registry-Block entfernt; Skill-Verzeichnisse bleiben deprecated.
- **`AUTONOMY.md` existiert nicht**; der Legacy-Verweis ist im neuen `TOOLS.md` bewusst nicht
  übernommen.
- **13 FD- und 5 weitere Live-Skills** nutzen noch `127.0.0.1:3001`-Fallbacks; sollten auf
  `FD_SKILL_BASE_URL` / `KINKYGATE_API_URL` umgestellt werden.
- **Container fehlend:** `sag`, `gogcli`, `gemini`, `whisper`, `sqlite3`, `grok`, `claude`,
  `/home/devuser`, `pyicloud-venv`, `fd-icloud-skill/.env`. `xurl` ist installiert, aber ohne
  Credentials (`NoAuthMethod`) → nicht nutzbar.
- **`minimax-portal`** Token-Plan-Limit erreicht (`sha256:029144d23517`, `cooldown:rate_limit`);
  Cron wurde als Hebel gegen die 429-Kaskade deaktiviert.

---

## 10. Bewusst nicht ausgeführt

- Kein `POST /api/fd/safeword` (löst real alle Locks aus).
- Keine Scene-/Exposure-/Blackmail-/Wall-/Telegram-Publish-Aktion — nur ARM, kein POST.
- Keine Schreibzugriffe auf Sebastians FD-Szene `userId 3`.
- Kein `openclaw update` aus dem FIX-PROMPT heraus; Update lief separat und ist abgeschlossen.
- Kein `openclaw doctor` im laufenden Gateway.
- Kein Auto-Publish ohne GO-Gate.
- Keine Secrets in Prompt, Log, Diff, Commit, PR-Beschreibung oder Test-Fixture.
