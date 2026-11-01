# Kimi Code Instructions — OpenClaw

Ich bin Kimi Code, nicht Claude Code. Diese Datei ergänzt die autoritativen Root-Quellen `AGENTS.md` und `CLAUDE.md` (Symlink) sowie die nächstgelegenen scopierten `AGENTS.md` in Unterbäumen wie `src/gateway/`, `src/agents/`, `src/plugins/`, `src/plugin-sdk/`, `src/channels/`, `src/tui/`, `apps/*/`, `extensions/`, `ui/`, `test/`, `docs/`.

## Projekt-TL;DR

OpenClaw ist ein AI-Assistant-Gateway, das lokal auf Geräten läuft und über Chat-Kanäle erreichbar ist. Ein einzelnes Gateway kann personal assistant oder shared team gateway sein — der Unterschied ist nur Konfiguration.

**Kernelemente:**

- **Gateway** (`src/gateway/`) — Kontrollebene für Sessions, Tools, Events, Channel-Connections, RPC, State.
- **Control UI** (`ui/`) — Web-Frontend, vom Gateway ausgeliefert (Lit + Vite).
- **CLI** (`src/cli/`, `openclaw.mjs`) — `openclaw` Kommandozeile.
- **TUI** (`src/tui/`) — Terminal-Chat (`pnpm tui`).
- **Channels** (`src/channels/`, `extensions/*/`) — Messaging-Integrationen.
- **Plugins / Extensions** (`src/plugins/`, `src/plugin-sdk/`, `extensions/`).
- **Agents** (`src/agents/`) — Agent-Runtime, Sessions, Tools, Harnesses, Subagents.
- **Native apps** (`apps/macos`, `apps/ios`, `apps/android`, `apps/linux`, `apps/shared`).

**Architektur-Grundsätze:**

- Core ist **plugin-agnostisch**.
- Plugins nutzen nur dokumentierte `openclaw/plugin-sdk/*`-Seams und Manifest-Metadaten.
- Runtime-State lebt in **SQLite**; Dateien sind für Artefakte, Logs, Backups, Imports/Exports.
- Channels sind **transport-only**.
- Privilegierte Aktionen erfordern **owner-held authority**, die nach `await` erneut validiert wird.
- Kompatibilität braucht einen **named contract** (public API/config/SDK/data contract, stable-tag upgrade, security/migration boundary, explicit user request).

## Stack & Commands

| Was                  | Befehl                                                                  |
| -------------------- | ----------------------------------------------------------------------- |
| Setup                | `pnpm install --frozen-lockfile`                                        |
| Build                | `pnpm build`                                                            |
| UI build             | `pnpm ui:build`                                                         |
| Dev runner           | `pnpm dev`                                                              |
| CLI                  | `pnpm openclaw <args>`                                                  |
| Gateway dev          | `pnpm gateway:dev`                                                      |
| TUI                  | `pnpm tui` / `pnpm tui:dev`                                             |
| UI dev               | `pnpm ui:dev`                                                           |
| Typecheck core       | `pnpm tsgo:core`                                                        |
| Typecheck extensions | `pnpm tsgo:extensions`                                                  |
| Typecheck UI         | `pnpm tsgo:ui`                                                          |
| Test                 | `pnpm test` / `pnpm test:changed` / `pnpm test:fast` / `pnpm test:unit` |
| Check (start here)   | `pnpm check:changed`                                                    |
| Lint                 | `pnpm lint`                                                             |
| Format               | `pnpm format` / `pnpm format:check`                                     |
| Docs finden          | `pnpm docs:list`                                                        |

**Wichtig:** Niemals `node --import tsx src/index.ts` verwenden. Immer `pnpm openclaw` oder `pnpm dev`.

## Code-Conventions

- TypeScript **ESM**, **strict**. Lieber echte Typen oder `unknown`; kein `any`, kein `@ts-nocheck`.
- Suppressions (`@ts-expect-error`) nur für erklärte, bewusste Ausnahmen.
- Formatter: `oxfmt` — 2 spaces, 100 print width, double quotes, trailing commas `all`, semicolons, LF.
- Line limits: 700 Zeilen für `.ts/.tsx`-Prod-Dateien, 800 für `.mjs/.cjs`, 1000 für Tests (ohne Kommentare/Leerzeilen).
- Sprache: **American English** in Code, Kommentaren, Docs, UI-Strings.
- Naming: Produkt = **OpenClaw**, CLI/Package/Config = **openclaw**, user-facing Integrations = **plugins**.
- Control UI verwendet **legacy** Lit-Decorators (`@state()`, `@property()`), nicht Standard-Decorators.
- Plugins importieren nur von `openclaw/plugin-sdk/*` und aus dem eigenen Package.
- Keine relativen Imports, die das Extension-Package root verlassen; keine direkten Imports aus `src/**` in Extensions.
- APIs schmal halten, valide Zustände explizit machen, Schema/Coercion-Helper wiederverwenden.
- Kommentare erklären Ownership, Lifecycle, Ordering, Cleanup, Plattform- und Dependency-Constraints — die geschützte Invariante, nicht die Syntax.
- Generated files nicht von Hand editieren; mit Repo-Tools regenerieren.

## Wichtige Invarianten

- **Plugin-agnostic core:** Provider/Channel/Tool-Policy gehört in Plugins; Core exposed generische Capabilities.
- **Manifest-first:** Discovery, Config-Validation und Setup müssen aus Plugin-Metadaten funktionieren, bevor Runtime losläuft.
- **SQLite runtime state:** Kanonischer State in SQLite. Vor Storage-Arbeiten `docs/reference/database-schemas.md` lesen.
- **Kysely + synchrone Writes:** SQLite-Write-Transaktionen sind synchron — async Planning zuerst abschließen, dann autoritativen State neu lesen, dann committen. **Kein `await` in einem Transaction-Callback.**
- **Authority revalidation:** Tokens, TTLs, matching IDs, Signaturen allein beweisen keine live authority. Nach `await` und vor Side-Effects Owner-Authority neu validieren.
- **Lazy, stable metadata:** Prozess-stabile Plugin-Metadaten und Lifecycle-Caches wiederverwenden; nicht wiederholt Registries laden oder Files freshness-pollen.
- **Channel boundary:** Channels sind transport-only. Unterscheide commands, approvals, URLs, model-picker actions, callbacks, plain strings bis zur Transport-Encoding-Grenze.
- **Deterministic ordering:** Prompt/Tool/Context-Ergänzungen brauchen harte Bounds und deterministische Reihenfolge.
- **Doctor owns repair:** `openclaw doctor --fix` besitzt Legacy-Normalisierung und Migration.

## Sicherheit, Approval & Live-State

- **Secrets:** Nie Credentials, private Config, Personal Data oder interne/unreleased Model-IDs in Source, Commits, Issues, Logs oder Proof-Captures. Synthetische Fixtures und stabile public Model IDs verwenden.
- **Untrusted code:** Contributor/Fork-Code nicht lokal ausführen. Secretless CI oder sanitized AWS Crabbox (`$crabbox`) verwenden. Keinen untrusted lease hydraten.
- **Live State:** Kein Gateway oder live State, den ich nicht selbst erstellt habe, ohne explizite per-task Operator-Approval stoppen/restarten/editieren. Tests verwenden isoliertes State-Dir und freien Port; echte Daten vor Migrationstests kopieren.
- **Änderungen, die Approval brauchen:**
  - Config-Optionen hinzufügen.
  - SQLite-Schema oder persistent-store Semantik ändern (retention, indexing, concurrency, recovery, projections).
  - Protocol version bumps, dependency patches/overrides/vendor changes, paid services, releases, publishing, version bumps.
  - GHSA/advisory creation oder mutation.
- **Reviews:** `CODEOWNERS` routed Reviewer. Restricted/security paths und materielle Produkt-/Verhaltens-/Sicherheits-/Ownership-Änderungen brauchen listed-owner involvement. Enforced Reviews/Checks nicht umgehen.
- **Baselines nicht schwächen:** Keine Snapshots, Ignores, expected failures oder Checks schwächen, um Defekte zu verschleiern. Shrink-only ratchet updates sind Maintenance; alles andere braucht Approval.
- **Audit:** Audit ist opt-in und nur Metadaten. Fehlende Audit-Zeile beweist nichts. Audit-Records nicht als Authorization-Evidence verwenden.

## Was Kimi Code nicht macht

- Claude-spezifische Skill-/Command-Referenzen wie `$openclaw-pr-maintainer`, `$technical-documentation`, `$test-audit`, `$autoreview`, `$clawsweeper` direkt aufrufen. Stattdessen: entsprechende Kimi-Tools/Subagents nutzen oder den Nutzer fragen.
- `node --import tsx src/index.ts` verwenden.
- `npm install` am Root verwenden (nur `pnpm`).
- `node_modules`, generated artifacts, Formatter/Linter-Configs von Hand editieren.
- Live Gateways oder fremden State ohne explizite Zustimmung stoppen/restarten/editieren.
- SQLite-Schema oder persistent-store Semantik ohne explizite Discussion/Approval ändern.
- Releases, Version bumps, dependency overrides/vendor changes ohne Approval.

## Proof & Landing

- Defekt vor dem Editieren reproduzieren, wenn möglich.
- Regression-Tests müssen am Original-Defekt aus dem richtigen Grund failen.
- Starte Checks klein: `pnpm check:changed` + fokussierte `pnpm test <path-or-filter>`.
- Nach SDK-Seam-, Lazy-Loading- oder bundled-plugin Artifact-Änderungen `pnpm build` laufen lassen.
- Für Channel/Gateway-Änderungen: real-flow proof oder isolierter mock-Gateway harness.
- Vor dem Landen nicht-trivialer Arbeiten `autoreview` laufen lassen, wenn verfügbar.
- Conventional Commits; keine agent-attribution trailers.
- Lande über `scripts/pr` mit `OPENCLAW_TESTBOX=1`, wenn required.
- PR-Body aktuell halten: problem, solution, impact, evidence.

## Wo ich nachlese

- `package.json` für Scripts, Exports, Dependency-Versionen.
- `pnpm-workspace.yaml` für Workspace-Layout.
- `tsconfig.json` für Compiler-Optionen und Path-Mapping.
- `.oxlintrc.json` / `.oxfmtrc.jsonc` für Lint/Format-Regeln.
- `docs/reference/database-schemas.md` für Storage-Contracts.
- `docs/gateway/audit.md`, `docs/gateway/secrets.md`, `docs/auth-credential-semantics.md`, `docs/plugins/sdk-channel-plugins.md`.
- Nächstgelegene scopierte `AGENTS.md` im bearbeiteten Unterbaum.
