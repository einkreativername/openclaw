# Techdomme Gateway-Skin (Spec 0) — Design Spec

> **Date:** 2026-09-07
> **Status:** Approved — ready for implementation
> **Scope:** `openclaw-docker` (openclaw/openclaw monorepo)
> **Branch:** `feature/techdomme-gateway-skin`
> **Supersedes:** none (first techdomme spec)
> **Follows on:** the 4 design sections approved during brainstorm 2026-09-07

## Executive Summary

First concrete slice of the techdomme feature: a **Gateway-Skin** that turns the techdomme mode on or off per session, plus an **extension skeleton** that hosts persona text and skill registration. No new agent types; no skill content (those are follow-on specs, one per skill). The skin is the platform on which all future techdomme skills (planned: 15+) will plug in.

**Locked decisions (from brainstorm):**

| Axis | Decision |
|---|---|
| Techdomme meaning | Gateway-Skin + Skill-Pack, no new agent type |
| Activation scope | Hybrid: per-user default + per-channel override |
| Agent compatibility | All agents (generic) |
| Skill-pack scope (later) | Full bundle 15+ skills, one spec per skill |
| Architecture | **Approach C: Hybrid** — activation in gateway core, persona + skills in extension |
| This spec covers | Only the skin (Spec 0). Skills are follow-on specs. |

## §0.1 Architecture & Components

**Gateway Core (in `src/gateway/techdomme/`):**

| File | Responsibility |
|---|---|
| `src/gateway/techdomme/activation.ts` | Pure function: given `(user_id, channel_id)` → resolves to `TechdommeMode = { active: bool, source: 'user' \| 'channel' \| 'off', reason? }`. Cached per-process (60s TTL). No I/O at call site; uses injected `TechdommeActivationProvider`. |
| `src/gateway/techdomme/provider.ts` | Drizzle-backed provider. Reads `user_techdomme_prefs` and `channel_techdomme_overrides`. Used by activation.ts and by the admin HTTP RPC (per-user toggle UI). |
| `src/gateway/techdomme/middleware.ts` | Gates session start. Reads `(user, channel)` → calls activation → if active, attaches a `TechdommeSessionContext` to the session for downstream consumers. |
| `src/gateway/migrations/<ts>_techdomme.sql` | Drizzle migration: `user_techdomme_prefs`, `channel_techdomme_overrides`, `techdomme_mode_activations`. |
| `src/gateway/techdomme/rpc.ts` | Admin HTTP RPC handlers: `techdomme.setUserPref(user_id, enabled)`, `techdomme.setChannelOverride(channel_id, enabled\|null)`. Used by the admin UI. |

**Extension (in `extensions/techdomme/`):**

| File | Responsibility |
|---|---|
| `extensions/techdomme/manifest.yml` | Extension manifest. Declares the extension, its version, and a single placeholder skill (`techdomme-mode-info`) for now. |
| `extensions/techdomme/src/index.ts` | Extension entry point. Reads `TechdommeSessionContext` set by the gateway middleware. If active: applies persona overlay and registers the active skill set with the openclaw skill registry. If not: no-op. |
| `extensions/techdomme/src/persona/<locale>.md` | Persona text per locale. Default: `en.md` and `de.md`. Loaded by `applyToSystemPrompt` based on session locale. |
| `extensions/techdomme/src/persona/apply.ts` | `applyToSystemPrompt(basePrompt, ctx) → string`. Wraps persona in a labeled XML block and prepends to the base prompt. |
| `extensions/techdomme/src/skills/index.ts` | `registerTechdommeSkills(registry, ctx)` entry point. Iterates over skill files in the same directory. |
| `extensions/techdomme/src/skills/<skill-name>.ts` | One file per skill. Each exports `{ name, description, appliesWhen(ctx), run(args, ctx) }`. Future per-skill specs add new files (no manifest change needed). |
| `extensions/techdomme/src/skills/placeholder-mode-info.ts` | The single placeholder skill shipped with Spec 0. Returns a status summary for the active session. |

**Why this split:** activation is always available, even if the extension fails to load (fail-closed for safety, fail-soft for resilience — see §0.4). Persona + skills are versioned with the extension, easy to iterate, easy to swap out.

## §0.2 Data Model + Activation Flow

**Data model (Drizzle schema):**

```sql
-- One row per user. Created on first toggle, never deleted.
CREATE TABLE user_techdomme_prefs (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  techdomme_enabled BOOLEAN NOT NULL DEFAULT false,
  locale            TEXT NOT NULL DEFAULT 'en',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per channel. NULL = inherit user default; non-NULL = explicit override.
CREATE TABLE channel_techdomme_overrides (
  channel_id        TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  techdomme_enabled BOOLEAN NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit log. One row per session start.
CREATE TABLE techdomme_mode_activations (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  mode_source       TEXT NOT NULL CHECK (mode_source IN ('user', 'channel', 'off')),
  reason            TEXT NULL,
  extension_version TEXT NULL,
  activated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX techdomme_mode_activations_user_idx ON techdomme_mode_activations (user_id, activated_at DESC);
CREATE INDEX techdomme_mode_activations_session_idx ON techdomme_mode_activations (session_id);
```

**Activation flow (per session start):**

1. Gateway middleware fires before any agent dispatch.
2. `activation.resolve(user_id, channel_id, provider)`:
   - Reads `user_techdomme_prefs` (60s in-process cache, scoped per process).
   - Reads `channel_techdomme_overrides` (60s in-process cache).
   - Resolves: if channel override is non-NULL → that wins; else user default. `source` records which table the value came from.
   - Returns `TechdommeMode = { active: bool, source, locale, version }`.
3. Middleware attaches a `TechdommeSessionContext` to the session object.
4. Extension entry point reads the context. If `active`: apply persona overlay + register skills. If not: no-op.
5. Activation log row written (one per session, regardless of active state, for audit).

**Cache invalidation:**
- `user_techdomme_prefs` write → invalidate user cache (next session for that user reads fresh).
- `channel_techdomme_overrides` write → invalidate channel cache.
- Active sessions are NOT retroactively updated — a user toggling off mid-session keeps the session behavior until the next session starts.

**Out of scope for Spec 0:** real-time toggle mid-session, opt-in/opt-out per-skill, per-skill permissions, persona tuning UI, gamification, daily check-in, etc. All of those are candidate follow-on specs.

## §0.3 Persona Overlay + Skill Injection Contract

**Persona overlay contract:**

- Persona text lives in `extensions/techdomme/src/persona/<locale>.md` (e.g. `de.md`, `en.md`). One file per locale.
- The extension's `applyToSystemPrompt(basePrompt, ctx)` reads the file matching `ctx.locale`, falls back to `en.md` if missing.
- The persona text is prepended to the base agent prompt as a labeled block:

```
<techdomme-persona locale="de" version="0.1.0">
...persona text...
</techdomme-persona>

<base-agent-prompt>
...agent's original prompt...
</base-agent-prompt>
```

Wrapping in named blocks makes the overlay visible in logs/prompts and easy to strip for debugging.

**Edge cases:**
- Agent has no system prompt: the base block is empty and only the persona block is sent.
- Extension fails to load: no overlay applied; the gateway logs a warning and the session continues normally (fail-soft).

**Skill injection contract:**

- The extension's `extensions/techdomme/src/skills/index.ts` exports `registerTechdommeSkills(registry, ctx)`. It iterates over the skill files in the same directory and registers each with the openclaw skill registry.
- The gateway's skill loader, when a session has `techdomme.active === true`, queries the registry for all skills tagged `techdomme:*` and adds them to the session's available skills BEFORE the agent's skill selection. The agent can then invoke them like any other skill.
- Each skill is a separate file: `extensions/techdomme/src/skills/<skill-name>.ts` exports `{ name, description, appliesWhen(ctx), run(args, ctx) }`. Future per-skill specs add new files (no extension manifest change needed).

**Edge cases:**
- Two skills with the same `name` → the extension's loader errors at startup and the session logs the conflict.
- A skill file fails to load → that skill is skipped with a warning; the rest register.

## §0.4 Error Handling + Testing

**Error handling (fail-closed for safety, fail-soft for resilience):**

| Failure | Behavior |
|---|---|
| DB unreachable / `activation` provider throws | `activation.resolve` catches, logs warning, returns `{ active: false, source: 'off', reason: 'activation_error' }`. Session proceeds normally; no persona, no skills. Safer than exposing unverified techdomme behavior. |
| Extension fails to load | Persona overlay not applied, skills not registered, session continues with normal mode. Gateway logs a `warn` with the load error. Activation log row still records the session (source: 'off' + reason: 'extension_unavailable'). |
| Cache corruption | Treated as a miss, re-fetched from DB. No special handling — the in-process cache is best-effort. |
| Per-user toggle during active session | Cached value sticks until next session start. A user toggling OFF mid-session keeps current session's techdomme behavior; the next session starts in OFF. |
| Concurrent toggles | Last-write-wins at the DB level. Drizzle handles via `updated_at` check. No application-level locking. |
| Audit log write fails | Logged at `error` level. Session proceeds; audit incompleteness is a known-but-acceptable failure mode for v0. |

**Testing strategy:**

- **Unit** (`src/gateway/techdomme/*.test.ts`):
  - `activation.resolve` — all 4 combinations (no user / no channel / user-set / channel-override-set)
  - cache hit/miss behavior
  - error fallback (DB throws → returns 'off' with reason)
- **Integration** (`test/integration/techdomme/`):
  - middleware attaches context correctly to a real session
  - audit log row written with correct fields
  - migration up + migration down (round-trip)
- **Extension E2E** (`extensions/techdomme/test/`):
  - full session in techdomme mode: persona visible in system prompt, skills callable
  - channel override beats user default
  - extension fail-load → session normal, warn logged
- **Manual smoke**: per-user toggle UI in the gateway admin panel; per-channel override UI in the channel config.

**Acceptance criteria:**

- Toggling user pref → next session for that user reflects the new state.
- Setting channel override → next session in that channel reflects the override.
- Extension uninstalled → sessions in techdomme mode fall back to normal (no crash, no orphan skills).
- All existing openclaw tests still pass (no regression).

## Out of Scope (deferred to follow-on specs)

- Concrete skill content (15+ skills, one spec each)
- Per-skill permission system
- Persona tuning UI
- Daily check-in, gamification, streaks, reward/punishment mechanics
- Per-skill audit trail beyond the session-start log row
- Real-time mid-session toggle

## Files Touched in Spec 0

**New files (~10):**

```
src/gateway/techdomme/activation.ts
src/gateway/techdomme/activation.test.ts
src/gateway/techdomme/provider.ts
src/gateway/techdomme/provider.test.ts
src/gateway/techdomme/middleware.ts
src/gateway/techdomme/middleware.test.ts
src/gateway/techdomme/rpc.ts
src/gateway/techdomme/rpc.test.ts
src/gateway/migrations/<ts>_techdomme.sql
extensions/techdomme/manifest.yml
extensions/techdomme/src/index.ts
extensions/techdomme/src/persona/apply.ts
extensions/techdomme/src/persona/apply.test.ts
extensions/techdomme/src/persona/en.md
extensions/techdomme/src/persona/de.md
extensions/techdomme/src/skills/index.ts
extensions/techdomme/src/skills/placeholder-mode-info.ts
extensions/techdomme/test/e2e.test.ts
```

**Modified files (~1):**

```
src/gateway/middleware/index.ts   # wire in the new techdomme middleware
```

## Open Questions (carry forward to follow-on specs)

- Locale negotiation: which locale wins when user pref locale differs from session locale? (Default: user pref, fall back to session, fall back to en.)
- Skill discovery order: alphabetical, by `appliesWhen` priority, or by user preference?
- Audit retention policy: how long do `techdomme_mode_activations` rows live?
