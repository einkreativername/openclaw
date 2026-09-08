# Build & CI Speed Optimization Plan

> **Date:** 2026-09-07
> **Author:** Mavis (superpower-10x audit)
> **Scope:** `openclaw-docker` fork (openclaw/openclaw monorepo)
> **Status:** Design — awaiting sign-off

## Executive Summary

The repo already runs a sophisticated CI/CD surface (Blacksmith 4-32 vCPU runners, multi-stage Dockerfile with BuildKit mount caches, pnpm store + dep + Vitest + Node compile caches, 11 vitest shard tsconfigs, isolated nodeLinker, manifest-only Docker COPY layers, architecture-filtered pnpm installs). Most of the easy wins are already in place.

**Three low-risk, high-leverage wins remain** (estimated 30-60% faster local Docker builds, 2-4× faster `pnpm format`, 15-25% faster `pnpm build:docker`):

1. **Dockerfile: collapse the double `pnpm install`** — currently `prod-deps` and `build` stages each run a full pnpm install pass against the same lockfile and the same BuildKit-mounted pnpm store. One full install + post-build prune is enough.
2. **`format` script: drop artificial `--threads=1`** — oxfmt is multi-threaded by default; the existing flag forces single-threaded execution. Use `--threads=$N` where `N` is detected CPU count.
3. **`pnpm build:docker`: parallelize independent steps** — the 9-step chain has at least two independent groups (asset prep vs ts compile) plus an independent check (`check-cli-bootstrap-imports`) that can run alongside postbuild.

## Tier 1 — High leverage, low risk (recommended for this branch)

### 1.1 Dockerfile: collapse double pnpm install

**Current state** (`Dockerfile:93-97` and `Dockerfile:112-116`):

```dockerfile
# production-deps stage
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile --prod \
      --config.supportedArchitectures.os=linux --config.supportedArchitectures.cpu="$(node -p 'process.arch')" --config.supportedArchitectures.libc=glibc
RUN sh scripts/docker/verify-native-addons.sh

# build stage (separate)
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile \
      --config.supportedArchitectures.os=linux --config.supportedArchitectures.cpu="$(node -p 'process.arch')" --config.supportedArchitectures.libc=glibc
RUN sh scripts/docker/verify-native-addons.sh
```

Two pnpm install passes through the same lockfile. Even with a hot store, the second pass re-walks the lockfile and re-links the workspace graph (the `runtime-assets` stage then has to merge them).

**Proposed change** — one full install in `build`, prune to prod in `runtime-assets`:

```dockerfile
# production-deps: keep as-is, it provides the seed for the runtime image
FROM dependency-inputs AS production-deps
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile --prod \
      --config.supportedArchitectures.os=linux --config.supportedArchitectures.cpu="$(node -p 'process.arch')" --config.supportedArchitectures.libc=glibc
RUN sh scripts/docker/verify-native-addons.sh

# build: install ONCE (full), do not re-link later
FROM dependency-inputs AS build
# ... (existing install block unchanged)

# runtime-assets: after copying build output, prune to prod
FROM production-deps AS runtime-assets
COPY --from=runtime-build-output /app/ ./
RUN pnpm prune --prod  # trims devDependencies from the merged install
```

**Expected win:** 30-90s on a cold cache (one less `pnpm install` pass over 1k+ packages). Hot cache: ~5-15s.

**Risk:** Need to confirm `runtime-build-output` is dropped (`node_modules` removed) so the `production-deps` install is the only thing that ships. The existing `runtime-build-output` stage already does `rm -rf node_modules ui/node_modules` and prunes package node_modules. So the production tree is the only `node_modules` that ships. Good.

**Verification:**
- `docker build -t openclaw:test .` succeeds end-to-end
- Image size deltas are within ±5% (slight increase is OK, fewer layers)
- Runtime smoke: `docker run --rm openclaw:test openclaw --version`
- `docker run --rm openclaw:test node -e "require('grammy')"` (validate dynamic import)

### 1.2 `format` script: drop artificial `--threads=1`

**Current state** (`package.json:1706-1713`):

```json
"format": "oxfmt --write --threads=1",
"format:check": "oxfmt --check",
"format:diff": "oxfmt --write --threads=1 && git --no-picker diff",
"format:fix": "oxfmt --write --threads=1",
```

**Proposed change** — detect CPU count, leave CI to use the default (which is already multi-threaded):

```json
"format": "node -e \"const n=Math.max(1,require('node:os').cpus().length-1);process.argv=['oxfmt','--write',`--threads=${n}`];require('child_process').spawnSync('oxfmt',['--write',`--threads=${n}`],{stdio:'inherit'})\"",
```

Or, more readable: introduce `scripts/oxfmt-parallel.mjs` that resolves threads and shells out. Update `format`, `format:diff`, `format:fix` to use it.

**Expected win:** 2-4× speedup on a full `pnpm format` (current `--threads=1` is the bottleneck on a 4-8 vCPU runner).

**Risk:** Higher peak memory. oxfmt is memory-light, but on 4 vCPU GitHub-hosted runners the default `--threads=8` is too aggressive. Use `cpus().length - 1`.

**Verification:**
- `time pnpm format` baseline → after
- `pnpm format:check` should produce identical results
- No new oxfmt warnings (output diff should be empty on a clean tree)

### 1.3 `pnpm build:docker`: parallelize the 9-step chain

**Current state** (`package.json:1218`):

```json
"build:docker": "pnpm plugins:assets:build && node ... tsdown-build.mts && node ... check-cli-bootstrap-imports.mts && node ... runtime-postbuild.mjs && node ... build-stamp.mts && node ... runtime-postbuild-stamp.mts && pnpm plugins:assets:copy && node ... write-build-info.ts && node ... write-cli-startup-metadata.ts"
```

9 serial steps. Step 3 (`check-cli-bootstrap-imports`) reads `dist/` and is independent of steps 4-9 in the sense that it doesn't mutate anything those steps read. Step 7 (`plugins:assets:copy`) only needs `extensions/*/dist`, which `plugins:assets:build` provides, but is independent of `tsdown-build`.

**Proposed change** — split into three concurrent groups, then a serial tail:

```json
"build:docker": "pnpm build:docker:phase1 && pnpm build:docker:phase2 && pnpm build:docker:phase3",
"build:docker:phase1": "pnpm plugins:assets:build & pnpm build:docker:tsdown-check & wait",
"build:docker:tsdown-check": "node ... tsdown-build.mts && node ... check-cli-bootstrap-imports.mts",
"build:docker:phase2": "node ... runtime-postbuild.mjs && node ... build-stamp.mts && node ... runtime-postbuild-stamp.mts",
"build:docker:phase3": "pnpm plugins:assets:copy & pnpm build:docker:metadata & wait",
"build:docker:metadata": "node ... write-build-info.ts && node ... write-cli-startup-metadata.ts"
```

**Expected win:** 15-25% on `pnpm build:docker` total. tsdown is the dominant cost (~60% of the script), so running it in parallel with `plugins:assets:build` saves 10-20s. The metadata tail parallelization is smaller (~3-5s) but free.

**Risk:** If `tsdown-build.mts` reads anything from `plugins:assets:build` output (e.g., embeds an asset manifest), the parallelization is unsafe. Need to verify by reading the script. (Will do before applying.)

**Verification:**
- `pnpm build:docker` succeeds; resulting `dist/` byte-identical to baseline (use `git status --porcelain` + a build manifest hash)
- `pnpm test:docker:all` smoke pass (only if the test lane doesn't need a published image)

## Tier 2 — Medium leverage, more risk (follow-up pass)

### 2.1 CI Docker build: add buildx cache to/from registry

The Docker build invocations in `install-smoke-reusable.yml` and `full-release-validation.yml` use `docker buildx build` but I do not see a `--cache-from type=registry` argument. Adding it (pointing at the existing `openclaw/openclaw` GHCR / Docker Hub namespace) would make incremental Docker builds in CI ~5-10× faster. The cache key should follow the same dependency-fingerprint scheme used for the pnpm store.

**Risk:** Cache poisoning if the registry is compromised. Mitigated by the digest-pin pattern already in use for base images. Needs a registry namespace decision (GHCR vs Docker Hub).

### 2.2 A2UI bundle skip-if-present

The current pattern is `pnpm canvas:a2ui:bundle || (echo stub; mkdir -p ...; echo stub > ...)`. The `pnpm` invocation itself does node module resolution and a TypeScript file load. We can short-circuit with a file existence check first:

```dockerfile
RUN if [ ! -f extensions/canvas/src/host/a2ui/a2ui.bundle.js ]; then \
      pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle || \
        (echo "A2UI bundle unavailable; creating stub" && \
         mkdir -p extensions/canvas/src/host/a2ui && \
         echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
         echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash); \
    fi
```

**Expected win:** 1-3s on warm builds (the `pnpm` script load is the dominant cost when the bundle is already there).

**Risk:** Low — if the bundle output is wrong, the next step will fail loudly.

### 2.3 Vitest shard tuning

The repo has 11 vitest shard tsconfigs (`test/tsconfig/tsconfig.core.test.*.json`). For PR runs (fast lane) this is probably over-sharded; for main runs (full lane) it's probably correctly tuned. Profiling the recent `ci:timings:recent` output will tell us which shards dominate.

## Out of scope (already optimal)

- Blacksmith 4-32 vCPU runner selection (already on Blacksmith-32 for heavy jobs)
- pnpm store + dep + Vitest transform + Node compile caches (already comprehensive)
- pnpm `--config.supportedArchitectures.os=linux` filter in Docker (already in)
- Manifest-only COPY layers in Dockerfile (already in)
- BuildKit mount caches for pnpm store and apt (already in)
- `nodeLinker: isolated` for APFS clone optimization (already in)
- pnpm `minimumReleaseAge: 10080` minutes (already in)

## Plan & verification gates

1. Create branch `perf/build-ci-speedup-tier1`
2. Apply patches for §1.1, §1.2, §1.3
3. Static verification (no pnpm/node locally, so this is all I can do):
   - Shellcheck the modified Dockerfile
   - `node --check` on every modified `.mjs` / `.ts` script
   - `oxfmt --check` on the changed files
   - Diff review: no behavioral changes to existing build output
4. Hand the branch to the user with: (a) summary table, (b) full `git diff main..HEAD`, (c) suggested CI matrix to run
5. Wait for green CI before any merge

## Acceptance criteria

- `docker build` cold-cache time: ≥ 30% reduction (target 60s saved)
- `pnpm format` time: ≥ 2× faster on a clean tree
- `pnpm build:docker` time: ≥ 15% faster
- All existing tests pass (no behavioral change)
- `dist/` byte-identical to baseline build (modulo timestamps in build-info.json)
- Runtime smoke (`openclaw --version`, `node -e "require('grammy')"`) passes
