# Tier 2 Build & CI Optimization — Design Spec

> **Date:** 2026-09-07
> **Status:** Approved — ready for implementation planning
> **Scope:** `openclaw-docker` (openclaw/openclaw monorepo)
> **Packaging:** One spec, three separate branches + PRs
> **Supersedes:** `.scratch/build-ci-optimize-2026-09-07.md` (Tier 1 design)

## Executive Summary

Three follow-up Build & CI speed optimizations that build on Tier 1 (commit `c35f42e1` on `perf/build-ci-speedup-tier1`). All three are independent and will land as three separate branches + PRs for maximum isolation and revertability.

| # | Item | Branch name | Expected impact | Risk |
|---|---|---|---|---|
| §2.1 | CI buildx registry cache (GHCR, main-only, mode=max) | `perf/buildx-ghcr-cache` | 5-10× faster incremental Docker builds in CI | Medium — registry surface, auth, retention |
| §2.2 | A2UI bundle skip-if-present (file-exists) | `perf/a2ui-skip-if-present` | 1-3s per warm Docker build | Low — short-circuit on existing output |
| §2.3 | Vitest shard rebalance loop (profile-driven) | `perf/vitest-shard-rebalance` | 10-25% faster CI test lane when unbalanced | Low — measurement + manual commit |

All three are scoped so a single failure in one item does not block the others. None of them touch the runtime image, the public `pnpm` script surface (except for §2.3 adding one new `pnpm` script), or the public Docker image tags.

## Locked decisions (from brainstorm)

- **§2.1 registry:** GHCR (`ghcr.io/${{ github.repository_owner }}/openclaw/buildcache:*`)
- **§2.1 push strategy:** main-only — push only on `github.ref_name == 'main'`, all other jobs (PRs, dispatch) restore but never push
- **§2.1 cache mode:** `mode=max` — push all layers, even rarely-used, for max restore hit rate
- **§2.1 implementation shape:** reusable composite action `.github/actions/docker-buildx-with-cache/action.yml`
- **§2.2 trigger:** file-exists check on `extensions/canvas/src/host/a2ui/a2ui.bundle.js`
- **§2.3 approach:** profile-driven — read `pnpm ci:timings:recent` output, propose rebalance, hand-apply
- **Packaging:** one spec, three branches, three PRs

## §2.1 — CI buildx registry cache (GHCR, main-only, mode=max)

### Goal

Make incremental Docker image builds in CI 5-10× faster by caching buildx layer outputs in GHCR. Restore the cache on every Docker build job, but only push to the cache namespace on `main`.

### Architecture

**New composite action:** `.github/actions/docker-buildx-with-cache/action.yml`

- **Inputs:**
  - `image` (required): the image:tag to build (e.g., `openclaw:test`)
  - `context` (default: `.`): build context path
  - `dockerfile` (default: `Dockerfile`): Dockerfile path relative to context
  - `build-args` (optional, multi-line): extra `--build-arg` flags
  - `push-cache` (default: `false`): explicit override; auto-set to `true` when `github.ref_name == 'main'`
  - `cache-namespace` (default: `buildcache`): the GHCR tag prefix
  - `target` (optional): `--target` flag for multi-stage builds

- **Behavior:**
  1. Compute cache reference: `ghcr.io/${{ github.repository_owner }}/${{ inputs.cache-namespace }}:branch-${{ github.ref_name }}` (with a fallback to `branch-main` when on a PR for safer restores)
  2. If `inputs.push-cache == 'true'` AND `github.ref_name == 'main'`: emit `--cache-to type=registry,ref=<cache-ref>,mode=max`
  3. Always emit `--cache-from type=registry,ref=<cache-ref>` (with `mode=max` to match)
  4. Invoke `docker buildx build` with the assembled flags
  5. Auth uses the auto-attached `GITHUB_TOKEN` via `docker/login-action` (only when push-cache is true; pull-only auth via `ghcr.io` anonymous works for public images)
  6. Tag and load the resulting image (the existing workflows already do this)

- **Output:** the action's `image` output echoes back the full image:tag for downstream steps

### Cache namespace layout

```
ghcr.io/openclaw/openclaw/
├── buildcache:branch-main       # the authoritative cache, written only on main
├── buildcache:branch-stable     # optional, same shape
└── ...actual published images, never overlapped by buildcache:*
```

The `buildcache:` prefix and dedicated `cache-namespace` input prevent any collision with the actual published `openclaw/openclaw:*` tags.

### Files to change

- **NEW** `.github/actions/docker-buildx-with-cache/action.yml` (~60 lines)
- **NEW** `.github/actions/docker-buildx-with-cache/README.md` (~20 lines) — inputs/outputs docs
- **MODIFY** `.github/workflows/install-smoke-reusable.yml` (5 invocations: lines 138, 353, 669, 820, 893) — replace `docker buildx build` shell with the new action
- **MODIFY** `.github/workflows/full-release-validation.yml` (line 743) — same

**Explicitly NOT modified:** `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml` (uses `DOCKER_BUILDKIT=1 docker build`, not `buildx`). Converting to buildx is a separate, larger change. The cache benefit does not apply to these jobs in this spec.

### Verification

- Push a trivial change to a feature branch: the buildx job should log "CACHED" for most layers and total wall-time should drop 30-60% vs the pre-§2.1 baseline.
- Push to a test branch with the `OPENCLAW_CI_RUNNER_BACKEND=github` var set (forces GitHub-hosted runners): the build should still complete, just with cache misses on every run.
- Run a workflow_dispatch on `main` with `push-cache: true`: the `buildcache:branch-main` tag in GHCR should update to a new digest.
- A subsequent PR run should restore the same `buildcache:branch-main` tag and log cache hits.

### Rollback

The action is a thin wrapper. Reverting the workflow file changes (replace the action call with the original `docker buildx build` command) restores the pre-§2.1 behavior. The cache tag in GHCR can be left in place; it is not referenced by any other code path.

## §2.2 — A2UI bundle skip-if-present (file-exists)

### Goal

Short-circuit the A2UI bundle step in the Dockerfile when its output is already present in the build context, saving the `pnpm canvas:a2ui:bundle` invocation (node module resolution + TS file load + rollup-style bundle).

### Change

**File:** `Dockerfile:146-151`

Wrap the existing step in a file-exists guard. The current step is:

```dockerfile
RUN pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p extensions/canvas/src/host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
     echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
```

The new step:

```dockerfile
RUN if [ ! -f extensions/canvas/src/host/a2ui/a2ui.bundle.js ]; then \
      pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle || \
        (echo "A2UI bundle: creating stub (non-fatal)" && \
         mkdir -p extensions/canvas/src/host/a2ui && \
         echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
         echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash && \
         rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI); \
    else \
      echo "A2UI bundle already present, skipping"; \
    fi
```

The skip is a hard short-circuit. The `pnpm` script is not invoked; the stub fallback is also not invoked. The build continues to the next `RUN` step.

### Files to change

- **MODIFY** `Dockerfile:146-151` — 6-line addition (the `if`/`fi` wrapper + the `else` echo)

### Verification

- **Cold build (no bundle in context):** wall-time should match the pre-§2.2 baseline within 1-2s. The `else` branch never runs.
- **Warm build (bundle pre-populated in context, e.g., via a `COPY --from=…` step in a parent pipeline or a CI cache):** the step should be ~0.5-1s (just the `test -f` check + the echo) and the log should contain `A2UI bundle already present, skipping`.
- **CI smoke:** run a Docker build on a CI run that previously had the bundle pre-populated. The `pnpm canvas:a2ui:bundle` command should not appear in the build log.

### Rollback

A single-line change. Reverting the `if`/`else`/`fi` wrapper restores the pre-§2.2 behavior.

## §2.3 — Vitest shard rebalance loop (profile-driven)

### Goal

Reduce CI wall-time on the test lane by rebalancing the 11 existing vitest shard tsconfigs (`test/tsconfig/tsconfig.core.test.*.json`) based on actual recent shard timings, not static estimates.

### Architecture

**New helper script:** `scripts/vitest-shard-rebalance.mjs` (~80 lines, pure Node ESM, no TypeScript to keep runtime overhead minimal)

- **CLI:**
  - `--timings <path>` (default: `pnpm ci:timings:recent` output, captured to a temp file): JSON or plain-text timing report
  - `--shards <count>` (default: 11): the existing shard count
  - `--output <path>` (default: `rebalance-proposal.json`): where to write the proposed rebalance
  - `--dry-run` (default: `true`): never write to tsconfigs; always emit the proposal

- **Behavior:**
  1. Parse the timings report, group by `matrix.group` (= shard name)
  2. Compute the per-shard median wall-time
  3. Identify the slowest shard
  4. Identify candidate files to move: read the slowest shard's `include` glob, then propose moving a fraction of those files to lighter shards
  5. Round-robin by current per-shard weight to keep the per-shard wall-time within ±10% of the median
  6. Write `rebalance-proposal.json` with the form `{shard: {include: [...], exclude: [...]}}` for each shard
  7. Print a summary table (current vs proposed per-shard wall-time, expected total speedup)

- **Output file shape (example):**
  ```json
  {
    "shards": [
      {"name": "agents-other", "include": ["src/agents/other/**"], "exclude": ["src/agents/other/slow/**"]},
      {"name": "agents-other-moved", "include": ["src/agents/other/slow/**"]}
    ],
    "expected_median_ms": 12345,
    "expected_total_speedup_pct": 18
  }
  ```

### Files to change

- **NEW** `scripts/vitest-shard-rebalance.mjs` (~80 lines)
- **NEW** `package.json` script: `"vitest:rebalance": "node scripts/vitest-shard-rebalance.mjs"`
- **MODIFY** `docs/ci.md` (one paragraph): document the rebalance loop
- **(Optional, hand-applied)** `test/tsconfig/tsconfig.core.test.*.json` — the actual shard edits, applied by the user after reviewing the proposal

### Verification

- **Run the script on the most recent `ci:timings:recent` output** (requires access to a recent CI run; if unavailable, the script is still runnable but produces a no-op proposal).
- **Compare median wall-time before/after a hand-applied rebalance** using `pnpm ci:timings:recent` again.
- **No automatic tsconfig edits** — the script only writes the proposal file. Human review is mandatory.

### Rollback

The script is a separate file. The `pnpm vitest:rebalance` script can be removed from `package.json` without affecting any other workflow. The actual tsconfig edits (if any are applied) can be reverted individually with `git revert`.

## Test plan (overall)

| Item | Local test | CI test | Manual smoke |
|---|---|---|---|
| §2.1 | `act workflow_dispatch` with the new action | First PR run: cache miss + restore, log shows restore. Subsequent runs: cache hit | Visual log inspection |
| §2.2 | `time docker build .` on cold and warm contexts | Inspect CI build log for `A2UI bundle already present, skipping` on warm runs | n/a |
| §2.3 | `pnpm vitest:rebalance --dry-run` on the latest `ci:timings:recent` | Run the rebalanced shards; compare wall-time | n/a |

## Out of scope

- **CI buildx cache for native apps** (iOS, Android, macOS) — different cache needs, separate spec
- **A2UI hash check** — only file-exists for now; the hash check can be a follow-up if needed
- **Vitest shard count change** — we keep the 11 shards; we just rebalance within them
- **Cross-PR cache sharing** — explicitly deferred (main-only push strategy)
- **Auto-application of vitest rebalance** — explicitly manual

## Acceptance criteria

- All three branches merge green into `main` (assuming Tier 1 is also green)
- Docker CI build time drops ≥ 30% on a second consecutive main run (proves §2.1 cache works)
- `pnpm format:check` is still clean (no spillover from §2.2/§2.3 file changes)
- No new CI workflow failures attributable to these changes
- `git revert` of any single § commit is sufficient to roll back that item

## Reference

- Tier 1 design (predecessor): `.scratch/build-ci-optimize-2026-09-07.md` (local, gitignored)
- Tier 1 implementation: `c35f42e1` on `perf/build-ci-speedup-tier1`
- `pnpm ci:timings:recent` output: required data source for §2.3 first run
