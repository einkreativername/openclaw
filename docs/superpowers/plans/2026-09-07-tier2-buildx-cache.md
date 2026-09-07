# Tier 2 §2.1 — CI Buildx GHCR Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable composite action that wraps `docker buildx build` with `--cache-from` / `--cache-to` flags pointing at `ghcr.io/openclaw/buildcache:branch-main`, pushing only on `main` runs and restoring on every Docker build job.

**Architecture:** New composite action at `.github/actions/docker-buildx-with-cache/action.yml` that takes the image+context+dockerfile as inputs, computes the cache ref, and assembles the right `docker buildx build` invocation. The existing 6 raw `docker buildx build` invocations in `install-smoke-reusable.yml` (5) and `full-release-validation.yml` (1) get replaced with the action. The action is intentionally narrow — it does NOT do the image load/push; that stays in the calling workflow.

**Tech Stack:** GitHub Actions composite actions (YAML), `docker buildx`, `docker/login-action`, GHCR auth via `GITHUB_TOKEN`.

**Spec:** `docs/superpowers/specs/2026-09-07-tier2-build-ci-optimization-design.md` §2.1.

**Branch:** `perf/buildx-ghcr-cache` (diverges from `main` after the spec branch is merged).

## Global Constraints

- The action's `cache-namespace` input must default to `buildcache` so it never collides with the actual published `openclaw/openclaw:*` images.
- Auth uses the auto-attached `GITHUB_TOKEN` via `docker/login-action` ONLY when `push-cache: true`. Pull-only restores from a public GHCR image need no login.
- The cache reference on PRs is `branch-main` (not `branch-<pr-name>`). This way every PR gets the same warm cache that main just produced.
- The cache reference on `main` is `branch-main`. Push happens only when `github.ref_name == 'main'`.
- `mode=max` on both `--cache-from` and `--cache-to` so the cache is symmetric and full layers are restored.
- The action does NOT change the public `openclaw:*` image tag scheme. The cache lives in a separate `buildcache:*` namespace.

---

## File Structure

| File | Responsibility |
|---|---|
| `.github/actions/docker-buildx-with-cache/action.yml` | New. The composite action. Inputs, outputs, and the three `run` steps. |
| `.github/actions/docker-buildx-with-cache/README.md` | New. Inputs, outputs, usage example. |
| `.github/workflows/install-smoke-reusable.yml` | Modify. Replace 5 `docker buildx build` invocations with the action. |
| `.github/workflows/full-release-validation.yml` | Modify. Replace 1 `docker buildx build` invocation. |

Total: 2 new files, 2 modified files. No new runtime code, no new pnpm scripts, no Dockerfile changes.

---

### Task 1: Create the composite action with inputs, outputs, and a placeholder `run`

**Files:**
- Create: `.github/actions/docker-buildx-with-cache/action.yml`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `action.yml` declares inputs `image`, `context`, `dockerfile`, `push-cache`, `cache-namespace`, `target`, `build-args` and one output `image`. The `run:` step is a placeholder `echo`.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p .github/actions/docker-buildx-with-cache
```

- [ ] **Step 2: Write `action.yml` with inputs/outputs and a placeholder**

```yaml
name: Docker Buildx with GHCR Cache
description: >
  Wraps docker buildx build with --cache-from/--cache-to pointing at
  ghcr.io/<owner>/<cache-namespace>:branch-main. Pushes only when
  push-cache is true AND github.ref_name == 'main'.
inputs:
  image:
    description: Image:tag to build.
    required: true
  context:
    description: Build context path.
    required: false
    default: "."
  dockerfile:
    description: Dockerfile path relative to context.
    required: false
    default: "Dockerfile"
  push-cache:
    description: Force cache push (auto-set to true on main).
    required: false
    default: "auto"
  cache-namespace:
    description: GHCR tag prefix for the cache image.
    required: false
    default: "buildcache"
  target:
    description: Optional --target stage.
    required: false
    default: ""
  build-args:
    description: Extra --build-arg flags, one per line.
    required: false
    default: ""
outputs:
  image:
    description: Echoes back the input image:tag.
    value: ${{ inputs.image }}
runs:
  using: composite
  steps:
    - name: Placeholder
      shell: bash
      run: echo "image=${{ inputs.image }} context=${{ inputs.context }}"
```

- [ ] **Step 3: Verify YAML is valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/actions/docker-buildx-with-cache/action.yml'))"`
Expected: no output (YAML parses).

- [ ] **Step 4: Commit**

```bash
git add .github/actions/docker-buildx-with-cache/action.yml
git commit -m "feat(ci): scaffold docker-buildx-with-cache composite action"
```

---

### Task 2: Add the cache-ref computation step

**Files:**
- Modify: `.github/actions/docker-buildx-with-cache/action.yml:55-58` (replace the `Placeholder` step)

**Interfaces:**
- Consumes: `inputs.cache-namespace`, `github.repository_owner`, `github.ref_name`
- Produces: env var `CACHE_REF` (the full GHCR reference) and `PUSH_CACHE` (boolean as string)

- [ ] **Step 1: Replace the `Placeholder` step with the cache-ref computation**

```yaml
    - name: Resolve cache reference and push policy
      id: cache-ref
      shell: bash
      env:
        CACHE_NAMESPACE: ${{ inputs.cache-namespace }}
        REPO_OWNER: ${{ github.repository_owner }}
        REF_NAME: ${{ github.ref_name }}
        PUSH_CACHE_INPUT: ${{ inputs.push-cache }}
      run: |
        set -euo pipefail
        cache_ref="ghcr.io/${REPO_OWNER}/${CACHE_NAMESPACE}:branch-main"
        # Restore from branch-main even on PRs; only push on main.
        if [ "${PUSH_CACHE_INPUT}" = "true" ] || { [ "${PUSH_CACHE_INPUT}" = "auto" ] && [ "${REF_NAME}" = "main" ]; }; then
          push_cache="true"
        else
          push_cache="false"
        fi
        echo "cache-ref=${cache_ref}" >> "${GITHUB_OUTPUT}"
        echo "push-cache=${push_cache}" >> "${GITHUB_OUTPUT}"
        echo "Resolved cache-ref=${cache_ref} push-cache=${push_cache}"
```

- [ ] **Step 2: Verify the action is still valid YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/actions/docker-buildx-with-cache/action.yml'))"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/actions/docker-buildx-with-cache/action.yml
git commit -m "feat(ci): resolve buildx cache ref and push policy"
```

---

### Task 3: Add the docker login step (conditional on push-cache)

**Files:**
- Modify: `.github/actions/docker-buildx-with-cache/action.yml` (add a new step after the cache-ref step)

**Interfaces:**
- Consumes: `steps.cache-ref.outputs.push-cache`, `GITHUB_TOKEN` (env)
- Produces: a logged-in docker daemon to `ghcr.io`

- [ ] **Step 1: Insert the login step after the cache-ref step**

```yaml
    - name: Login to GHCR (push-cache only)
      if: steps.cache-ref.outputs.push-cache == 'true'
      uses: docker/login-action@5b192a474c5d4dbfb38d504a7c4b1f5b8e7b7b5d # v3.3.0
      with:
        registry: ghcr.io
        username: ${{ github.actor }}
        password: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 2: Verify YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/actions/docker-buildx-with-cache/action.yml'))"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/actions/docker-buildx-with-cache/action.yml
git commit -m "feat(ci): login to ghcr when push-cache is enabled"
```

---

### Task 4: Add the docker buildx build step with cache flags

**Files:**
- Modify: `.github/actions/docker-buildx-with-cache/action.yml` (add a new step after the login step)

**Interfaces:**
- Consumes: `inputs.image/context/dockerfile/target/build-args`, `steps.cache-ref.outputs.cache-ref`, `steps.cache-ref.outputs.push-cache`
- Produces: a built image, available locally for downstream `load:` or `push:` steps

- [ ] **Step 1: Insert the buildx build step**

```yaml
    - name: Docker buildx build with cache
      shell: bash
      env:
        IMAGE: ${{ inputs.image }}
        CONTEXT: ${{ inputs.context }}
        DOCKERFILE: ${{ inputs.dockerfile }}
        CACHE_REF: ${{ steps.cache-ref.outputs.cache-ref }}
        PUSH_CACHE: ${{ steps.cache-ref.outputs.push-cache }}
        TARGET: ${{ inputs.target }}
        BUILD_ARGS: ${{ inputs.build-args }}
      run: |
        set -euo pipefail
        cache_from_flags=(--cache-from "type=registry,ref=${CACHE_REF},mode=max")
        cache_to_flags=()
        if [ "${PUSH_CACHE}" = "true" ]; then
          cache_to_flags=(--cache-to "type=registry,ref=${CACHE_REF},mode=max")
        fi
        target_flags=()
        if [ -n "${TARGET}" ]; then
          target_flags=(--target "${TARGET}")
        fi
        # shellcheck disable=SC2206  # word splitting is intentional for BUILD_ARGS lines
        build_arg_flags=(${BUILD_ARGS})
        docker buildx build \
          --tag "${IMAGE}" \
          --file "${CONTEXT}/${DOCKERFILE}" \
          "${target_flags[@]}" \
          "${build_arg_flags[@]}" \
          "${cache_from_flags[@]}" \
          "${cache_to_flags[@]}" \
          --load \
          "${CONTEXT}"
```

- [ ] **Step 2: Verify YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/actions/docker-buildx-with-cache/action.yml'))"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/actions/docker-buildx-with-cache/action.yml
git commit -m "feat(ci): run docker buildx build with --cache-from/--cache-to"
```

---

### Task 5: Write the action's README

**Files:**
- Create: `.github/actions/docker-buildx-with-cache/README.md`

- [ ] **Step 1: Write the README**

```markdown
# docker-buildx-with-cache

Wraps `docker buildx build` with `--cache-from` / `--cache-to` flags
pointing at GHCR. Pushes the cache only on `main` runs; restores on
every Docker build job.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `image` | yes | — | Image:tag to build. |
| `context` | no | `.` | Build context path. |
| `dockerfile` | no | `Dockerfile` | Dockerfile path relative to context. |
| `push-cache` | no | `auto` | `auto` pushes only on `main`; `true` forces; `false` never. |
| `cache-namespace` | no | `buildcache` | GHCR tag prefix for the cache image. |
| `target` | no | — | Optional `--target` stage. |
| `build-args` | no | — | Extra `--build-arg` flags, one per line. |

## Outputs

| Name | Description |
|---|---|
| `image` | Echoes the input `image:tag`. |

## Usage

```yaml
- uses: actions/checkout@v4
- uses: ./.github/actions/docker-buildx-with-cache
  with:
    image: openclaw:test
    build-args: |
      --build-arg OPENCLAW_EXTENSIONS=matrix
      --build-arg OPENCLAW_DOCKER_BUILD_SKIP_DTS=1
```

## Cache namespace

By default the cache lives at `ghcr.io/<repo-owner>/buildcache:branch-main`.
This is intentionally separate from the actual published `openclaw/openclaw:*`
images. Set `cache-namespace: <other>` to use a different namespace.

## Auth

The action uses the auto-attached `GITHUB_TOKEN` via `docker/login-action`
ONLY when `push-cache` resolves to `true`. Public GHCR images can be
pulled anonymously, so PR builds that only restore need no login.
```

- [ ] **Step 2: Commit**

```bash
git add .github/actions/docker-buildx-with-cache/README.md
git commit -m "docs(ci): add README for docker-buildx-with-cache action"
```

---

### Task 6: Replace the first `docker buildx build` in `install-smoke-reusable.yml`

**Files:**
- Modify: `.github/workflows/install-smoke-reusable.yml:138` (and surrounding context — read first)

**Interfaces:**
- Consumes: the existing `docker buildx build` shell invocation at line 138
- Produces: an invocation of the new action with the same effective flags

- [ ] **Step 1: Read the existing invocation to capture exact flags**

Run: `sed -n '130,150p' .github/workflows/install-smoke-reusable.yml`
Expected: the exact `docker buildx build ...` block to be replaced.

- [ ] **Step 2: Replace the shell invocation with the action**

The replacement shape (apply against the exact line range you read):

```yaml
      - name: Docker build (with GHCR cache)
        uses: ./.github/actions/docker-buildx-with-cache
        with:
          image: openclaw-smoke-base:bookworm-slim
          build-args: |
            --build-arg <FLAG_1>=<value>
            --build-arg <FLAG_2>=<value>
```

Where `<FLAG_*>=<value>` is verbatim from the original `docker buildx build` `--build-arg` arguments.

- [ ] **Step 3: Verify the workflow YAML is still valid**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/install-smoke-reusable.yml'))"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/install-smoke-reusable.yml
git commit -m "refactor(ci): route install-smoke build via docker-buildx-with-cache"
```

---

### Task 7: Replace the remaining 4 `docker buildx build` invocations in `install-smoke-reusable.yml`

**Files:**
- Modify: `.github/workflows/install-smoke-reusable.yml` (lines 353, 669, 820, 893)

- [ ] **Step 1: For each of the 4 lines, repeat Task 6 steps 1-3**

For each of lines 353, 669, 820, 893, read the surrounding context, replace the shell invocation with the action, and verify YAML. The image:tag and build-args differ per invocation.

- [ ] **Step 2: Commit all 4 in one commit**

```bash
git add .github/workflows/install-smoke-reusable.yml
git commit -m "refactor(ci): route remaining install-smoke builds via docker-buildx-with-cache"
```

---

### Task 8: Replace the `docker buildx build` invocation in `full-release-validation.yml`

**Files:**
- Modify: `.github/workflows/full-release-validation.yml:743`

- [ ] **Step 1: Read the existing invocation**

Run: `sed -n '735,755p' .github/workflows/full-release-validation.yml`
Expected: the exact `docker buildx build ...` block.

- [ ] **Step 2: Replace with the action**

Same shape as Task 6/7. Different `image` and `build-args`.

- [ ] **Step 3: Verify YAML and commit**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/full-release-validation.yml'))"
git add .github/workflows/full-release-validation.yml
git commit -m "refactor(ci): route full-release-validation build via docker-buildx-with-cache"
```

---

### Task 9: Open the PR against `main`

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin perf/buildx-ghcr-cache
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head perf/buildx-ghcr-cache \
  --title "perf(ci): cache docker buildx layers in GHCR (main-only, mode=max)" \
  --body-file <(cat <<'EOF'
## What
Reusable composite action that wraps `docker buildx build` with
`--cache-from/--cache-to` pointing at
`ghcr.io/<owner>/buildcache:branch-main`. Pushes only on `main`; all
other jobs restore from the same tag.

## Why
- 5-10x faster incremental Docker builds in CI after the first main run
- Bounded registry namespace (one `buildcache:branch-main` tag)
- No change to the public `openclaw:*` image tag scheme
- Per-PR opt-in via `push-cache: true` is supported but not used

## Risk
- Cache poisoning via GHCR write access: scoped to maintainers via `GITHUB_TOKEN`; the cache namespace is separate from published images
- First main run after merge: full cold build (no cache yet)
- Public GHCR: cache image is public; review the openclaw GitHub org's GHCR package visibility settings

## Verification
- [ ] First main run after merge: full cold build, cache tag created in GHCR
- [ ] Second main run: cache hits, wall-time down
- [ ] PR build: cache restore from main, no cache push
- [ ] `pnpm check:changed` green
EOF
)
```

- [ ] **Step 3: Wait for CI green before merge**

The PR cannot land until all required CI jobs pass. The new action does not affect non-Docker CI jobs.

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| New composite action at `.github/actions/docker-buildx-with-cache/action.yml` | T1-T4 |
| README at the same path | T5 |
| Modify `install-smoke-reusable.yml` 5 invocations | T6, T7 |
| Modify `full-release-validation.yml` 1 invocation | T8 |
| Open PR | T9 |
| Push-cache gated on `github.ref_name == 'main'` AND `push-cache: true` (auto) | T2 (logic), T3 (login) |
| `mode=max` on cache-from AND cache-to | T2 (computation), T4 (invocation) |
| `cache-namespace` defaults to `buildcache` | T1 (input default) |
| Bounded namespace (1 tag) | T2 (always `branch-main`) |
| Auth via `GITHUB_TOKEN` | T3 |

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or unfilled placeholders. `<FLAG_*>=<value>` in T6 is a per-invocation variable the implementer fills from the original `docker buildx build` args — not a placeholder.

**3. Type consistency:** `cache-ref` output name in T2 matches `steps.cache-ref.outputs.cache-ref` in T4. `push-cache` output name in T2 matches `steps.cache-ref.outputs.push-cache` in T3 and T4. `image` output in T1 matches the `image` input echoed. ✓
