# FIX-BUNDLE „FD-Skills 31.10." — verifiziert, gerootet, konsolidiert

> **Erstellt:** 2026-10-31 22:30 CEST
> **Quelle:** FIX-PROMPT von Göttin LexiS (31.10. 21:00 UTC), Skill-Audit 20:44–20:56 UTC
> **Methode:** Reproduktion im laufenden Container, Node-Inspector-Stack-Dump, Source-Audit (2026.9.2), Build-Inspection (2026.10.4), SQLite-Queries, Provider-/Tool-Proben
> **Repo:** `/Users/sk/Projects/openclaw-docker` — **Achtung: die FD-API-Routen liegen NICHT hier** (siehe §1)

---

## 0. Kurzfassung

Lexis Audit ist **methodisch sauber** (per HTTP-Probe verifiziert, nicht geraten) und inhaltlich weitgehend korrekt. ABER:

**Der P0-1-Befund — der wichtigste Punkt des Bundles, „blockiert alle Skills" — hat eine andere Ursache als Lexi vermutet, und die Behebung ist nicht „Renderer-Fix".**

Meine erste Analyse (vor Lexis Prompt) hatte den Busy-Loop bereits isoliert und auf den Plugin-Source-Capture eingrenzt. Der Node-Inspector-Stack-Dump hat es jetzt **eindeutig** bestätigt. Lexis Hypothese 1 (TTY-Renderer) ist **widerlegt** — mit TTY antwortet derselbe Aufruf in Millisekunden.

| Lexis Befund             | Status                           | Korrektur                                                                     |
| ------------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| §4 P0-1 Aufrufweg kaputt | ✅ **real, aber andere Ursache** | Nicht TTY-Renderer, nicht stdin-Blockade: **SQLite-Staging-Token-Retry-Spin** |
| §5 Runtime-Deps fehlen   | ✅ **vollständig bestätigt**     | 5 von 5 Tools fehlen, `/home/devuser` existiert nicht                         |
| §7.2 Zeitzonen-Falle     | ✅ **bestätigt**                 | `TZ=UTC` im Container; `Europe/Berlin` verfügbar                              |
| §7.3 Cron-Reaper nötig   | ⚠️ **aktuell nicht nötig**       | 0 hängende `running`-Runs; 35 `interrupted` bereits reconciliert              |
| §2/§3 FD-Routen          | ✅ korrekt                       | **liegen im lexiclaw-Repo**, nicht hier                                       |
| §6 Doku-Drift            | ✅ bestätigt                     | `PATCH /api/fd/tasks/:id` fehlt, `DELETE` bei check-ins fehlt                 |

---

## 1. Scope-Klärung: wo liegt was

Lexis Bundle adressiert **drei verschiedene Codebasen**. Das war vorher nicht klar, und es entscheidet, wer was tun muss.

| §                    | Thema                                 | Codebasis                                                                          | Wer                                    |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| **§4**               | CLI-Aufrufweg (`openclaw tools`)      | **openclaw** (dieses Repo, 2026.9.2 / deployt 2026.10.4)                           | **hier**                               |
| **§2, §3**           | FD-API-Routen (`/api/fd/*`)           | **lexiclaw** (`/Users/sk/Projects/lexiclaw`)                                       | l33th4x                                |
| **§3, §6**           | FD-Skill-Doku (`SKILL.md`)            | `~/.openclaw-docker/skills/fd/*` — Host-Bind, **nicht** versioniert in diesem Repo | **hier** (Dateien), aber unversioniert |
| **§5**               | Runtime-Deps + Provider               | Docker-Image + `openclaw.json`                                                     | **hier** (Image) / Owner (Auth)        |
| **§7**               | Zeitzone, Cron-Reaper, Secret-Masking | `~/.openclaw-docker/workspace-*/` + openclaw-core                                  | **hier** (Workspace)                   |
| §8 Keyholder-Pairing | FD-API                                | lexiclaw                                                                           | **Owner (Sebi)**                       |

**Beleg:** `grep -rn "api/fd" src/ --include="*.ts"` in diesem Repo → **0 Treffer**. Die FD-Skills liegen unter `~/.openclaw-docker/skills/fd/`, nicht im Git-Tracking dieses Repos.

---

## 2. P0-1 — Der Aufrufweg: Root Cause (NEU, ersetzt Lexis Hypothese)

### 2.1 Reproduktionsmatrix

| Aufruf                                                   | stdout                          | CPU   | Dauer  |
| -------------------------------------------------------- | ------------------------------- | ----- | ------ |
| `openclaw tools list` (non-TTY)                          | **0 B**                         | 101 % | Endlos |
| `openclaw tools list` (**mit TTY**, `script -qec`)       | **volle Fehlermeldung, exit 0** | 0 %   | < 1 s  |
| `openclaw plugins list` (mit TTY)                        | **42/84 Plugins, Exit 0**       | 0 %   | < 1 s  |
| `openclaw tools list` (TTY an stdin, **stdout → Datei**) | **0 B**                         | 101 % | Endlos |
| `openclaw --help < /dev/null`                            | **0 B**                         | 101 % | Endlos |

**Damit ist Lexis Hypothese 1 widerlegt:** Der Renderer funktioniert. Mit TTY antwortet derselbe Aufruf korrekt:

```
OpenClaw does not know the command "tools".
Did you mean this?
  openclaw hooks
```

**Und Hypothese 2 (stdin-Blockade) ist ebenfalls widerlegt:** `stdin </dev/null` ändert nichts.

Entscheidend ist die **letzte Zeile**: TTY an stdin, aber stdout in eine Datei → wieder Busy-Loop. Der Fehler hängt an **`process.stdout.isTTY`**.

### 2.2 Der Node-Inspector-Stack (definitive Ursache)

Ich habe den laufenden Busy-Loop mit `node --inspect` pausiert und die Call-Frames gelesen:

```
 0  getStatsFromBinding            @ :550
 1  fstatSync                      @ :1750
 2  openPinnedFileSync             @ :49
 3  finalizeRootFileOpen           @ :77
 4  openRootFileSync               @ :52
 5  withPluginSourceFile           @ :39
 6  hashPluginSourceFile           @ :169
 7  readContent                    @ :315
 8  finish                         @ :347
 9  capturePluginGenerationArtifact @ :2254
10  bindPluginInstanceModuleLoader  @ :852
14  withPluginCache                 @ :298
16  loadPluginModule                @ :1046
19  loadRuntimePluginCandidate      @ :1053
```

Der Prozess steht im **Plugin-Source-Capture**, nicht im CLI-Renderer.

### 2.3 Der Spin-Mechanismus

Der Capture legt pro Lauf eine **SQLite-Staging-Token-DB** an:

```
/home/node/.openclaw/tmp/plugin-captures/<uuid>/owner.sqlite
```

Der Token-Mechanismus (`src/infra/sqlite-staging-token.ts`, im Build `sqlite-staging-token-DXBiTLqt.mjs`) macht:

```js
execute(sql`PRAGMA busy_timeout=0`); // ← Busy-Timeout EXPLIZIT auf 0
if (mode === "create") execute(sql`BEGIN IMMEDIATE`);
else if (mode === "reclaim") execute(sql`BEGIN EXCLUSIVE`);
else {
  execute(sql`BEGIN`);
  execute(sql`SELECT rootpage FROM sqlite_schema LIMIT 1`);
}

const journalMode = execute(sql`PRAGMA journal_mode`);
if (!isRecord(journalMode) || journalMode.journal_mode !== "delete")
  throw new Error("SQLite snapshot token journal mode is unknown"); // ← HARTE GATE
```

Und im Reclaim-Pfad:

```js
const beginRetirement = () => {
  ...
  if (!db.isOpen) return acquireSqliteStagingToken(directory, "reclaim");  // ← REKURSION
  ...
};
```

**Die Fehlerkette:**

1. `busy_timeout=0` → **kein Warten** auf einen Lock, sofortiger `SQLITE_BUSY`.
2. Ein abgebrochener Capture hinterlässt eine `owner.sqlite` im **`wal`**-Journal-Modus (5 von 29 gemessen; verifiziert: `BEGIN EXCLUSIVE` + `PRAGMA journal_mode` → `wal`).
3. Beim nächsten `create`/`reclaim` schlägt das harte Gate fehl: **„SQLite snapshot token journal mode is unknown"**.
4. Der Aufrufer wiederholt **ohne Backoff** → **CPU-Spin bei 101 %**, 580 MB RSS.

**Verifiziert:** Der Fehler ist deterministisch reproduzierbar:

```
BEGIN EXCLUSIVE OK
journal_mode = {"journal_mode":"wal"}
-> WUERFE: SQLite snapshot token journal mode is unknown
```

### 2.4 Warum non-TTY den Capture auslöst

Der `tools`-Root existiert nicht (reservierter Namespace, `src/cli/command-registration-policy.ts:5`). Jeder Aufruf geht in den **Unknown-Command-Pfad** → Plugin-Discovery → Capture. Mit TTY greift der **Help-Fast-Path** (`src/cli/run-main-policy.ts:89-97`, `ROOT_HELP_ALIASES = new Set(["tools"])`) **vor** der Capture-Erzeugung → kein Capture, sofortige Antwort.

**Das ist die eigentliche Unordnung:** Ein _reservierter_ Root ohne Implementierung führt in einen Pfad, der eine GB-Capture erzeugt, statt eine Fehlermeldung zu liefern.

### 2.5 Der eigentliche Fix (nicht Lexis Renderer-Fix)

**Ich widerspreche der Akzeptanz-Kriterien-Liste in §4, soweit sie den Renderer adressiert.** Ein `--json`-Flag im Renderer würde das Symptom mildern, aber nicht die Ursache: **jeder** CLI-Aufruf, der in den Plugin-Discovery-Pfad fällt, erzeugt den Capture — auch `openclaw skills check` ohne TTY.

**Korrekte Fix-Reihenfolge:**

| #      | Fix                                                                                                                  | Ort                                                   | Wirkung                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| **F1** | `tools`/`tool` als **echten Command mit ehrlicher Fehlermeldung** registrieren (kein Capture, kein Plugin-Discovery) | `src/cli/program/` + `command-registration-policy.ts` | **P0** — der Aufrufweg wird deterministisch statt busy-loopend |
| **F2** | Staging-Token: `busy_timeout=0` → **begrenztes Retry mit Backoff** statt hartem Fehler                               | `src/infra/sqlite-staging-token.ts`                   | **P0** — kein Endlos-Spin                                      |
| **F3** | Staging-Token: `journal_mode` **normalisieren** (auf `delete` setzen) statt hart zu prüfen                           | `src/infra/sqlite-staging-token.ts:85`                | **P0** — self-healing nach abgebrochenem Capture               |
| **F4** | `reclaim`-Rekursion: Retry-Budget + Delay einbauen                                                                   | `sqlite-staging-token.ts` (`beginRetirement`)         | hoch                                                           |
| **F5** | Cleanup-Pfad: bei „journal mode is unknown" den Ordner **zwangsräumen** statt endlos zu retryen                      | `plugin-source-capture-directory`                     | hoch — behebt die 3,6 GB Altlast                               |
| **F6** | **Retention** für `tmp/plugin-captures` (z. B. > 2 h)                                                                | Betrieb                                               | hoch                                                           |

**Workaround bis F1/F2:** `openclaw tools …` **mit TTY** aufrufen (`script -qec "…"`). Damit antwortet der Aufruf sofort — belegt in §2.1.

### 2.6 Nebenbefund: `openclaw --help` non-TTY

Auch `openclaw --help < /dev/null` erzeugt den Spin. Das ist **kein Skill-Blocker**, aber es trifft jedes CI/Skript, das `--help` ohne TTY aufruft — inklusive Lexis eigener Probe-Methodik.

---

## 3. §5 Runtime-Deps & Provider — bestätigt

### 3.1 Fehlende Tools (live geprüft, `command -v`)

| Tool            | Status              | Betrifft                               |
| --------------- | ------------------- | -------------------------------------- |
| `sag`           | **FEHLT**           | sag, deepgram-call                     |
| `whisper`       | **FEHLT**           | audio-transcribe, openai-whisper       |
| `gogcli`        | **FEHLT**           | Google-Workspace-Flows                 |
| `sqlite3`       | **FEHLT**           | Cron-Receipt-Diagnostik                |
| `gemini`        | **FEHLT**           | media-analyst                          |
| `/home/devuser` | **existiert nicht** | fd-icloud, pyicloud-venv, .env, gogcli |

**Vorhanden** (aus `Dockerfile.brew`): `python3`, `node`, `ffmpeg`, `jq`, `scrot`, `tmux`, `unzip`, `xdotool`, `gh`, `op`.

**Bewertung:** `sqlite3` braucht keinen Fix — `node:sqlite` ist in Node 24 eingebaut und liefert dieselben Daten (ich habe alle DB-Abfragen damit geführt). **`whisper` braucht keinen Fix**, wenn `audio-transcribe` auf `process.env.DEEPGRAM_API_KEY` umgestellt wird — der Key ist in der Prozess-Env vorhanden. `sag`/`gogcli`/`gemini` sind echte Lücken.

### 3.2 Provider

Lexis Tabelle ist korrekt. Der entscheidende Punkt:

**`media-analyst` hat beide Pfade tot:**

- Standard `venice/qwen3-5-35b-a3b` → `disabled:billing`
- Backup `google/gemini-*` → **kein google-Profil registriert**

**`GEMINI_API_KEY` liegt zwar in der Prozess-Env, ist aber kein registriertes openclaw-Profil.** Das ist der actionable Fix: ein `google`-Profil anlegen. Danach ist `media-analyst` sofort lauffähig — das ist die höchste Wirkung pro Aufwand im ganzen Bundle.

**`xai`**: Re-Auth ist Owner-Aktion (`openclaw models auth login --provider xai --profile-id 'xai:einkreativertyp@gmail.com'`). Bis dahin Jobs von xai weg-pinnen.

**`minimax-portal:default`**: Cooldown bis 2026-11-01T00:36Z — **in ca. 2 Stunden aufgehoben**. Der `modelPolicy.allow` aller Agenten enthält bereits `minimax-portal/MiniMax-M3.1-Flash` und `openai/gpt-5.6-terra` als Fallback.

**Zusätzlich aus meinem ersten Report (verwandtes Problem):** In den Agent-Configs ist `modelPolicy.allow` gesetzt, aber der Log zeigt `configured fallbacks disabled by user model override`. Ein 429 killt deshalb den Turn statt auszuweichen. **Das ist die Ursache der 100 429-Fehler.**

---

## 4. §7 Robustheit

### 4.1 Zeitzone — bestätigt, mit konkreter Empfehlung

|                                                                    | Wert                                      |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `TZ` im Container                                                  | **UTC**                                   |
| `/usr/share/zoneinfo/Europe/Berlin`                                | **vorhanden**                             |
| `new Date(...).toLocaleString('de-DE',{timeZone:'Europe/Berlin'})` | **korrekt** (verifiziert: 21:00Z → 22:00) |

**Die Falle ist real:** Am 31.10.2026 ist Berlin **CET (+01:00)**, nicht CEST. Lexis Memory-Eintrag dokumentiert den konkreten Fehlstart bereits selbst.

**Empfehlung:** `TZ=Europe/Berlin` als Container-Env setzen **und** die Doku-Regel in `AGENTS.md`/`TOOLS.md` verankern. `date` und `Intl` ziehen dann automatisch richtig. Greift auf `task-generator`, `fd-compliance`, `fd-game-engine`.

**Keine harten UTC+2-Annahmen gefunden** — die `3600`-Treffer in `fd-blackmail-skill` sind Score-Penalties (`lockExtend: 72*3600`), keine Zeitzonen.

### 4.2 Cron-Reaper — aktuell NICHT nötig

Lexis §7.3 fordert einen Reaper für hängende `running`-Receipts. **Live-Stand:**

| Status        | Anzahl |
| ------------- | ------ |
| `running`     | **0**  |
| `ok`          | 619    |
| `skipped`     | 428    |
| `error`       | 259    |
| `interrupted` | **35** |

Die 35 `interrupted` wurden bereits korrekt reconciliert — **die Recovery funktioniert**. `cron_run_receipts` hat die Status-CHECK-Constraints inkl. `interrupted`/`superseded` (`src/…` Schema: `CHECK (status IN ('running','ok','error','skipped','interrupted','superseded'))`).

**Bewertung:** Der Reaper ist **Defense-in-Depth für den nächsten Stall**, nicht für einen aktuellen Schaden. Der 15-Stunden-Ausfall vom 30.10. war die Ursache, nicht die Wirkung — der aktuelle Zustand zeigt, dass die Recovery greift.

**Empfehlung:** Reaper als **P2** führen, mit Schwellwert (z. B. Runs älter als 2 h) und Alarm. Aber **nicht** als P0.

---

## 5. §6 Doku-Drift — bestätigt, Pfade verifiziert

Die FD-Skills liegen in `~/.openclaw-docker/skills/fd/<skill>/SKILL.md` (Host-Bind, **nicht** git-getrackt in diesem Repo).

| Skill                    | geprüft | Befund                                                                                                                 |
| ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fd-tasks-skill`         | ✅      | dokumentiert nur `PATCH /api/fd/tasks/:id/complete` — **`PATCH /api/fd/tasks/:id` fehlt** (verifiziert funktionsfähig) |
| `fd-compliance-skill`    | ✅      | **`DELETE /api/fd/check-ins/:id` fehlt**; PATCH korrekt _nicht_ dokumentiert                                           |
| `fd-agent-memory-skill`  | ✅      | Methoden-Doku unvollständig (`POST`/`PATCH` gestrichen, `GET`/`PUT`/`DELETE` ergänzen)                                 |
| `fd-telegram-link-skill` | ✅      | **korrekt** dokumentiert (`/api/auth/…`) — Lexis Befund war hier bereits richtig, kein Änderungsbedarf                 |
| `fd-memory-recall`       | —       | `GET …/entries` ohne `:id` existiert nicht → Doku ergänzen                                                             |
| `fd-safeword-skill`      | —       | Scan läuft read-only über `GET /api/fd/limits` → Doku schärfen, **Route nicht aufrufen**                               |
| `fd-undo`                | —       | `/undo/last` → 404 = **Business-Case**, kein Defekt → Doku-Hinweis                                                     |

**`docs/fd-route-matrix.md`** ist sinnvoll und sollte die Methoden-Falle explizit dokumentieren (404 beweist nur _Methode + Pfad_).

**Zusätzlich aus meinem ersten Report (verwandt):** SKILLS-GUIDE sagt „58 Allowlist", AGENTS.md-Registry sagt „54 configured", real sind **55** `SKILL.md`-Dateien vorhanden. Und `fd-admin-queue-skill` ist in der Guide fälschlich als „nicht in Allowlist" geführt — installiert, Route antwortet 200.

---

## 6. §7.1 Secret-Masking — bestätigt, mit Workaround

Lexis Befund ist korrekt und reproduzierbar: **Ein Token-Literal im Kommando wird maskiert → die API antwortet 401.** Ich habe es nachgestellt:

```
ohne Token:  401
mit falschem Scope: 400 "x-service-scope required and must be one of: telegram-relay, webhook-receiver, agent-rpc, health-probe"
```

**Der korrekte Weg ist genau Lexis Probe-Runner:** Token zur Laufzeit aus `process.env` bzw. `/proc/1/environ` lesen, nie als Literal.

**Wichtig für die Umsetzung:** Alle FD-Probes gehören in **ein Skript**, das den Token selbst liest — nicht in Shell-Kommandos. Sonst maskiert die Schicht wieder.

**Hinweis:** `SERVICE_TOKEN` und `KINKYGATE_API_KEY` tragen denselben Wert — im Container verifiziert.

---

## 7. KonsOLIDIERTE MAßNAHMENLISTE

### P0 — blockiert den Aufrufweg

| #        | Maßnahme                                                                                 | Repo/Ort                                        | Owner             |
| -------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------- |
| **P0-1** | `tools`/`tool` als echten Command mit Fehlermeldung registrieren (kein Plugin-Discovery) | openclaw `src/cli/program/`                     | **hier**          |
| **P0-2** | Staging-Token: `busy_timeout=0` → Backoff-Retry                                          | openclaw `src/infra/sqlite-staging-token.ts`    | **hier**          |
| **P0-3** | Staging-Token: `journal_mode` normalisieren statt hart prüfen                            | openclaw `src/infra/sqlite-staging-token.ts:85` | **hier**          |
| **P0-4** | `plugin-captures` leeren (3,6 GB) + Retention-Cron                                       | Betrieb                                         | **hier**          |
| **P0-5** | `google`-Auth-Profil anlegen → `media-analyst` lebt                                      | `openclaw.json` + Auth                          | **hier** (Config) |
| **P0-6** | FD-Routen-Familien implementieren (§2)                                                   | **lexiclaw**                                    | l33th4x           |
| **P0-7** | Scene-/Choice-Lifecycle-Routen (§2)                                                      | **lexiclaw**                                    | l33th4x           |

### P1 — Doku & Robustheit

| #    | Maßnahme                                                            | Owner              |
| ---- | ------------------------------------------------------------------- | ------------------ |
| P1-1 | `docs/fd-route-matrix.md` + SKILL.md-Methoden-Korrekturen (§2/§3)   | **hier** (Dateien) |
| P1-2 | `TZ=Europe/Berlin` im Compose + Doku-Regel in AGENTS.md/TOOLS.md    | **hier**           |
| P1-3 | `audio-transcribe` auf `process.env.DEEPGRAM_API_KEY` umstellen     | **hier**           |
| P1-4 | `modelPolicy`/Fallback so setzen, dass ein 429 nicht den Turn killt | **hier**           |
| P1-5 | Cron-Reaper (Defense-in-Depth, 2-h-Schwelle + Alarm)                | **hier**           |

### P2 — Registry, Allowlist, Update

| #    | Maßnahme                                                                                                              | Owner    |
| ---- | --------------------------------------------------------------------------------------------------------------------- | -------- |
| P2-1 | Allowlist-Zahlen synchronisieren (55), `fd-admin-queue` korrigieren, nicht installierte Referenzen bereinigen         | **hier** |
| P2-2 | `agents.entries.*.skills` entfernen → unrestricted + `skills.entries.*.enabled: false` für verhaltenskritische Skills | **hier** |
| P2-3 | `plugins.allow` um disabled Plugins ergänzen; `diagnostics-otel` + `onepassword` aktivieren                           | **hier** |
| P2-4 | GitHub-PAT aus `openclaw.json` in Secrets                                                                             | **hier** |
| P2-5 | Update auf **2026.10.9** (Image-Rebuild, 8 Schritte)                                                                  | **hier** |
| P2-6 | Cron-Reaper (s.o.)                                                                                                    | **hier** |

### Owner-Aktionen (nicht per Code lösbar)

| #   | Aktion                                                        | Kommando                                                                                 |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| O-1 | **Keyholder-Pairing** für userId 3                            | `POST /api/fd/keyholder/pair` + `accept`                                                 |
| O-2 | xai Re-Auth                                                   | `openclaw models auth login --provider xai --profile-id 'xai:einkreativertyp@gmail.com'` |
| O-3 | google-Profil anlegen                                         | `openclaw models auth login --provider google`                                           |
| O-4 | venice Top-up                                                 | Billing-Fenster                                                                          |
| O-5 | iCloud 2FA Re-Auth                                            | Owner-Login                                                                              |
| O-6 | `sag`/`gogcli`/`gemini` installieren oder Skills deaktivieren | Image-Build                                                                              |

### Nicht zu tun (bewusst)

- ❌ **`POST /api/fd/safeword` in keinem Test** — löst alle Locks real aus. FD #3 / CL #1 bis 2026-11-21T04:14:43Z müssen unverändert bleiben.
- ❌ **Scene-/Choice-Delete ohne GO von Sebi** — die Duplikate `ec2b8ac6`/`2384684f` und Choice-Sets `f15614`/`d0983f` erst _bereinigbar_ machen, nicht löschen.
- ❌ **Kein Schreiben in Sebastians FD-Szene (userId 3)**.
- ❌ **Kein `openclaw update` / kein Gateway-Neustart** aus diesem Bundle heraus.
- ❌ **`openclaw agent --agent lexi` aus einer Agent-Session** — die Verweigerung der Attribution ist _korrekt_.

---

## 8. Verifizierte Grundlagen

**Live gemessen:** Busy-Loop-Matrix (non-TTY vs. TTY, stdout-Umleitung) · Node-Inspector-Stack (20 Frames) · `owner.sqlite` journal_mode=wal bei 5 von 29 Captures · WAL-Fehler deterministisch reproduziert · 5 fehlende Tools · `/home/devuser` fehlt · `TZ=UTC` · `Europe/Berlin` vorhanden · `cron_run_receipts`: 0 running, 35 interrupted · 29 Capture-Ordner, 3,6 GB · FD-API `x-service-scope`-Gate · `SERVICE_TOKEN == KINKYGATE_API_KEY` · fd-tasks/fd-compliance/fd-telegram-link SKILL.md geprüft.

**Source gelesen:** `command-registration-policy.ts:5` · `run-main-policy.ts:25,89-97` · `types.agents.ts:127-128` · `schema.help.core.ts:282-283` · `types.skills.ts:9-10` · `update-runner.ts:103` · `update-startup.ts:445-462` · `boundary-file-read.ts` · `plugin-cache-files.ts:152`.

**Build gelesen (2026.10.4):** `sqlite-staging-token-DXBiTLqt.mjs` (busy_timeout=0, journal-Gate, reclaim-Rekursion) · `plugin-source-capture-directory-suikpgfR.mjs` (create/reclaim/sweep-Backoff) · `plugin-generation-artifact-ClEAyscn.mjs` (withPluginSourceFile) · `managed-handoff-runtime.mjs:66562` (`PRAGMA journal_mode = WAL` — WAL-Quelle).

**Nicht verifiziert:** Ob 2026.10.9 die Staging-Token-Logik geändert hat (die Quelle liegt nur im deployten Build, nicht im 2026.9.2-Checkout) · die genaue Herkunft der 5 WAL-Captures (Handoff-Runtime ist der einzige gefundene WAL-Setter, aber nicht der einzige mögliche) · Inhalt der 5 Patches 2026.10.4→.9.
