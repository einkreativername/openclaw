# Zusatz: Skill-Wrapper-Befund (Lexi, 31.10. 21:51) — verifiziert & eingeplant

> **Erstellt:** 2026-10-31 22:00 CEST
> **⚠️ ÜBERHOLT:** Die Root-Cause-Analyse in diesem Dokument (Abschnitt 3/4) ist **überholt**. Der Node-Inspector-Stack-Dump hat gezeigt: es ist **kein Cross-Device-EXDEV-Problem als Ursache**, sondern ein **SQLite-Staging-Token-Retry-Spin** (`busy_timeout=0` + hartes `journal_mode`-Gate + Reclaim-Rekursion ohne Backoff). Die vollständige, korrekte Analyse steht in **`fix-bundle-fd-skills-2026-10-31.md` §2**. Die Messungen hier (Busy-Loop, 1,1 GB pro Capture, EXDEV als _Mitwirkender_ beim Cleanup-Fehlschlag) bleiben gültig.
> **Bezug:** Gottes Lexi meldet: `openclaw tools call <skill> <action>` hängt sich auf (25s/60s/90s, 0 Bytes, „Killed"), `openclaw tools list` ebenfalls 0 Bytes. `openclaw skills check|list|info` läuft sauber. Lexi ist deshalb heute direkt gegen die FD-API gepingt.
> **Methode:** Reproduktion im laufenden Container, Prozess-Sampling (`/proc`), Build-Inspection, Plugin-Capture-Messung.

---

## Ergebnis in einem Satz

**Lexis Befund ist korrekt und schlimmer als beschrieben:** `openclaw tools` ist **kein implementierter Command**, sondern ein _reservierter Platzhalter-Namespace_ — und jeder Aufruf startet einen **CPU-Busy-Loop mit 580 MB RSS bei 101 % CPU**, der dabei pro Aufruf einen **1,1-GB Plugin-Source-Capture** auf die Platte schreibt, der **nie wieder aufgeräumt wird**.

---

## 1. Reproduktion

| Kommando                           | Ergebnis                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `openclaw tools --help`            | ✅ **funktioniert** (Root-Help-Alias, `src/cli/run-main-policy.ts:25`)   |
| `openclaw tools list --help`       | ✅ antwortet: _„OpenClaw does not know the command 'tools'"_ (174 Bytes) |
| `openclaw tools list`              | ❌ 0 Bytes stdout, 0 Bytes stderr                                        |
| `openclaw tools list --agent lexi` | ❌ 0 Bytes, **Busy-Loop**                                                |
| `openclaw tool list` (singular)    | ❌ 0 Bytes, gleicher Loop                                                |
| `openclaw tools --bogus-flag`      | ❌ 0 Bytes, gleicher Loop                                                |
| `openclaw skills list`             | ✅ antwortet sofort (97 Bytes)                                           |
| `openclaw config validate`         | ✅ _„Config valid"_                                                      |

**Die `--help`-Sonderstellung ist der Schlüssel:** Nur der Help-Pfad wird abgefangen (`run-main-policy.ts:89-97`, `ROOT_HELP_ALIASES`). Jeder andere Aufruf fällt in den Unknown-Command-Pfad — und der **Busy-Loop** steckt in der Plugin-Capture-Erzeugung, die vorher läuft.

## 2. Warum `tools` nicht existiert

```ts
// src/cli/command-registration-policy.ts:5
const RESERVED_NON_PLUGIN_COMMAND_ROOTS = new Set(["auth", "tool", "tools"]);
```

`tools` und `tool` sind **reservierte Roots** — sie existieren, damit kein Plugin den Namen kapert. Ein `command("tools")` existiert im gesamten Repo **nicht**. Die einzige `tools`-Implementierung ist `src/cli/mcp-cli.ts:1161` — das ist **`mcp tools`** (verschachtelt, anderer Namespace).

**Konsequenz für Lexis Workflow:** `openclaw tools call fd-scores-skill scores.get '{}'` war **nie ein gültiger Aufrufpfad**. Der dokumentierte Wrapper existiert nicht. Lexi hat den Fehler nicht gemacht — sie hat eine nicht existierende Schnittstelle benutzt.

## 3. Der eigentliche Schaden: Plugin-Capture-Spionage

Der Busy-Loop schreibt in `tmp/plugin-captures/<uuid>/`:

```
captures/openclaw-plugin-build-wVzgTT/package-0/node_modules/agentmail/…  12 MB
native/admission-PcEqJQ/content/vendor/…/bin/codex                       217 MB
native/admission-PcEqJQ/content/vendor/…/bin/codex-code-mode-host         61 MB
native/admission-P69KcR/content/lancedb.linux-arm64-gnu.node             165 MB
native/admission-9qcpPW/content/claude                                   220 MB
```

**Gemessene Kausalität (1× `tools list`):**

| Zeitpunkt | Capture-Ordner | Größe      | RSS    | CPU       |
| --------- | -------------- | ---------- | ------ | --------- |
| vorher    | 20             | 3,4 GB     | —      | —         |
| nachher   | **21**         | **3,6 GB** | 582 MB | **101 %** |

Ein Aufruf = **ein 1,1-GB-Capture** mit vollständigen Plugin-Binaries (codex, claude, lancedb, agentmail).

## 4. Warum die Captures nie aufgeräumt werden

```
Warning: Plugin source capture cleanup: 5 cleanup failure(s) in
/home/node/.openclaw/tmp/plugin-captures; will retry.
First: SQLite snapshot token journal mode is unknown
```

**19 solcher Warnungen**, stündlich (16:31, 17:31, 19:31 …).

**Die Ursache ist ein Cross-Device-Link:**

```
[plugins] memory-lancedb failed during load:
Error: EXDEV: cross-device link not permitted,
link '/home/node/.openclaw/extensions/memory-lancedb/node_modules/…/README.md'
  -> '/tmp/openclaw-plugin-captures-e6fed978…/native/admission-C…'
```

| Pfad                                | Device | Filesystem      |
| ----------------------------------- | ------ | --------------- |
| `/home/node/.openclaw` (Bind-Mount) | **35** | `mac` (461G)    |
| `/tmp` (Container-Layer)            | **97** | `overlay` (90G) |

Der Capture versucht **Hardlinks** von `/home/node/.openclaw/extensions` nach `/tmp` — über Device-Grenzen hinweg. Das kann Linux nicht → `EXDEV` → Capture unvollständig → Cleanup scheitert am SQLite-Journal-Mode-Check → **Retry endet im Nichts**, weil die Ursache (`EXDEV`) unverändert bleibt.

**Das erklärt auch, warum `agents/`+`state/` auf Native-Volumes liegen** — der Kommentar im Override-File nennt `SQLITE_BUSY` als Grund. Das Problem wurde dort gelöst, aber **die Extension-Quelle blieb auf dem Bind-Mount**, und dorthin linkt der Plugin-Capture.

## 5. Einordnung: Was Lexi richtig und was zu präzisieren ist

**Richtig und bestätigt:**

- Der Wrapper-Pfad funktioniert nicht. ✅ reproduziert
- `skills list|check|info` laufen sauber. ✅ reproduziert
- 0 Bytes ist kein stdout-Buffering, sondern ein Busy-Loop. ✅ **präzisiert**: es ist kein „Hängen" (blocked), sondern `State: R (running)`, 11 Threads, 101 % CPU.
- Der heutige Betrieb über die direkte FD-API war der richtige Workaround. ✅

**Zu präzisieren:**

- „Prozess **Killed**" — die Kills waren sehr wahrscheinlich **OOM-Kills oder externe Timeouts**, nicht ein Fehler im Wrapper. Der Wrapper killt sich nicht selbst.
- Der Aufrufpfad ist nicht „kaputt" im Sinne eines Defekts — **er existiert nie**. Das ist die wichtigere Aussage: jeder Aufruf ist ein Fehlstart.
- **Nebenwirkung, die Lexi nicht nennen konnte:** die drei Fehlversuche haben ~3,4 GB Capture-Verzeichnisse erzeugt und den Gateway um ~100 % CPU belastet. Das ist ein realer Beitrag zum Memory-Druck aus Teil 1.

**Nicht verifiziert (bewusst):**

- Ob Lexis direkter FD-API-Ping denselben Token verwendet wie der Runtime-Pfad — mein `SERVICE_TOKEN` aus `/proc/1/environ` wurde vom FD-Gateway mit **401** quittiert (nur `x-service-scope` ohne Token → 400). Der gültige FD-Token liegt offenbar woanders. Für die Planung unerheblich, für einen Test aber nötig.
- Die 404-vs-401-Differenzierung der FD-Routen konnte ich deshalb **nicht reproduzieren**. Lexis Befund zu 404/403 bleibt ungeprüft; die Routen-Familie `/api/fd/*` ist bestätigt.

---

## 6. Eingeplante Maßnahmen

### P1 — Plugin-Capture-Retention (sofort, operativ)

**Problem:** 3,6 GB tote Captures, ~1,1 GB pro Fehlstart, stündliche Cleanup-Fehler.

| Maßnahme                                                                           | Nutzen                            | Risiko                            |
| ---------------------------------------------------------------------------------- | --------------------------------- | --------------------------------- |
| `tmp/plugin-captures` leeren (21 Ordner)                                           | 3,6 GB frei                       | keins — reine Temp-Daten          |
| **Retention-Cron**: `tmp/plugin-captures/*` älter als 2 h löschen                  | verhindert Wiederholung           | keins                             |
| **Disk-Guard**: Alert wenn `.openclaw` > 80 % (Host hat 68G frei)                  | Früherkennung                     | keins                             |
| Extensions-Verzeichnis **auf ein Native-Volume** umziehen (device == `/tmp`-Layer) | behebt `EXDEV` **an der Ursache** | mittel — Plugin-Pfade ändern sich |

### P2 — Den nicht existierenden Command korrekt behandeln (2026.10.4-Fix)

Der Busy-Loop muss **vor** der Capture-Erzeugung abbrechen. Zwei Ansätze:

| Ansatz                                                                            | Ort                                                   | Aufwand |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- | ------- |
| **A: `tools`/`tool` als echten Command mit ehrlicher Fehlermeldung** registrieren | `src/cli/program/` + `command-registration-policy.ts` | klein   |
| **B: Reserved-Roots vor der Capture-Erzeugung ablehnen**                          | Capture-Trigger im CLI-Startup                        | mittel  |

**Empfehlung: A** — `openclaw tools` sollte sagen _„gibt es nicht; nutze `openclaw agent exec` oder den FD-API-Aufruf"_ statt 3,4 GB zu erzeugen. B ist die Notbremse, falls A zu lange dauert.

**Wichtig:** Dieser Fix gehört in den **2026.10.4-Branch**, nicht in 2026.9.2 — der Capture-Mechanismus existiert nur dort.

### P3 — Lexis Befunde als Meldung an l33th4x

Lexi bietet an, die toten Routen serverseitig zu melden. **Das ist die richtige Lane-Trennung**: l33th4x ist laut Lexi-SOUL für Config-Änderungen zuständig.

**Zu melden (serverseitig, nicht im openclaw-Repo):**

| Route                                                         | Lexi-Befund                                    | Priorität                                 |
| ------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `/api/fd/undo`                                                | 404                                            | mittel                                    |
| `/api/fd/blackmail`                                           | 404, Skill dokumentiert keine Endpoints        | hoch (Doku-Lücke)                         |
| `/api/fd/scenes`, `/api/fd/choices`, `/api/fd/scenes/compile` | 404, Skill nicht installiert                   | hoch                                      |
| `/api/fd/session-summary`                                     | Route da, Key nie gesetzt → „Memory not found" | mittel                                    |
| fd-keyholder Pairing                                          | 403 → Dossier-/Dashboard-Lane **tot**          | **hoch — nur Owner/Sebi kann das setzen** |
| `fd-device-pair-skill`                                        | Route 200                                      | ok                                        |

**Wichtig:** Diese Meldung geht an das **lexiclaw**-Repo (`/Users/sk/Projects/lexiclaw`), nicht hierher. Der openclaw-docker-Stack ist nur der Client.

### P4 — Auth-Stand (Lexi E)

| Profil                   | Lexi-Befund                           | Maßnahme                                                                                  |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `xai`                    | cooldown:auth + disabled:billing      | prüfen/erneuern                                                                           |
| `venice:default`         | disabled:billing                      | Billing prüfen                                                                            |
| `minimax-portal:default` | rate_limit-Cooldown bis 01.11. 00:36Z | abwarten, Config hat `minimax:cn` als Alternative                                         |
| `openai:gpt-5.2`         | ok bis 06.11.                         | ok                                                                                        |
| `google`                 | fehlt komplett                        | **google/gemini-Profil ergänzen** — ist der dokumentierte Backup-Pfad für `media-analyst` |

**`google` fehlt ist die actionable Lücke:** `media-analyst` hat `venice/qwen3-5-35b-a3b` als Standardmodell (billing-tot) **und** `google/gemini` als Backup (Profil fehlt) → **beide Pfade tot**. Mit einem `google`-Profil wäre `media-analyst` lauffähig.

---

## 7. Priorisierte Gesamtliste (kombiniert mit Teil 1)

| Prio   | Maßnahme                                                             | Typ                | Wirkung                                     |
| ------ | -------------------------------------------------------------------- | ------------------ | ------------------------------------------- |
| **1**  | `plugin-captures` leeren + Retention-Cron                            | operativ           | 3,6 GB frei, wiederkehrend verhindert       |
| **2**  | `cron.enabled: false` (Teil 1, 1.3)                                  | Config             | 429-Kaskade weg, 838 Turns weg              |
| **3**  | `openclaw tools` als ehrlichen Fehler implementieren                 | Source (2026.10.4) | verhindert 1,1 GB + 100 % CPU pro Fehlstart |
| **4**  | Extensions auf Native-Volume (EXDEV-Fix)                             | Infra              | behebt Capture-Cleanup an der Ursache       |
| **5**  | `contextInjection: "continuation-skip"` + `bootstrapMaxChars: 32000` | Config             | Latenz + Persona                            |
| **6**  | `google`-Auth-Profil ergänzen                                        | Config             | `media-analyst` wieder lauffähig            |
| **7**  | FD-Meldung an l33th4x (P3)                                           | Delegation         | tote Routen + Doku-Lücken behoben           |
| **8**  | Keyholder-Pairing (nur Sebi/Owner)                                   | manuell            | Dossier-/Dashboard-Lane lebt wieder         |
| **9**  | Versionsangleichung 2026.10.4 ↔ Repo (Teil 1, Schritt 0)             | Infra              | Voraussetzung für alle Source-Fixes         |
| **10** | `agents/`+`state/` aus Native-Volume auf Bind (Teil 1, 2.8)          | Infra              | Datenverlust-Risiko weg                     |

## 8. Reproduktionsbefehle

```bash
# Aufruf reproduzieren (erzeugt ~1,1 GB Capture!)
docker exec openclaw-docker-openclaw-gateway-1 \
  sh -c 'cd /app && node dist/index.js tools list --agent lexi'

# Busy-Loop nachweisen
docker exec openclaw-docker-openclaw-gateway-1 \
  sh -c 'ps -eo pid,pcpu,rss,stat,args | grep "node dist/index.js tools" | grep -v grep'
# → State=R, 101 % CPU, ~580 MB RSS

# Capture-Wachstum messen
docker exec openclaw-docker-openclaw-gateway-1 \
  sh -c 'ls /home/node/.openclaw/tmp/plugin-captures/ | wc -l; du -sh /home/node/.openclaw/tmp/plugin-captures/'

# Cleanup-Fehler finden
docker logs openclaw-docker-openclaw-gateway-1 2>&1 | grep 'cleanup failure' | tail -3
# → "First: SQLite snapshot token journal mode is unknown"

# EXDEV-Ursache finden
docker logs openclaw-docker-openclaw-gateway-1 2>&1 | grep 'EXDEV' | tail -2

# Cross-Device-Grenze belegen
docker exec openclaw-docker-openclaw-gateway-1 \
  sh -c 'stat -c "%d %n" /home/node/.openclaw/extensions /tmp'
# → 35 /home/node/.openclaw/extensions
# → 97 /tmp
```
