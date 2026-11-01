# Runtime-Analyse: openclaw-docker (OrbStack)

> **Erstellt:** 2026-10-31 21:38–22:10 CEST
> **Container:** `openclaw-docker-openclaw-gateway-1` (Compose-Projekt `openclaw-docker`, 6 Services)
> **Gateway-Uptime zum Analysezeitpunkt:** 6 h 08 min (Start 2026-10-31T15:31:20Z)
> **Methode:** direkte Runtime-Inspektion (docker stats/ps/exec, SQLite-Queries via `node:sqlite`, Log-Auswertung über 36 414 Logzeilen) + Source-Audit im Repo.

---

## Executive Summary

Der Gateway läuft **degradiert, aber sichtbar funktionsfähig**. Drei Befunde dominieren:

1. **Speicher-Druck ist permanent, nicht sporadisch.** 309 `memory pressure`-Warnungen in ~30 min, RSS 4.2 GiB gegen eine 4 GiB-Schwelle, 25–26 Worker-Threads. Der Container steht dauerhaft über der Warnschwelle und arbeitet im GC-Dauerkampf. Ein Neustart setzt nur die Uhr zurück, nicht die Ursache.

2. **Der teuerste Posten ist nicht das Modell, sondern der Prompt-Kontext.** 784 Prompt-Cache-Drops, davon 79× mit der Diagnose `no tracked cache input change` — also ein Drop **ohne nachweisbaren Grund**. Das kostet bei jedem Turn das volle Token-Context neu, statt den Cache zu treffen.

3. **Cron-Last konkurriert direkt mit deiner Interaktion.** 838 Cron-getriggerte Turns im Analysefenster gegen 100 Rate-Limit-Fehler (429 `Token Plan usage limit reached`) auf `minimax-portal`. `DISABLE_CRONS=true` steht in der Compose-Env, wird vom Source **nicht gelesen** — die Jobs laufen trotzdem.

Auf der Immersions-Seite ist die Architektur gut (10 Agenten mit eigenen SOUL/IDENTITY/USER/MEMORY), aber **die Prompt-Injektion kappt die Persona**: `AGENTS.md` wird bei 28–30 kB auf 20 kB gekürzt, und die Kürzung landet genau dort, wo Rollen- und Szenen-Verträge stehen.

**Wichtigste Erkenntnis für dich:** Der `agents/`-Pfad liegt auf einem Docker-Native-Volume (2.3 GB) und **schattiert den Host-Bind**. Deine Agent-Memory liegt damit in einem Docker-Volume, nicht in `~/.openclaw-docker/agents/`. Auf dem Host liegt eine **stale Kopie** (lexi-DB: Host 97 MB vom 25.10., Volume 198 MB live). Es gibt **keinen Sync-Back-Mechanismus** im Repo.

**Blocker für alle Source-Fixes:** Der laufende Container ist **OpenClaw 2026.10.4**, der Repo-Checkout ist **2026.9.2**. Der `historyRewrite`-Detector, dessen Logzeilen ich analysiert habe, existiert im Repo **nirgends** — nur im deployten Build. Source-Patches gegen dieses Checkout würden den laufenden Container **nicht** fixen. Erst die Version angleichen.

---

## Teil 0 — Versions-Divergenz (liest alle Source-Fixes)

|                     | Version       | Stand                                                                  |
| ------------------- | ------------- | ---------------------------------------------------------------------- |
| Laufender Container | **2026.10.4** | Image `openclaw-with-brew-sandbox:latest`, gebaut 2026-10-17 09:23     |
| Repo-Checkout       | **2026.9.2**  | HEAD `6b49491d` (2026-10-17 09:27), 15 Commits ahead von `origin/main` |

Beleg: `historyRewrite` ist im Container-Build in `dist/builtin-openclaw-*.mjs` vorhanden, aber `grep -rn "historyRewrite" src/` liefert **0 Treffer** im gesamten Repo (alle Pakete). Die 33+22 `historyRewrite`-Buckets in der Log-Historie stammen also aus **einem anderen Build** als dem Checkout.

**Konsequenz:** Alle Tier-3-Maßnahmen in diesem Report setzen voraus, dass der Build auf den Repo-Stand gebracht wird (oder die Fixes gegen 2026.10.4 portiert werden). Sonst patchst du ins Leere.

Die 15 unpushed Commits sind übrigens **fast ausschließlich TechDomme-Feature-Arbeit** (Fasteners, mdpi, ensure-mdpi, container-allowlist, rig-builder …) — **keine** Runtime-Performance-Fixes.

---

## Teil 1 — Performance

### 1.1 Ressourcen-Snapshot

| Container          | CPU         | RAM          | Limit-Anteil | PIDs    |
| ------------------ | ----------- | ------------ | ------------ | ------- |
| `openclaw-gateway` | **129.6 %** | **5.21 GiB** | **44.4 %**   | **427** |
| `lexiclaw-server`  | 0.34 %      | 112.5 MiB    | 0.94 %       | 11      |
| `lexiclaw-redis`   | 0.38 %      | 45.8 MiB     | 0.38 %       | 6       |
| `otel-collector`   | 0.08 %      | 37.6 MiB     | 0.31 %       | 14      |
| `tailscale`        | 0.11 %      | 33.2 MiB     | 0.28 %       | 34      |
| `prometheus`       | 0.00 %      | 35.0 MiB     | 0.29 %       | 17      |
| `grafana`          | 0.04 %      | 55.4 MiB     | 0.46 %       | 27      |

Host-Container-Gesamtlimit: 11.73 GiB. Der Gateway allein frisst 44 % davon.

### 1.2 Prozesse im Gateway (PID 7 = Hauptprozess)

| PID           | RSS             | Alter    | Rolle                                                         |
| ------------- | --------------- | -------- | ------------------------------------------------------------- |
| 7             | **4.20 GiB**    | 18 531 s | `node dist/index.js gateway`                                  |
| 28705         | 529 MiB         | 1 031 s  | `openclaw configure` (CLI, hängt!)                            |
| 29177 / 29061 | 85 / 83 MiB     | ~800 s   | `sqlite-readonly-location.worker.js`                          |
| 29047         | 70 MiB          | 858 s    | `spawn-broker/worker.js`                                      |
| 22 ×          | ~50 MiB je Paar | ~1 120 s | **`codex app-server`** (11 Node-Wrapper + 11 native Binaries) |

**Befund A — `codex app-server`-Prozesse: KEIN Leck, sondern by design (korrigiert).**
22 OS-Prozesse = **11 logische App-Server** (je ein `node codex.js`-Wrapper + ein nativer `aarch64`-Child). Der Shared-Client-Key enthält `agentDir` + Auth-Profil + Desktop-Generation (`extensions/codex/src/app-server/shared-client.ts:656-677`) → **ein Client pro Agent** → 11 Agents ⇒ 11 Clients ⇒ 22 Prozesse. Teardown existiert vollständig: Lease-Release (`shared-client.ts:522`), Retire (`shared-client-lifecycle.ts:87-117`), Idle-Close (`:137-153`), Clear-and-Wait (`shared-client.ts:1430`, `:1451`) sowie ein **Orphan-Reaper**, der verwaiste App-Server vor jedem Spawn killt (`transport-process-registration.ts:133`).

_Residuales Risiko:_ `detached: true` (`:144`) heißt, die Kinder überleben einen Gateway-Tod bis zum nächsten Spawn; und die Shared-Clients haben **keine Idle-TTL** (`closeWhenIdle` wird nur bei explizitem Release/Retire gesetzt, `shared-client.ts:692`). Das ist ein **Footprint-Problem, kein Leck** — bei 11 Agenten dauerhaft 22 Prozesse.

**Befund B — `openclaw configure` hängt seit 17 min** (529 MB RSS, 2.2 % CPU). Ein CLI-Prozess, der nie beendet wird.

**Befund C — `NODE_OPTIONS=--max-old-space-size=2048` (2 GiB) bei 4.2 GiB RSS.** Das `--max-old-space-size` begrenzt den JS-Hauptheap, nicht den RSS. Der Heap lag real bei 1.03–1.28 GiB, der Rest ist **Worker-Heap (1.16–1.18 GiB) + extern/ArrayBuffers**. Die Diagnose-Logs benennen es explizit: `workerLimitScope=js-heap-only; external/ArrayBuffers are not capped`.

Das heißt: **die Memory-Warnungen werden nicht durch ein heap-Limit gelöst**, weil der Verbraucher die Worker-Threads sind, nicht der Hauptheap.

### 1.3 Worker-Thread-Verteilung

Aus dem letzten `memory pressure`-Event (workerCount=26):

| Worker                               | heapUsed | Anteil |
| ------------------------------------ | -------- | ------ |
| `prepared-model-catalog.worker.js`   | 140.4 MB | 12 %   |
| `sqlite-store.worker.js` (512)       | 87.2 MB  | 7 %    |
| `session-transcript.worker.js` (516) | 84.5 MB  | 7 %    |
| `sqlite-store.worker.js` (522)       | 68.0 MB  | 6 %    |
| `session-transcript.worker.js` (519) | 62.8 MB  | 5 %    |

Plus `arrayBuffers` 42.5 MB und `external` 193.8 MB im Worker-Scope. Die Worker-Heaps summieren sich auf 1.17 GiB bei nur 1.13 GiB Hauptheap.

**Der Mechanismus (Source-Audit, korrigiert meine erste Hypothese):**

Der Catalog-Worker-Pool wird **lazy einmal pro Katalog-Instanz** erzeugt und über Requests wiederverwendet (`prepared-model-catalog-worker.ts:324` → `pool ??= createPool()`) — **nicht pro Turn**. Ein Katalog-Zugriff entsteht pro Agent-Snapshot (`prepared-model-runtime.build.ts:660-677`), und jeder Pool erlaubt **genau einen Worker** (`:245`, `maxWorkers: 1`).

**Der echte Defekt: `idleTimeoutMs: 0`** (`:248`). Der Pool-Default wäre 60 s (`worker-task-pool.ts:257`), aber dieser Pool **deaktiviert das Idle-Retirement komplett** (Kommentar `:246-247`: _„Only the lifecycle owner may retire it"_). Retire existiert und funktioniert (25-ms-Generation-Poll `:291-296` → `stop()` → `pool.close()` (`:277`) → `worker.terminate()` (`worker-task-pool.ts:266-268`)) — aber nur, wenn die **Agent-Generation** superseded wird.

**Konsequenz:** Jeder Agent, der einmal einen Katalog-Request gemacht hat, hält einen lebenden Worker-Thread + geladenen Plugin-Heap (~140 MB beobachtet), bis seine Generation superseded wird. Bei 11 Agents ≈ **11 Threads / ~1,5 GB**. **Begrenzt, nicht unbegrenzt** — aber dauerhaft.

Andere Pool-Sites sind sauber: `code-mode-worker.ts:73` schließt seinen isolierten Pool in `finally` (`:125-128`); `compaction-planning-worker-runtime.ts:21`, `session-model-context-worker-runtime.ts:8`, `disk-budget-runtime.ts:6` sind prozessstabile Singletons.

### 1.4 Turn-Latenz: `session-resource-loader` dominiert

Trace aus dem Log:

```
stages=workspace-sandbox:1ms, skills:2ms, core-plugin-tools:54ms, bootstrap-context:16ms,
bundle-tools:10ms, tool-catalog:10ms, tool-preparation:20ms, system-prompt:10ms,
session-resource-loader:6771ms, agent-session:622ms, stream-setup:16ms   → totalMs=7512
```

Über 32 gemessene Samples:

| Metrik  | Wert          |
| ------- | ------------- |
| Median  | 118 ms        |
| **p90** | **5 454 ms**  |
| **Max** | **13 445 ms** |
| Avg     | 1 808 ms      |

Der Loader ist **90 % der Turn-Vorbereitungszeit**.

**Was `reload()` wirklich tut (Source-Audit, korrigiert meine erste Hypothese):**

- `clearExtensionCache()` feuert **nur wenn `this.loaded`** (`src/agents/sessions/resource-loader.ts:356-358`) — bei einem **pro Turn neu erzeugten** Loader ist das `false`. **Der Extension-Cache wird also nicht pro Turn geleert.**
- `packageManager.resolve()` wird **übersprungen**, weil der Embedded-Loader `noExtensions/noSkills/noPromptTemplates/noThemes` setzt (`src/agents/embedded-agent-runner/resource-loader.ts:19-23` → `resource-loader.ts:360-363`).
- `resolveExtensionSources([])` ist ein No-Op (`:364-369`); Skills/Prompts/Themes/Context sind deaktiviert (`:463-518`).

**Es bleibt genau eine Dateisystem-Arbeit übrig:** `settingsManager.reload()` (`:359` → `settings-manager.ts:196-206` → `:98-116` → `settings-storage.ts:161-167`). Pro Scope: `lstatSync` auf `<path>.lock` und `<path>.lock.reclaim` + JSON-Read von `<agentDir>/settings.json` und `<cwd>/.openclaw/settings.json`.

**Und dieselben Scopes werden ein zweites Mal gelesen** — bei der Konstruktion (`attempt-session-prepare.ts:99` → `createPreparedEmbeddedAgentSettingsManager`) und nochmal bei `reload()` (`:137`). **Settings-Dateien werden pro Turn doppelt angefasst.** Unter OrbStack-Bind-Mounts ist das der klassische Mehr-Sekunden-Stall. Das erklärt den bimodalen Verlauf (Median 118 ms vs. p90 5,4 s) perfekt: schneller Pfad = Cache-Hit, langsamer Pfad = FS-Stat unter Docker.

**Nebeneffekt außerhalb des Messfensters:** `loadExtensionsCached` (`:441`) → `useExtensionCacheCwd(cwd)` (`extensions/loader.ts:555`, `:133-140`) leert den **prozess-globalen** `extensionFactoryCache` (`:71`), sobald der cwd des Agenten vom letzten abweicht. Mit 11 Agents thrasht das den globalen Extension-Modul-Cache und erzwingt jiti-Re-Imports (`:466-471`, `:451`).

### 1.5 Prompt-Cache

**784 Drops** im Analysefenster. Verteilung der Diagnose-Gründe:

| Grund                                                | Anzahl | Bewertung                                                                                      |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `no tracked cache input change`                      | **79** | **Keiner der 7 überwachten Inputs hat sich geändert** — der Drop ist _nicht_ selbst verursacht |
| `historyRewrite(message N (assistant) differs…)`     | 33     | **Aus einem anderen Build** (nicht in 2026.9.2 vorhanden)                                      |
| `historyRewrite(message N (user) differs…)`          | 22     | dito                                                                                           |
| `systemPrompt` + `systemPromptSuffix` digest changed | ~13    | System-Prompt schwankt zwischen Turns                                                          |
| `runtimeContextCarrier changed provider history`     | 6      | Runtime-Kontext im Provider-History                                                            |
| `tools (tool set changed with same count)`           | 4      | Tool-Set ändert sich                                                                           |

**Korrektur meiner ersten Hypothese:** Ich hatte die `historyRewrite`-Buckets als „selbst verursachtes Rewrite der Historie" gelesen. Der Source-Audit widerlegt das für dieses Repo: es gibt **keine per-Nachricht-Diffing-Logik** überhaupt. Der Change-Code-Union ist geschlossen bei 7 Codes (`aggregateToolResultTruncation | cacheRetention | model | streamStrategy | systemPrompt | tools | transport`, `src/agents/embedded-agent-runner/prompt-cache-observability.ts:14-21`), und die 7 Diff-Dimensionen sind ausschließlich Model/CacheRetention/Transport/StreamStrategy/SystemPrompt/Tools (`diffSnapshots`, `:180-225`).

**`no tracked cache input change` ist also die _entgegengesetzte_ Diagnose:** der Beobachter hat alle 7 überwachten Inputs verglichen und **keine Änderung** gefunden. Der Cache-Drop kommt damit von der **Provider-Seite** (oder aus dem 2026.10.4-Build, wo die Historie-Rewrite-Erkennung existiert) — nicht von einem nachweisbaren lokalen Fehler.

Konkretes Beispiel mit vollem Kontextverlust:

```
cache read dropped 471598 -> 128   (MiniMax-M3)
  systemPromptSuffix(system prompt suffix digest changed),
  tools(tool set changed with same count),
  historyRewrite(message 96 (user) differs from the previous request; history must be append-only)
```

**471 598 → 128 Tokens.** Das ist der Worst Case: das komplette Context-Fenster wird neu gerechnet und übertragen, statt 471 k Tokens aus dem Cache zu lesen. Dass dieser Log aus 2026.10.4 stammt und die Erkennung dort existiert, deutet darauf hin, dass **der neuere Build das Problem inzwischen diagnostiziert** — die Ursache ist dort also bereits identifiziert. Vor einem Fix muss man den 2026.10.4-Code lesen.

**Positiv verifiziert:** Der Transport schützt den admitted Prefix explizit — das Verschieben des Runtime-Context-Carriers „would rewrite the already admitted request prefix" (`packages/ai/src/transports/openai-responses-replay-messages-internal.ts:374-390`). Und der einzige Historie-Rewriter im Repo, `normalizeAssistantReplayContent` (`attempt-prompt-submit.ts:106-109`, `replay-history.ts:201/329`), ist **idempotent** (`src/sessions/input-provenance.ts:180-182` lässt Text unverändert, wenn der Prefix schon vorhanden ist).

### 1.6 Storage-Wachstum

| Pfad                                       | Größe       | Risiko                                  |
| ------------------------------------------ | ----------- | --------------------------------------- |
| `/home/node/.openclaw/agents`              | **2.3 GB**  | 7 Agent-DBs, unbeschnitten              |
| `/home/node/.openclaw/backups`             | **1.7 GB**  | 34 `backup_runs`                        |
| `/home/node/.openclaw/tmp/plugin-captures` | **1.7 GB**  | **10 Ordner, ~170 MB je Capture**       |
| `/home/node/.openclaw/lcm.db`              | **472 MB**  | Lossless-Claw-Context-Engine            |
| `/home/node/.openclaw/npm`                 | 613 MB      | npm-Cache                               |
| `/home/node/.openclaw/state`               | 121 MB      | `openclaw.sqlite` = 122 MB + 2,2 MB WAL |
| **Gesamt `.openclaw`**                     | **~6.6 GB** |                                         |

**`tmp/plugin-captures` ist der schlimmste Einzelposten:** 1.7 GB in 10 Ordnern, die ältesten seit 27.10. Kein Retention-Mechanismus sichtbar.

> **Nachtrag 31.10. 22:20:** Dieser Ordner ist **nur die sichtbare Oberfläche eines tieferen Bugs**. Ein fehlgeschlagener `openclaw tools`-Aufruf erzeugt einen **1,1-GB-Capture** mit vollständigen Plugin-Binaries (217 MB codex, 220 MB claude, 165 MB lancedb) und läuft dabei in einen **CPU-Busy-Loop** (101 % CPU, 580 MB RSS). Root Cause: **SQLite-Staging-Token-Retry-Spin** (`busy_timeout=0` + hartes `journal_mode`-Gate + Reclaim-Rekursion ohne Backoff). Vollständige Analyse in **`fix-bundle-fd-skills-2026-10-31.md` §2**. Die Storage-Maßnahme 2.1 bleibt richtig, ist aber nur die Symptombehandlung.

**`lcm.db` (472 MB)** — die Lossless-Claw-Context-Engine:

| Tabelle                | Zeilen     |
| ---------------------- | ---------- |
| `messages`             | 39 029     |
| `context_items`        | 31 074     |
| `message_parts`        | **68 209** |
| `summary_messages`     | 3 188      |
| `messages_fts_content` | 33 141     |
| `conversations`        | 898        |

Zusätzlich: `audit_events` = 90 502 Zeilen (~500/h), `plugin_state_entries` = 12 398, `channel_ingress_events` = 2 803, `cron_run_receipts` = 1 340.

### 1.7 Cron-Last (der eigentliche Kostenhebel)

`DISABLE_CRONS=true` steht in der Compose-Environment. **Die Source liest diese Variable nicht** (`grep -rn "DISABLE_CRONS" src/` → 0 Treffer). Die Jobs laufen trotzdem:

```
cron.enabled = true          (openclaw.json)
cron.failureAlert.enabled = true
cron.skipMissedJobs = true
```

Gemessen im Analysefenster:

| Metrik                               | Wert                        |
| ------------------------------------ | --------------------------- |
| Cron-getriggerte Turns               | **838**                     |
| davon Fehler in `lane=cron-nested`   | 291                         |
| Rate-Limit-Fehler (429)              | 100 (alle `minimax-portal`) |
| `auth profile failure state updated` | 202                         |

Verteilung nach Agent:

| Agent        | Cron-Turns |
| ------------ | ---------- |
| techdomme    | 222        |
| lexi         | 195        |
| nyx          | 171        |
| vesper       | 123        |
| l33th4x      | 77         |
| piglettwin   | 26         |
| vaultcurator | 24         |

Jeder Cron-Turn konkurriert mit deiner Interaktion um **dasselbe** `minimax-portal`-Token-Limit. Die Folge ist die dokumentierte Kaskade:

```
429 Token Plan usage limit reached
  → auth profile failure state updated (cooldown)
    → model fallback decision: candidate_failed
      → failover zu MiniMax-M3.1-Flash
        → fallback zu openai/gpt-5.6-terra
          → "incomplete turn detected … surfacing error to user"
```

**Der Fallback ist bei dir faktisch abgeschaltet:**

```
[model-fallback] configured fallbacks disabled by user model override
```

Der `configured fallbacks disabled by user model override` bedeutet: Der konfigurierte Fallback wird nicht genutzt, wenn eine **User-Model-Override** gesetzt ist. Die `modelPolicy.allow`-Liste aller Agenten enthält aber `minimax-portal/MiniMax-M3`, `MiniMax-M3.1-Flash`, `openai/gpt-5.6-terra` — die Fallbacks _wären_ verfügbar, werden aber durch den Override nicht angefasst. Resultat: **ein 429 killt den Turn**, statt auf ein anderes Modell auszuweichen.

### 1.8 Weitere Fehler im Log

| Muster                                                  | Anzahl | Wirkung                                                   |
| ------------------------------------------------------- | ------ | --------------------------------------------------------- |
| `slow SQLite reclamation`                               | 311    | Reclamation > 1 s, blockiert                              |
| `slow session lifecycle`                                | 153    | Turn-Lifecycle > Threshold                                |
| `[typing] TTL exceeded (60000ms)`                       | 72     | Telegram-Typing-Indicator hängt                           |
| `sendRichMessage failed: RICH_MESSAGE_CONTENT_REQUIRED` | 26     | **Telegram-UX-Bug** — sichtbare Nachricht geht nicht raus |
| `memory pressure`                                       | 309    | s.o.                                                      |
| `Token Plan usage limit reached`                        | 100    | s.o.                                                      |

---

## Teil 2 — Immersion

### 2.1 Was gut ist

Die Multi-Agent-Architektur ist substanziell, nicht dekorativ:

- **10 Agenten** in `agents.entries`, je mit eigenem `identity.name` + `emoji`, eigenem `workspace`, eigenem `agentDir`, eigener `modelPolicy.allow`-Liste.
- **Eigene SOUL/IDENTITY/USER/MEMORY-Dateien** pro Agent im Workspace.
- **Own-Memory-Verzeichnisse** pro Agent (`agents/*/memory/`, 2–10 Dateien, 8–52 KB).
- **Rollen-Trennung ist kodiert:** SOUL.md von Lexi definiert „Nur du eröffnest, urteilst und eskalierst", Vesper „beobachtet kalt und führt Protokoll", Nyx „trackt und meldet", TechDomme „führt Zeitpläne, Check-ins", Config-Änderungen „laufen nur über l33th4x".

Das ist genau die Art von Setup, die Immersion trägt — die Frage ist nur, wie viel davon **tatsächlich im Prompt ankommt**.

### 2.2 Die Kürzung: Persona-Verlust durch AGENTS.md-Budget

```
bootstrap file AGENTS.md is 28250 chars (limit 20000); truncating in injected context
bootstrap file AGENTS.md is 30521 chars (limit 20000); truncating in injected context
```

**40 Truncations** im Analysefenster.

Der Mechanismus (`src/agents/embedded-agent-helpers/bootstrap.ts`):

- `isUserBootstrapFile()` matcht **nur `USER.md`** → eigener Cap von `USER_BOOTSTRAP_MAX_CHARS = 4_000`.
- `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `AGENTS.md` teilen sich das `maxChars`-Budget (Default 20 000 pro Datei, `bootstrapTotalMaxChars` Default 150 000).
- Für `AGENTS.md` greift `trimAgentsBootstrapContent` mit `AGENTS_POLICY_HEAD_RATIO` / `TAIL_RATIO` / `DIGEST_RATIO` — eine **Policy-Digest-Extraktion**, die Bullet-/Heading-Zeilen priorisiert.

Das Problem: **Die eigentlichen SOUL-Dateien sind zu klein für das 20-k-Budget — sie werden nicht gekürzt.** Aber `AGENTS.md` (17–30 kB) frisst das Budget und wird dabei auf die Policy-Digest-Form reduziert. Die Rollen-/Szenen-Verträge, die in SOUL.md stehen, bleiben erhalten — aber die Arbeitsanweisungen in AGENTS.md kommen verstümmelt an.

Konkrete Kürzung bei techdomme (AGENTS.md = 30 698 B): Head 75 % + Tail 25 % → die Mitte geht verloren.

**Konfiguration:** `agents.defaults.bootstrapMaxChars` und `bootstrapTotalMaxChars` sind in deiner `openclaw.json` **nicht gesetzt** (Defaults 20 000 / 150 000). `contextInjection` ist ebenfalls **nicht gesetzt** → Default `always` (inject on every turn).

### 2.3 `contextInjection: continuation-skip` — der ungenutzte Hebel

`src/config/types.agent-defaults.ts` dokumentiert:

```
- always: inject on every turn (default)
- continuation-skip: skip injection on safe continuation turns once the
  transcript already contains a completed assistant turn
```

**Das ist exakt dein Szenario.** Deine Telegram-Chats sind Fortsetzungen. Bei `continuation-skip` wird der Bootstrap-Kontext (AGENTS.md, SOUL.md, USER.md, MEMORY.md) **nicht bei jedem Turn neu injiziert**, sondern nur beim ersten Turn bzw. nach Kontextverlust. Das ist der direkteste Weg, die Cache-Drops zu senken — und gleichzeitig die Rolle stabiler zu halten, weil SOUL.md nicht bei jedem Turn neu interpretiert wird.

Der Trade-off: nach einem echten Kontextverlust muss der Kontext neu geladen werden — das ist aber genau die Condition, die der Modus prüft.

**Wichtige Abgrenzung (verifiziert im Source):** `contextInjection` ist **orthogonal** zur `session-resource-loader`-Latenz. Der Skip passiert in
`src/agents/embedded-agent-runner/run/attempt-context-engine-helpers.ts:52-62`:

```ts
const shouldSkipBootstrapInjection = params.contextInjectionMode === "never" || isContinuationTurn;
const context = shouldSkipBootstrapInjection
  ? { bootstrapFiles: [], contextFiles: [] }
  : await params.resolveBootstrapContextForRun();
```

Er setzt `bootstrapFiles`/`contextFiles` auf leer — **die `packageManager.resolve()`-Arbeit in `resourceLoader.reload()` läuft trotzdem** (`attempt-session-prepare.ts:137`, unbedingt aufgerufen). `continuation-skip` spart also die Prompt-Budget-Arbeit und stabilisiert den Prefix, **nicht** die 6,7 s. Die bleiben ein Source-Fix (3.2).

**Sicherheitsnetz:** Der Modus hat einen eingebauten Fallback — `hasCompletedBootstrapTurn()` prüft einen persistenten Marker, und nur ein _cleaner Full-Bootstrap-Turn_ schreibt ihn (`shouldRecordCompletedBootstrapTurn`, Zeile 54-58). Heartbeat-Lifecycle-Runs werden explizit ausgenommen (Zeile 44, 48), damit regelmäßige Heartbeats nie die Persona-Kontext-Injektion verlieren.

### 2.4 Memory-Frische und Split-Brain

`MEMORY.md` (Host-Bind, ist die Quelle für Workspace-Dateien):

| Agent       | Letzte Änderung      | Größe     |
| ----------- | -------------------- | --------- |
| lexi        | 2026-10-31 17:09     | 19 897 B  |
| techdomme   | 2026-10-25 04:05     | 12 870 B  |
| nyx         | 2026-10-25 04:05     | 4 654 B   |
| vesper      | 2026-09-22 03:52     | 4 090 B   |
| queencharms | **2026-07-18 16:28** | **188 B** |

**queencharms hat seit 3,5 Monaten kein Memory-Write.** Das ist entweder ein Agent, der nie substantive Gespräche führt, oder ein Agent, dessen Memory-Pipeline nicht greift. Beides ist ein Immersions-Bruch: eine Figur ohne Kontinuität.

**Der Split-Brain (kritisch):**

| Pfad                          | Mount                             | Inhalt                               |
| ----------------------------- | --------------------------------- | ------------------------------------ |
| `/home/node/.openclaw`        | Bind `/Users/sk/.openclaw-docker` | Config, Workflows, Workspace-Dateien |
| `/home/node/.openclaw/agents` | **Native Volume**                 | **2.3 GB** Agent-DBs + Memory        |
| `/home/node/.openclaw/state`  | **Native Volume**                 | 121 MB Gateway-State                 |

Der Bind-Mount `/Users/sk/.openclaw-docker` enthält auch `agents/` — aber der Native-Volume-Mount auf `/home/node/.openclaw/agents` **schattiert** ihn. Beweis:

| Datei                   | Host (`~/.openclaw-docker/agents/lexi/agent/`) | Volume (live)                |
| ----------------------- | ---------------------------------------------- | ---------------------------- |
| `openclaw-agent.sqlite` | 97 804 288 B (25.10. 21:26)                    | 198 557 696 B (31.10. 20:44) |
| `memory/2026-10-21.md`  | vorhanden (21.10.)                             | **fehlt** (nur bis 17.10.)   |

Der Host hat eine **ältere, kleinere** Kopie. Der Kommentar im Override-File sagt es selbst:

> _„state/ + agents/ run on Docker volumes; host dirs are cold copies until synced back."_

**„until synced back" — dieser Sync existiert nicht.** `grep -rn "agents-native|sync.*native" scripts/ docs/` → keine Treffer. Konsequenz: **Die Agent-Memory und die Session-Historie liegen in einem Docker-Volume, das weder im Host-Filesystem sichtbar noch durch den Repo-Backup-Mechanismus erfasst ist.** Ein `docker volume prune` löscht deine Memory.

Das ist der einzige Befund in diesem Report mit **Datenverlust-Risiko**.

### 2.5 Stale Session-Kontexte

18 aktive Session-Heads in `session_state_heads` — **alle stale**, ältester 36 300 min (25 Tage):

| Alter | Session                                                                               |
| ----- | ------------------------------------------------------------------------------------- |
| 25 d  | `agent:lexi:subagent:59fe74b9…`                                                       |
| 25 d  | `agent:lexi:main`                                                                     |
| 24 d  | `agent:lexi:dashboard:…`                                                              |
| 14 d  | `agent:l33th4x:main`, `agent:nyx:main`, `agent:vesper:main`, `agent:queencharms:main` |
| 12 d  | `agent:lexi:subagent:e9d43ef4…`                                                       |
| 11 d  | `agent:vaultcurator:subagent:…` ×2                                                    |
| 6 d   | `agent:lexi:subagent:…` ×2                                                            |
| 6 d   | `agent:techdomme:cron:…`                                                              |

Sechs `subagent:`-Sessions und zwei `dashboard:`-Sessions liegen seit Tagen/Wochen offen. Jede offene Session hält einen `session-transcript.worker.js` und ein Agent-DB-Handle.

### 2.6 Telegram-Immersion

| Symptom                                                 | Anzahl | Wirkung                                 |
| ------------------------------------------------------- | ------ | --------------------------------------- |
| `sendRichMessage failed: RICH_MESSAGE_CONTENT_REQUIRED` | 26     | Nachricht **sichtbar nicht zugestellt** |
| `[typing] TTL exceeded (60000ms)`                       | 72     | Typing-Indicator läuft ins Leere        |
| `logbook: analysis paused; no vision model`             | 2×     | Vision-Pipeline aus                     |
| `logbook: no connected node exposes screen.snapshot`    | 1×     | Kein Node hängt am Gateway              |

**Vision ist komplett aus.** Der `logbook`-Plugin (Screen/Logbook-Analyse) ist die natürliche Immersions-Erweiterung — Bildschirmbeobachtung, Kontext aus dem Logbuch. Aktuell: kein `visionModel` konfiguriert, kein `screen.snapshot`-Node.

---

## Teil 3 — Priorisierte Maßnahmen

### Tier 1 — Sofort, ohne Code-Änderung (Config)

| #   | Maßnahme                                                                                      | erwarteter Effekt                                                                                                                                                                                                         | Risiko                                      |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1.1 | `agents.defaults.contextInjection = "continuation-skip"`                                      | spart die **Bootstrap-Injektion** (AGENTS/SOUL/USER/MEMORY) bei Folgeturns; weniger Cache-Drops; Persona stabiler. **Achtung:** senkt _nicht_ die 6,7-s-`session-resource-loader`-Latenz — die ist orthogonal (siehe 3.2) | niedrig — kontrollierter Feature-Pfad       |
| 1.2 | `agents.defaults.bootstrapMaxChars` auf 32 000 heben                                          | keine AGENTS.md-Kürzung mehr bei lexi/techdomme                                                                                                                                                                           | niedrig — mehr Token pro erstem Turn        |
| 1.3 | **Cron-Jobs deaktivieren oder auf ein Fenster legen** (`cron.enabled=false` oder Skalierung)  | 838 → ~0 Cron-Turns; **das 429-Problem verschwindet**                                                                                                                                                                     | mittel — Verhaltensänderung, Jobs pausieren |
| 1.4 | Model-Fallback reparieren: User-Model-Override so setzen, dass `configured fallbacks` greifen | ein 429 killt nicht mehr den Turn                                                                                                                                                                                         | niedrig                                     |
| 1.5 | `plugins.entries.logbook.config.visionModel` setzen + Node mit `screen.snapshot` verbinden    | Vision-Immersion aktiv                                                                                                                                                                                                    | niedrig — braucht Provider-Key              |
| 1.6 | `RICH_MESSAGE_CONTENT_REQUIRED`-Pfad prüfen (Channel-Adapter)                                 | sichtbare Telegram-Nachrichten                                                                                                                                                                                            | — Bug-Ticket, nicht Config                  |

### Tier 2 — Betrieb & Hygiene

| #    | Maßnahme                                                                                                                     | Effekt                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 2.1  | **`tmp/plugin-captures` aufräumen + Retention setzen**                                                                       | 1.7 GB frei                         |
| 2.2  | `backups/` prüfen: 34 `backup_runs`, 1.7 GB                                                                                  | 1.7 GB frei                         |
| 2.3  | `lcm.db` VACUUM + `audit_events`/`plugin_state_entries` prunen                                                               | 472 MB → deutlich weniger           |
| 2.4  | Agent-DBs prunen (lexi 198 MB, nyx 205 MB, techdomme 114 MB)                                                                 | ~500 MB frei                        |
| 2.5  | Stale Sessions schließen (6 `subagent:`, 2 `dashboard:`)                                                                     | Worker + Handles frei               |
| 2.6  | Hängenden `openclaw configure`-Prozess (529 MB) beenden                                                                      | 529 MB frei                         |
| 2.7  | Codex-`app-server`: **kein Leck** — 11 logische Clients für 11 Agents, Teardown + Orphan-Reaper vorhanden. Optional Idle-TTL | Footprint ↓                         |
| 2.8  | `agents/`+`state/` aus dem Native-Volume **zurück auf Bind-Mount** (nach SQLite-Busy-Fix) oder Volume-Backup einrichten      | **Datenverlust-Risiko eliminieren** |
| 2.9  | Docker-Resource-Limits setzen (`mem_limit`, `cpus`, `pids_limit`)                                                            | runaway wird begrenzt statt OOM     |
| 2.10 | Memory-Writes für queencharms, vesper, nyx prüfen                                                                            | Immersion                           |

### Tier 3 — Source-Fixes (brauchen Code-Änderung **in 2026.10.4**)

> Wegen der Versions-Divergenz (Teil 0) gilt: Die Fix-Locations beziehen sich auf den Repo-Stand 2026.9.2. Vor dem Patch muss gegen den **deployten** 2026.10.4-Code geprüft werden, ob die Struktur dort identisch ist.

| #   | Maßnahme                                                                                                                       | Datei (2026.9.2)                                                         | Impact                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 3.1 | **Settings-Manager pro Session wiederverwenden** statt pro Attempt neu zu konstruieren + zu reloaden; doppelten Read entfernen | `src/agents/embedded-agent-runner/run/attempt-session-prepare.ts:99-137` | **hoch** — beseitigt die 5,4-s-p90-Latenz (p90 5,4 s → Ziel < 500 ms) |
| 3.2 | **Extension-Cache nach cwd mappen** statt Single-Slot-Wipe (verhindert jiti-Re-Imports bei 11 Agents)                          | `extensions/loader.ts:133-140` (`useExtensionCacheCwd`)                  | mittel-hoch                                                           |
| 3.3 | **Idle-Retirement für Catalog-Worker aktivieren** (`idleTimeoutMs` ≠ 0) oder Owner-Retire-on-Idle                              | `src/agents/prepared-model-catalog-worker.ts:248`                        | **hoch** — 11 Threads × ~140 MB ≈ 1,5 GB                              |
| 3.4 | Idle-TTL für Shared-Codex-Clients (`closeWhenIdle`)                                                                            | `extensions/codex/src/app-server/shared-client-lifecycle.ts`             | niedrig-mittel — Footprint, kein Leck                                 |
| 3.5 | `historyRewrite`-Ursache im 2026.10.4-Code lokalisieren (Cache-Drop 471k→128)                                                  | deployter Build                                                          | hoch — aber zuerst lesen, nicht raten                                 |
| 3.6 | `sendRichMessage`-Fallback ohne Rich-Content                                                                                   | Telegram-Adapter                                                         | mittel — UX                                                           |
| 3.7 | `typing`-TTL kürzen / Cleanup bei Abbruch                                                                                      | Telegram-Adapter                                                         | niedrig                                                               |

---

## Teil 4 — Was verifiziert ist vs. was offen ist

**Direkt live gemessen (Runtime):**
Alle Zahlen in Teil 1 (docker stats, ps, SQLite-Queries, 36 414 Logzeilen), Mount-Struktur, Host/Volume-Split-Brain, Config-Werte aus `openclaw.json`, `DISABLE_CRONS`-Nicht-Referenzierung (grep über `src/`), `cron.enabled` Gate in `src/cron/local-service.ts:19`, Session-Age aus `session_state_heads`, **Versions-Divergenz 2026.10.4 vs 2026.9.2**.

**Per Source-Audit verifiziert (Subagent, Repo-Stand 2026.9.2):**

| Befund                                                                                                                       | Status                                           | Beleg                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `session-resource-loader` ist der dominante Turn-Prep-Stage                                                                  | **CONFIRMED**                                    | `attempt-stage-timing.ts:47-55`, `attempt-session-prepare.ts:131-146`                 |
| Dominanter Sub-Cost = **per-Turn Settings-Reload** (nicht `packageManager.resolve()` — das ist im Embedded-Pfad deaktiviert) | **CONFIRMED**                                    | `resource-loader.ts:355-369`, `embedded-agent-runner/resource-loader.ts:19-23`        |
| Extension-Cache wird pro Turn **nicht** geleert                                                                              | **CONFIRMED** (meine erste Hypothese war falsch) | `resource-loader.ts:356-358` (`this.loaded` == false)                                 |
| Settings-Dateien werden pro Turn **doppelt** gelesen                                                                         | **CONFIRMED**                                    | `attempt-session-prepare.ts:99` + `:137`                                              |
| `prepared-model-catalog` Worker-Pool: **nicht** pro Turn, `maxWorkers: 1`, aber `idleTimeoutMs: 0` deaktiviert Retirement    | **PARTIAL** (bounded, kein unbounded Leak)       | `prepared-model-catalog-worker.ts:245,248,324`                                        |
| 22 codex-Prozesse = **11 logische Clients** (1/Agent), Teardown + Orphan-Reaper vorhanden                                    | **REFUTED** als „Leck"                           | `shared-client.ts:656-677`, `transport-process-registration.ts:133`                   |
| `historyRewrite` existiert im Repo **nicht** → Log stammt aus anderem Build                                                  | **CONFIRMED**                                    | grep über gesamtes Repo: 0 Treffer                                                    |
| Kein per-Turn-Feld wird in die Historie injiziert; `normalizeAssistantReplayContent` ist idempotent                          | **CONFIRMED**                                    | `openai-responses-replay-messages-internal.ts:374-390`, `input-provenance.ts:180-182` |
| `contextInjection: continuation-skip` überspringt die komplette Bootstrap-Auflösung                                          | **CONFIRMED**                                    | `attempt-context-engine-helpers.ts:52-62`                                             |
| `contextInjection` ist **orthogonal** zur Loader-Latenz                                                                      | **CONFIRMED**                                    | `attempt-session-prepare.ts:137` läuft unbedingt                                      |

**Nicht verifiziert (bewusst):**

- Ob `tmp/plugin-captures` einen Retention-Mechanismus hat, der nur im Image liegt.
- Ob `openclaw doctor --fix` die Volume-Frage adressiert.
- Der **Live-Wertebereich** der 6,7-s-Latenz: der Subagent hatte keine Shell, die Zuordnung „Settings-Reload = der FS-bound Rest" ist **aus der Code-Struktur abgeleitet, nicht profiliert**.
- Die Ursache des `historyRewrite`-Cache-Drops im 2026.10.4-Build — dort existiert die Erkennung, aber der 2026.9.2-Checkout kann sie nicht erklären.

---

## Teil 5 — Empfohlene Reihenfolge

**Schritt 0 — Version angleichen (Blocker).** Container läuft 2026.10.4, Repo ist 2026.9.2. Entweder:

- (a) Build auf den Repo-Stand bringen — dann greifen die Tier-3-Fixes aus 2026.9.2 direkt, **oder**
- (b) den 2026.10.4-Code als Basis nehmen und die Fixes dorthin portieren.

Ohne das ist jeder Source-Patch eine Lotterie.

**Schritt 1 — Sofort wirksam, rein operativ (kein Restart nötig):**
1.3 Cron deaktivieren (`cron.enabled: false`) → **das 429-Problem verschwindet**, 838 Cron-Turns weg.
1.4 Model-Fallback prüfen, damit ein 429 nicht den Turn killt.
2.1–2.4 Storage aufräumen (`tmp/plugin-captures`, `backups/`, `lcm.db` VACUUM, Agent-DBs) → ~4 GB frei.
2.6 Hängenden `openclaw configure`-Prozess beenden → 529 MB.
2.5 Stale Sessions schließen → Worker + Handles frei.

**Schritt 2 — Config-Hebel für Immersion + Latenz:**
1.1 `contextInjection: "continuation-skip"` → weniger Cache-Drops, stabilere Persona.
1.2 `bootstrapMaxChars: 32000` → keine AGENTS.md-Kürzung mehr.
1.5 Vision-Model für `logbook` + Node mit `screen.snapshot` → Vision-Immersion.

**Schritt 3 — Source-Fixes (nach Schritt 0):**
3.1 Settings-Manager pro Session (Latenz) → 3.3 Catalog-Worker-Idle-Retirement (1,5 GB) → 3.2 Extension-Cache-Mapping → 3.5 `historyRewrite`-Ursache im 2026.10.4-Code.

**Schritt 4 — Datenverlust-Risiko (unabhängig, aber dringend):**
2.8 `agents/` + `state/` aus dem Native-Volume **zurück auf Bind-Mount** (nach dem SQLite-Busy-Fix) **oder** ein Volume-Backup einrichten. Aktuell existiert der im Override-File dokumentierte Sync-Back **nicht**.

---

## Anhang — Kommandos zur Reproduktion

```bash
# Ressourcen
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}'

# Top-Prozesse im Gateway
docker exec openclaw-docker-openclaw-gateway-1 \
  ps -eo pid,ppid,pcpu,rss,etimes,args --sort=-rss

# Codex-Leck
docker exec openclaw-docker-openclaw-gateway-1 sh -c 'ps -eo etimes,args | grep "codex.*app-server" | grep -v grep | wc -l'

# Storage
docker exec openclaw-docker-openclaw-gateway-1 sh -c 'du -sh /home/node/.openclaw/* | sort -rh'

# Mounts (Split-Brain sichtbar)
docker inspect openclaw-docker-openclaw-gateway-1 \
  --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

# Cache-Drops
docker logs openclaw-docker-openclaw-gateway-1 2>&1 | grep -c 'prompt-cache'

# Memory-Pressure
docker logs openclaw-docker-openclaw-gateway-1 2>&1 | grep -c 'memory pressure'

# Cron-Last
docker logs openclaw-docker-openclaw-gateway-1 2>&1 | grep -c 'channel=cron'
```
