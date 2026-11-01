# Plan: Skill-/Plugin-Freigabe + OpenClaw-Update

> **Erstellt:** 2026-10-31 22:15 CEST
> **Auftrag:** (1) Alle Agents sollen alle Plugins und Skills nutzen können — nicht alle aktivieren, aber keine Skills, die verboten sind. (2) Update auf die neueste Version planen.
> **Methode:** Config-/Schema-Audit im Repo (2026.9.2), Runtime-Inspektion, Image-Analyse, npm/Registry-Abfrage.

---

## Teil 1 — Skill-/Plugin-Zugriffsmodell

### 1.1 Das Modell hat drei Ebenen, und das ist entscheidend

| Ebene                         | Config-Pfad                             | Semantik                                                                                                                                               | Quelle                                       |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Globaler Disable**          | `skills.entries.<name>.enabled: false`  | „Disable a discovered skill **without removing it from disk**." → Skill ist für **niemanden** nutzbar.                                                 | `src/config/types.skills.ts:9-10`            |
| **Plugin-Allowlist**          | `plugins.allow: [...]`                  | Nur diese Plugins werden geladen                                                                                                                       | `src/config/types.plugins.ts`                |
| **Plugin-Disable**            | `plugins.entries.<name>.enabled: false` | Plugin geladen, aber deaktiviert                                                                                                                       | Runtime                                      |
| **Skill-Allowlist pro Agent** | `agents.entries.<name>.skills: [...]`   | „Optional **allowlist** of skills for this agent; **omitting it inherits `agents.defaults.skills` when set, and otherwise skills stay unrestricted**." | `src/config/types.agents.ts:127-128`         |
| **Erben**                     | `agents.defaults.skills: [...]`         | Allowlist für Agenten **ohne** eigene Liste                                                                                                            | `src/config/types.agent-defaults.ts:165-166` |

**Der entscheidende Satz** (`src/config/schema.help.core.ts:282-283`):

> _„Optional allowlist of skills for this agent. If omitted, the agent inherits `agents.defaults.skills` when set; **otherwise skills stay unrestricted**. Set `[]` for no skills. **An explicit list fully replaces inherited defaults instead of merging with them**."_

### 1.2 Was das für deinen Auftrag heißt

Dein Auftrag: _„alle Agents sollen alle Plugins und Skills nutzen können (nicht alle aktivieren, aber keine Skills, die verboten sind)"_

Das lässt sich **exakt** auf das Modell abbilden — und besser, als es gerade ist:

| Ziel                                        | Mechanismus                                                                                        | Aktueller Zustand                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Agents können **alle** Skills nutzen        | `agents.entries.<name>.skills` **entfernen** (nicht auf `[]` setzen!) → „skills stay unrestricted" | ❌ **jeder** Agent hat eine explizite Whitelist                         |
| Skills, die verboten sind, bleiben gesperrt | `skills.entries.<name>.enabled: false`                                                             | ✅ 3 Skills gesperrt (`emotion-detect`, `fd-homekit`, `pixel-grok-hub`) |
| Plugins: alle **ladbar**, nicht alle aktiv  | `plugins.allow` (Laden) + `plugins.entries.*.enabled` (Aktivierung)                                | ✅ bereits konsistent                                                   |

**Der entscheidende Punkt:** „uneingeschränkt" (`skills` weglassen) und „Allowlist mit allem" (174 Einträge pro Agent) sind **nicht dasselbe**. Eine explizite Liste ersetzt Defaults **statt** zu mergen — und 174 Einträge × 10 Agents = 1 740 Config-Zeilen, die bei jedem Skill-Install pflegeleicht veralten. **Das Weglassen ist robuster.**

### 1.3 Ist-Zustand: quantifiziert

**Skills:**

| Metrik                                          | Wert                   |
| ----------------------------------------------- | ---------------------- |
| physisch vorhanden (`SKILL.md`)                 | **174**                |
| in mindestens einer Agent-Whitelist             | **116**                |
| **in KEINER Whitelist → für niemanden nutzbar** | **58**                 |
| `agents.defaults.skills`                        | nicht gesetzt (`null`) |

**Die 58 orphaned Skills** — das ist der eigentliche Befund. Sie existieren, sind geladen, aber **kein Agent kann sie aufrufen**, weil jeder Agent eine explizite Whitelist hat:

```
bluetooth-monitor · claude-code-session · crown-program-manager · deepgram-call ·
deepgram-stt · elite-longterm-memory · fd-achievements-skill · fd-agent-orchestrator ·
fd-autonomy-engine · fd-bluebubbles-skill · fd-checkpoint-skill · fd-credential-safe-skill ·
fd-drill-skill · fd-forms-skill · fd-master-control · fd-pilo-register ·
fd-predictive-skill · fd-progress-skill · fd-routine-skill · fd-scenario-pool ·
fd-sensor-fusion · fd-sms-fallback · fd-task-enforcer · fd-telemetry-skill ·
fd-training-skill · fd-voice-lock · fs-ops · gifgrep · grok-build-ops ·
grok-cli-session · guicontrol · hard-enforcement · human-behavior-optimization ·
kimiim · lexi-goddess-temple · mac-control · metaskill · minimax-cli-session ·
moltbook · obsidian · obsidian-notes · onboarding · openai-whisper · personal-info ·
pixel-grok-hub · sag · tech-chastity-audit · telegram-menu-l33th4x · tool-runner ·
vault · vault-annotator · vault-commands · vault-compliance-meter · vault-confessions ·
vault-overview · vault-random-recall · vesper-book-writer · wheel-of-fortune
```

Darin stecken rollenrelevante Skills, die aktuell **niemand** hat: `fd-achievements-skill`, `fd-task-enforcer`, `fd-routine-skill`, `fd-master-control`, `vault-overview`, `vault-random-recall`, `vault-confessions`, `fd-sensor-fusion`, `hard-enforcement`, `fd-voice-lock`.

**Plugins:**

| Metrik            | Wert                                              |
| ----------------- | ------------------------------------------------- |
| `plugins.entries` | 49                                                |
| `plugins.allow`   | 43                                                |
| Differenz         | 6 — **exakt die 6 disabled Plugins** (konsistent) |

| Plugin                  | Status   | Bewertung                                                                                                                              |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`             | disabled | ⚠️ **Prüfen** — Anthropic-Provider ist in `models.providers` evtl. konfiguriert                                                        |
| `diagnostics-otel`      | disabled | ⚠️ **Inkonsistent**: der OTel-Collector-Container läuft, aber das Plugin ist aus. Der Container sammelt, das Plugin exportiert nichts. |
| `fd-perception-control` | disabled | ⚠️ **Prüfen** — FD-Skill `fd-perception-control` existiert, Plugin aus                                                                 |
| `github`                | disabled | ⚠️ **Sicherheitsrelevant** — siehe unten                                                                                               |
| `onepassword`           | disabled | ⚠️ **Prüfen** — Skill `1password` ist in der techdomme/l33th4x-Whitelist!                                                              |
| `whatsapp`              | disabled | ok (kein WhatsApp-Channel)                                                                                                             |
| `workboard`             | disabled | ok                                                                                                                                     |

### 1.4 Sicherheitsbefund: GitHub-Token im Klartext

```json
// openclaw.json → agents.entries.main.tools.github
"profileId": "ghp_716bedb…bfe4"   ← GitHub-PAT im Klartext
```

Das `github`-Plugin ist **deaktiviert**, das Token liegt aber trotzdem in der Config. Bei einem Config-Backup oder `-backup`-Write wandert es mit. **Empfehlung:** Token in `openclaw-secrets` (1Password) oder Env-Variante verlagern, nicht in `openclaw.json`.

Zweitens: der `1password`-Plugin ist disabled, **aber** der Skill `1password` ist in den Whitelists von `techdomme` und `l33th4x`. Das ist inkonsistent — der Skill braucht das Plugin.

---

## Teil 2 — Update-Plan

### 2.1 Versionsstand

|                            | Version                          | Datum                                   |
| -------------------------- | -------------------------------- | --------------------------------------- |
| **Laufender Container**    | **2026.10.4** (Commit `383c124`) | Image gebaut 2026-10-15                 |
| **npm `latest`**           | **2026.10.9**                    | ← Zielfassung                           |
| npm `extended-stable`      | 2026.9.36                        | älter als `latest`                      |
| npm `beta`                 | 2026.10.10-beta.5                | nicht für Prod                          |
| **Repo-Checkout**          | **2026.9.2**                     | HEAD `6b49491d`, 17.10.                 |
| **Upstream `origin/main`** | **2026.9.2** (`e723b35c`)        | Fork ist **15 Commits vor** origin/main |

**Du bist also 5 Patch-Releases hinter `latest`** (2026.10.4 → 2026.10.9), und dein Repo-Checkout ist auf dem **2026.9.2-Stand**.

**Wichtige Klarstellung (verifiziert):** Dein Fork ist **nicht** hinter dem Upstream-Git-Branch. `git rev-list --left-right --count HEAD...origin/main` = **15 / 0** → dein `main` ist 15 Commits **vor** origin/main, kein Merge-Backlog. Die Upstream-Tags `2026.10.5`–`.9` existieren zwar (`git ls-remote --tags`), aber der `main`-Branch des Forks wurde nie auf sie nachgezogen. Der **2026.9.2-Stand deines Checkouts ist der entscheidende Punkt** für den `Dockerfile`-Build-Pfad — nicht der Branch-Abstand.

### 2.2 Warum `openclaw update` nicht funktioniert (verifiziert)

```
$ openclaw update status
Update 12df002d-95f4-4634-907d-c4ea568e674f: no activity since 2026-10-06T10:36:46.730Z
Warning: Service definition inspection failed: No supported service manager detected.
```

**98 `update_runs` in der DB, davon 94 fehlgeschlagen:**

| Reason                                | Anzahl | Quelle                            |
| ------------------------------------- | ------ | --------------------------------- |
| `managed-service-handoff-unavailable` | **77** | `src/infra/update-startup.ts:457` |
| `not-git-install`                     | **17** | `src/infra/update-runner.ts:103`  |
| `ERR_SQLITE_ERROR` / `null`           | 4      | —                                 |

**Blocker 1 — `not-git-install`:** Der Container hat openclaw als **npm-Paket** installiert (`/app/node_modules/.pnpm/openclaw@*/node_modules/openclaw`), nicht als Git-Checkout. Der In-Place-Update-Mechanismus erkennt das und verweigert.

**Blocker 2 — `managed-service-handoff-unavailable`:** `src/infra/update-startup.ts:445-462` — der Update-Mechanismus will den Gateway **über einen Service-Manager neu starten**. Docker Compose ist keiner. Also: kein Restart-Skill.

**Konsequenz:** In-Place-Update ist in dieser Deployment-Architektur **strukturell unmöglich**. Der einzige Weg ist **neues Image bauen + Container recreaten**.

### 2.3 Der Update-Weg (verifiziert)

**Wichtige Korrektur meiner ersten Annahme:** Das Image baut **nicht** aus deinem lokalen Source.

```
Dockerfile.brew:1   ARG BASE_IMAGE=ghcr.io/openclaw/openclaw:latest
Dockerfile.brew:2   FROM ${BASE_IMAGE}
```

Image-Labels: `org.opencontainers.image.revision: 383c124…`, `org.opencontainers.image.source: https://github.com/openclaw/openclaw`, `version: 2026.10.4`.

**Das Repo `openclaw-docker` ist ein Fork von `github.com/openclaw/openclaw`** — es liefert die _Docker-Spezifika_ (Dockerfile.brew, Dockerfile.sandbox, compose, tailscale-sidecar), aber die openclaw-Version selbst kommt aus dem **Upstream-Base-Image**.

Deshalb: **Ein `docker pull ghcr.io/openclaw/openclaw:latest` + Rebuild der drei Dockerfiles ergibt 2026.10.9**, ohne dass dein 2026.9.2-Checkout überhaupt betroffen ist.

**Aber:** Der `Dockerfile` im Repo (`COPY . .`, baut den lokalen Source) ist der **Fallback-Pfad**, falls jemand `docker compose build` ohne das Brew-Image aufruft. Der Compose-Kommentar sagt es explizit:

> _„Nicht das Upstream-Dockerfile bauen: das ersetzt openclaw-with-brew-sandbox durch ein Image ohne Homebrew, xurl und Docker-CLI. … Brew-Image vorher bauen."_

### 2.4 Update-Ablauf (geplant)

| Schritt                       | Befehl                                                                                                        | Risiko                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **U1 — Zustand sichern**      | `openclaw.json` + `~/.openclaw-docker` + Native-Volumes sichern                                               | keins                       |
| **U2 — Volumen-Backup**       | `docker run --rm -v openclaw-agents-native:/src -v $PWD/backup:/dst alpine tar czf /dst/agents.tgz -C /src .` | keins                       |
| **U3 — Base-Image ziehen**    | `docker pull ghcr.io/openclaw/openclaw:latest`                                                                | keins                       |
| **U4 — Brew-Image bauen**     | `docker build -f Dockerfile.brew -t openclaw-with-brew-sandbox:latest .`                                      | niedrig                     |
| **U5 — Sandbox-Image bauen**  | `docker build -f Dockerfile.sandbox -t openclaw-with-brew-sandbox:latest .` (FROM brew)                       | niedrig                     |
| **U6 — Compose recreaten**    | `docker compose up -d --force-recreate openclaw-gateway`                                                      | **mittel** — kurzer Ausfall |
| **U7 — Verify**               | `openclaw --version`, Health-Check, Telegram-Test, Agent-Smoke-Test                                           | —                           |
| **U8 — Rollback-Möglichkeit** | altes Image ist `docker tag`ed und im Cache                                                                   | —                           |

**Reihenfolge zwingend:** U3 → U4 → U5 → U6. Das Brew-Image ist die Basis des Sandbox-Images.

### 2.5 Update-Risiken, die ich vorab benennen muss

| Risiko                                             | Bewertung | Mitigation                                                                                                                                                                                                              |
| -------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Config-Migrationen** (2026.10.4 → .9, 5 Patches) | mittel    | `openclaw doctor --fix` nach dem Update; Backup von `openclaw.json`                                                                                                                                                     |
| **Deine 15 lokalen Commits** (`main` ahead)        | **hoch**  | Sie sind **nicht** im Image (Image = upstream). Aber: `Dockerfile` (der Repo-Fallback-Pfad) baut **deinen lokalen Source** — dort fließen sie rein, auf 2026.9.2-Basis. Klar dokumentieren: **Welches Image baut man?** |
| **Native-Volumes `agents/`+`state/`**              | **hoch**  | Volume-Migration zwischen Versionen ist nicht garantiert. U2 zwingend.                                                                                                                                                  |
| **Plugin-Kompatibilität**                          | mittel    | `plugins.allow` + `entries` nach dem Update validieren; 2026.10.x könnte Plugin-Namen geändert haben                                                                                                                    |
| **RSS-Schwellen**                                  | niedrig   | Kommentar im Compose: „die RSS-Schwellen 4096/6144 MiB kommen aus Dockerfile.brew" — beim Rebuild neu prüfen                                                                                                            |
| **`memory-lancedb`**                               | niedrig   | Lädt aktuell schon mit `EXDEV`-Fehler (siehe Befund 3)                                                                                                                                                                  |

### 2.6 Der hängende Update-Lock

```
Update 12df002d-95f4-4634-907d-c4ea568e674f: no activity since 2026-10-06T10:36:46.730Z
```

Seit **25 Tagen** ohne Aktivität. `openclaw update repair` ist der dokumentierte Weg (`src/cli/update-cli/update-recovery-guidance.ts`). Da wir ohnehin neu bauen, kann der Lock vorher aufgeräumt werden.

---

## Teil 3 — Kombinierte Maßnahmenliste

### Prio 1 — Skill-Freigabe (dein Kernauftrag)

| #      | Maßnahme                                                                               | Effekt                                                                                                                                         | Risiko                                                                                     |
| ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **S1** | `agents.entries.*.skills` ** entfernen** (alle 10 Agents) → „skills stay unrestricted" | **58 orphaned Skills werden nutzbar**, Rollen-Skills (`fd-achievements`, `fd-task-enforcer`, `vault-overview`, `hard-enforcement` …) verfügbar | **niedrig** — Agents bekommen mehr Werkzeuge, keine neuen Fähigkeiten außerhalb des Skills |
| **S2** | `skills.entries.*.enabled: false` für die als verboten markierten Skills               | Sperre bleibt                                                                                                                                  | keins                                                                                      |
| **S3** | `agents.defaults.skills` **nicht** setzen                                              | verhindert, dass ein Default die Agents wieder einschränkt                                                                                     | keins                                                                                      |
| **S4** | `plugins.allow` um die disabled Plugins ergänzen, damit sie **ladbar** sind            | Voraussetzung für S5                                                                                                                           | keins                                                                                      |
| **S5** | `diagnostics-otel` aktivieren                                                          | OTel-Collector läuft bereits (4 Tage) — endlich Daten                                                                                          | niedrig                                                                                    |
| **S6** | `onepassword` aktivieren (Skill `1password` ist in 2 Whitelists)                       | Konsistenz                                                                                                                                     | niedrig                                                                                    |
| **S7** | `anthropic`, `fd-perception-control`, `github` einzeln entscheiden                     | Klärung                                                                                                                                        | **Review nötig**                                                                           |
| **S8** | GitHub-PAT aus `openclaw.json` in Secrets verschieben                                  | Sicherheit                                                                                                                                     | niedrig                                                                                    |
| **S9** | Nach dem Update: `agents.entries.*.skills` erneut prüfen (Skills können hinzukommen)   | —                                                                                                                                              | —                                                                                          |

**Zu S1 — der eine Punkt, der Begründung braucht:** „Skills unrestricted" heißt, jeder Agent kann **jeden** Skill aufrufen. Das ist genau deine Anforderung („alle Agents sollen alle Skills nutzen können"). Aber es hat eine Konsequenz, die du kennen solltest: **die Whitelists waren vermutlich nicht nur technisch, sondern auch bewusst gesetzt.** Rollen-Skills wie `fd-task-enforcer` oder `hard-enforcement` verändern Verhalten. Wenn Lexi plötzlich `fd-master-control` aufrufen kann, ändert sich ihr Verhalten potenziell.

Deshalb mein Vorschlag: **S1 mit Sicherheitsnetz** — unrestricted für alle, aber die **verhaltenskritischen** Skills (`fd-master-control`, `hard-enforcement`, `fd-task-enforcer`, `fd-autonomy-engine`, `fd-agent-orchestrator`, `crown-program-manager`, `fd-scenario-pool`) global als `enabled: false` markieren, bis du sie einzeln freigibst. Das erfüllt „keine verbotenen Skills" wörtlich und liefert dir 58 → ~50 nutzbare Skills statt 0.

**Zu S1 — technischer Hinweis:** Das Entfernen der `skills`-Listen ist ein **JSON-Edit an 10 Stellen**. Nach dem Edit muss `openclaw config validate` grün sein, und der Gateway braucht einen Recreate, damit die Agent-Scopes neu geladen werden.

### Prio 2 — Update auf 2026.10.9

| #      | Maßnahme                                                            | Notiz                                        |
| ------ | ------------------------------------------------------------------- | -------------------------------------------- |
| **U1** | Config + State + Native-Volumes sichern                             | **zwingend**                                 |
| **U2** | `docker pull ghcr.io/openclaw/openclaw:latest`                      | prüfen, ob der Digest wirklich 2026.10.9 ist |
| **U3** | `Dockerfile.brew` neu bauen                                         | Homebrew/xurl/Skill-CLIs/RSS-Schwellen       |
| **U4** | `Dockerfile.sandbox` neu bauen                                      | Docker-CLI obendrauf                         |
| **U5** | `openclaw update repair` (Lock aufräumen)                           | vor oder nach dem Rebuild                    |
| **U6** | `docker compose up -d --force-recreate openclaw-gateway`            | kurzer Ausfall                               |
| **U7** | `openclaw doctor --fix` + Health + Telegram-Test + Agent-Smoke-Test | **Pflicht** nach Version-Sprung              |
| **U8** | Danach S1/S2 erneut validieren                                      | neue Skills in 2026.10.9?                    |

### Prio 3 — Aus dem ersten Report (unverändert gültig)

`plugin-captures` leeren + Retention · `cron.enabled: false` · `contextInjection: continuation-skip` · `bootstrapMaxChars: 32000` · `google`-Auth-Profil · Extensions auf Native-Volume (EXDEV) · `agents/`+`state/` aus dem Native-Volume (Datenverlust-Risiko)

---

## Teil 4 — Verifizierte Grundlagen

**Direkt gemessen:** 174 Skills physisch · 116 in Whitelists · 58 orphaned · 49 Plugin-Entries / 43 allow / 6 disabled · 98 update_runs (77 + 17 Fehlschläge) · npm `latest` = 2026.10.9 · Image-Revision `383c124` = Upstream · `Dockerfile.brew` = `FROM ghcr.io/openclaw/openclaw:latest` · Update-Blocker im Source verifiziert.

**Aus dem Repo gelesen:** `types.skills.ts:9-10` (enabled-Semantik) · `types.agents.ts:127-128` + `schema.help.core.ts:282-283` (Allowlist-Semantik, unrestricted bei Weglassen, replace statt merge) · `types.agent-defaults.ts:165-166` · `update-runner.ts:103` · `update-startup.ts:445-462` · `command-catalog.ts:408-414` (Docker-Build-Pfad).

**Nicht verifiziert:** Inhalt der 5 Patches 2026.10.4→.9 (kein Changelog-Zugriff) · ob 2026.10.9 neue Skills mitbringt, die eine erneute Allowlist-Entscheidung braucht · tatsächlicher Aufwand des Plugin-Source-Captures in 2026.10.9 (der EXDEV-Bug könnte dort behoben sein) · ob die Tags `2026.10.5`–`.9` im **lokalen** Checkout vorliegen (`git ls-remote --tags` zeigt sie am Remote).
