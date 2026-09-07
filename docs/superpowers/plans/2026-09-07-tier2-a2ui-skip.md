# Tier 2 §2.2 — A2UI Bundle Skip-If-Present Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Short-circuit the A2UI bundle step in the Dockerfile when `extensions/canvas/src/host/a2ui/a2ui.bundle.js` already exists in the build context.

**Architecture:** Wrap the existing `pnpm canvas:a2ui:bundle || stub` RUN step in an `if [ ! -f … ]` shell guard. Cold builds (no bundle in context) get the existing fallback chain; warm builds (bundle pre-populated) skip the pnpm invocation entirely.

**Tech Stack:** Dockerfile, shell `test -f`.

**Spec:** `docs/superpowers/specs/2026-09-07-tier2-build-ci-optimization-design.md` §2.2.

**Branch:** `perf/a2ui-skip-if-present` (diverges from `main` after the spec branch is merged).

## Global Constraints

- The skip trigger is **file existence only**. There is NO input-hash check. If a future A2UI input changes but the output isn't regenerated, the build ships stale code. A2UI inputs change rarely.
- The fallback chain (`pnpm canvas:a2ui:bundle || create-stub`) is preserved verbatim inside the `if` branch.
- The `else` branch only emits an `echo` — it does not touch any files.
- The shape of the existing A2UI step is preserved; the diff is purely the `if`/`else`/`fi` wrapper.

---

## File Structure

| File | Responsibility |
|---|---|
| `Dockerfile` | Modify. Wrap the A2UI RUN step (lines 146-151) in a `test -f` guard. |

Total: 1 modified file, 6 net lines added.

---

### Task 1: Wrap the A2UI step in a `test -f` guard

**Files:**
- Modify: `Dockerfile:146-151`

**Interfaces:**
- Consumes: the existing `RUN pnpm canvas:a2ui:bundle || (stub-fallback)` block
- Produces: the same block guarded by `if [ ! -f extensions/canvas/src/host/a2ui/a2ui.bundle.js ]; then … else echo … ; fi`

- [ ] **Step 1: Read the exact lines to be modified**

Run: `sed -n '146,151p' Dockerfile`
Expected output (verify before editing):

```
RUN pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p extensions/canvas/src/host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
     echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
```

- [ ] **Step 2: Apply the edit**

The OLD string is the 6 lines above (the entire `RUN …` block).

The NEW string:

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

Apply via `Edit` tool with the old/new strings above. The diff is +6/-0 lines (the new `if`/`else`/`fi` wrapper and the `echo` line; the inner block is unchanged).

- [ ] **Step 3: Verify the file still parses as a Dockerfile (best-effort)**

Run: `grep -cE "^(RUN|FROM|COPY|ARG|ENV|LABEL|USER|WORKDIR|HEALTHCHECK|ENTRYPOINT|CMD|VOLUME|EXPOSE|ADD)" Dockerfile`
Expected: same count as before the edit + 0 (no new instructions, just an `if` wrapper inside the existing RUN). The shellcheck or hadolint tooling in CI will catch syntax errors.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "perf(docker): skip A2UI bundle step when output is already present"
```

---

### Task 2: Open the PR against `main`

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin perf/a2ui-skip-if-present
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head perf/a2ui-skip-if-present \
  --title "perf(docker): skip A2UI bundle step when output is already present" \
  --body-file <(cat <<'EOF'
## What
Wrap the existing A2UI bundle step in `Dockerfile:146-151` in a
`test -f` guard. Skip the `pnpm canvas:a2ui:bundle` invocation when
`extensions/canvas/src/host/a2ui/a2ui.bundle.js` already exists in
the build context.

## Why
Saves 1-3s per warm Docker build by avoiding the pnpm script's node
module resolution + TS file load + rollup-style bundle. Cold builds
(no bundle in context) keep the existing fallback chain verbatim.

## Risk
Low. The skip is a hard short-circuit on output file existence. If a
future A2UI input changes but the output isn't regenerated, the build
ships stale code. A2UI inputs change rarely.

## Verification
- [ ] Cold build: wall-time matches pre-PR baseline within 1-2s
- [ ] Warm build (bundle pre-populated): step emits "A2UI bundle already present, skipping"
- [ ] Existing install smoke + Docker release workflows pass
EOF
)
```

- [ ] **Step 3: Wait for CI green before merge**

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| Wrap in `if [ ! -f … ]` | T1 |
| Else branch echoes | T1 |
| Preserves the fallback chain verbatim | T1 (old/new strings) |
| File-exists trigger, no hash check | T1 (no hash logic in diff) |
| 1 modified file (`Dockerfile`) | T1 |
| 6 net lines added | T1 (+6/-0) |
| Open PR | T2 |

**2. Placeholder scan:** No placeholders. The old/new strings in T1 are exact.

**3. Type consistency:** N/A — this is a single Dockerfile shell change, no types or function signatures.
