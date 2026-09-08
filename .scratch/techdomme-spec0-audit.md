=== Final audit report ===
# Techdomme Spec 0 — Final Audit

> Generated 2026-09-07 against branch feature/techdomme-gateway-skin
> at commit ab41718a.

## Branch state

- 5 commits ahead of main
- 19 files changed, 1882 insertions(+), 1 deletion(-)
- Working tree clean (only unrelated untracked files: .env.bak, Dockerfile.brew, .scratch)

## Commits

| Commit | What | Tests |
|---|---|---|
| 130e201c | docs(specs): techdomme gateway-skin (Spec 0) design | n/a |
| fa7aa49e | feat(gateway): schema + provider + resolver | 11 |
| 37983182 | feat(extension/techdomme): scaffold + persona + placeholder skill | 6 |
| 85878055 | docs(specs): Drizzle -> Kysely correction | n/a |
| ab41718a | feat(gateway): middleware + admin RPC modules | 18 |

## Spec section coverage

| Spec section | Implementation |
|---|---|
| §0.1 Architecture & Components | partial — gateway core + extension files exist; openclaw wire-in (where the middleware gets called from) is a follow-up commit |
| §0.2 Data model + Activation flow | complete — schema v17, provider, resolver, all 4 activation combinations |
| §0.3 Persona overlay + Skill injection | complete — apply.ts (locale fallback + XML wrap), skills/index.ts (duplicate-skip), placeholder-mode-info.ts (smoke-test skill), index.ts (entry point that reads TechdommeSessionContext) |
| §0.4 Error handling + testing | partial — fail-closed + fail-soft implemented and tested; integration + E2E tests deferred |

## Test inventory

| File | Cases |
|---|---|
| src/gateway/techdomme/activation.test.ts | 11 |
| src/gateway/techdomme/middleware.test.ts | 8 |
| src/gateway/techdomme/rpc.test.ts | 10 |
| extensions/techdomme/src/persona/apply.test.ts | 6 |
| **Total** | **35** |

Run with: `pnpm vitest run src/gateway/techdomme/ extensions/techdomme/`

## Open TODOs (deliberately placed, documented in code)

- `src/gateway/techdomme/provider.ts` — `TODO(regen-types)`: Kysely database type
  has not been regenerated for v17 yet. Raw SQL strings used in the prepared
  statements; the typed `selectFrom(...).executeTakeFirst()` shape will
  follow once the type regen lands. Functionally correct today.
- `extensions/techdomme/index.ts` — `TODO(sdk-hook)`: the openclaw SDK in the
  version this branch targets does not yet expose a stable system-prompt
  mutation hook. `applyPersonaOverlay` renders the block and logs it; the
  actual prepend to the active agent's prompt becomes a one-liner once
  the SDK lands the hook.

## Out-of-scope for this branch (documented in commit messages)

- Wire the openclaw server-aux-handlers / server.sessions.create integration
  that calls `attachTechdommeContextToSession` and `setUserPref` /
  `setChannelOverride`. The pure modules are in place; the openclaw-specific
  glue is a follow-up.
- Cross-component integration tests and the extension E2E (require the
  wire-in to exist first).
- The 15+ per-skill specs the design promises. Each is a separate brainstorm
  cycle (per the locked-in 'pro Skill eine Spec' decision).

## What to do next (suggested)

1. Push: `git push -u origin feature/techdomme-gateway-skin`
2. Open PR; let CI run; iterate on any oxlint/oxfmt/tsgo findings
3. In a fresh session (or this same branch with more reading time), wire
   the openclaw server-aux-handlers: 3 small changes, each isolated
4. Merge; then start the first of the 15+ skill specs
