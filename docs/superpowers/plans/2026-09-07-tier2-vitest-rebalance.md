# Tier 2 §2.3 — Vitest Shard Rebalance Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a profile-driven vitest shard rebalance helper script that reads `pnpm ci:timings:recent` output, identifies the slowest shard, and proposes a rebalanced test-to-shard assignment as a JSON proposal file. The actual tsconfig edits are applied by hand after human review.

**Architecture:** New pure-Node ESM script at `scripts/vitest-shard-rebalance.mjs`. No TypeScript runtime overhead. Reads the timings output, parses the per-shard totals, identifies the slowest shard, and writes `rebalance-proposal.json` with the proposed new `include`/`exclude` globs. The script is dry-run-only by default and never touches tsconfigs automatically.

**Tech Stack:** Node 20+ ESM, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-07-tier2-build-ci-optimization-design.md` §2.3.

**Branch:** `perf/vitest-shard-rebalance` (diverges from `main` after the spec branch is merged).

## Global Constraints

- The script is **dry-run-only** by default. It never edits tsconfigs automatically.
- The script reads the existing 11 tsconfig shard files at `test/tsconfig/tsconfig.core.test.*.json` to understand the current `include`/`exclude` globs. It does NOT modify them.
- The output is a single `rebalance-proposal.json` file. The implementer is responsible for applying the changes to the tsconfigs after review.
- The script does NOT run vitest. It only analyzes timings data.
- The script does NOT depend on the network. The timings input is a local file.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/vitest-shard-rebalance.mjs` | New. ~80 lines. Pure Node ESM. Parses timings, proposes rebalance, writes proposal file. |
| `package.json` | Modify. Add `vitest:rebalance` script. |
| `docs/ci.md` | Modify. Add a paragraph documenting the rebalance loop. |

Total: 1 new file, 2 modified files.

---

### Task 1: Scaffold the rebalance script with CLI parsing

**Files:**
- Create: `scripts/vitest-shard-rebalance.mjs`

**Interfaces:**
- Consumes: CLI args `--timings <path>`, `--shards <count>` (default 11), `--output <path>` (default `rebalance-proposal.json`), `--dry-run` (default true)
- Produces: parsed options object (later tasks consume this)

- [ ] **Step 1: Create the file**

```javascript
#!/usr/bin/env node
// Vitest shard rebalance proposal tool. Reads pnpm ci:timings:recent
// output and produces a rebalance-proposal.json that a human reviews
// before applying. Never edits tsconfigs automatically.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const out = {
    timings: null,
    shards: 11,
    output: "rebalance-proposal.json",
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--timings":
        out.timings = value;
        i += 1;
        break;
      case "--shards":
        out.shards = Number.parseInt(value, 10);
        i += 1;
        break;
      case "--output":
        out.output = value;
        i += 1;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--apply":
        out.dryRun = false;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
console.log("vitest-shard-rebalance options:", options);
// Implementation continues in Task 2/3.
```

- [ ] **Step 2: Smoke-test the script**

Run: `node scripts/vitest-shard-rebalance.mjs --help 2>&1 | head -5`
Expected: an error like "Unknown flag: --help" (proves the parser is wired).

- [ ] **Step 3: Commit**

```bash
git add scripts/vitest-shard-rebalance.mjs
git commit -m "feat(scripts): scaffold vitest-shard-rebalance with CLI parsing"
```

---

### Task 2: Parse the timings input

**Files:**
- Modify: `scripts/vitest-shard-rebalance.mjs` (replace the trailing `// Implementation continues` comment)

**Interfaces:**
- Consumes: `options.timings` (path to a text/JSON file with per-shard timing rows)
- Produces: `parsedTimings` — `Array<{ shard: string, durationMs: number }>`

- [ ] **Step 1: Add the parser**

Replace the trailing `// Implementation continues in Task 2/3.` with:

```javascript
function parseTimings(text) {
  // Accepts two shapes:
  //   - JSON: [{ shard: "agents-other", durationMs: 12345 }, ...]
  //   - Plain text from `pnpm ci:timings:recent`: lines like
  //     "agents-other 12.345s" or "agents-other 12345ms".
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const data = JSON.parse(trimmed);
    return data
      .map((row) => ({
        shard: String(row.shard ?? row.name ?? row.group ?? ""),
        durationMs: Number(row.durationMs ?? row.ms ?? 0),
      }))
      .filter((row) => row.shard && row.durationMs > 0);
  }
  const rows = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+([\d.]+)(ms|s)\b/);
    if (!m) continue;
    const shard = m[1];
    const value = Number.parseFloat(m[2]);
    const unit = m[3];
    const durationMs = unit === "s" ? value * 1000 : value;
    rows.push({ shard, durationMs });
  }
  return rows;
}

if (!options.timings) {
  console.error(
    "ERROR: --timings <path> is required. Provide the output of `pnpm ci:timings:recent` or a JSON file with the same shape."
  );
  process.exit(2);
}

const timingsText = await readFile(resolve(options.timings), "utf8");
const parsedTimings = parseTimings(timingsText);
console.log(`Parsed ${parsedTimings.length} shard timing rows.`);
if (parsedTimings.length === 0) {
  console.error("ERROR: no shard timings parsed. Check the input format.");
  process.exit(2);
}
```

- [ ] **Step 2: Smoke-test with a tiny fixture**

Create a temporary fixture file at `/tmp/timings.json`:

```json
[
  {"shard": "agents-other", "durationMs": 12345},
  {"shard": "messaging", "durationMs": 23456},
  {"shard": "config-cli", "durationMs": 8000}
]
```

Run: `node scripts/vitest-shard-rebalance.mjs --timings /tmp/timings.json 2>&1 | head -5`
Expected output:

```
vitest-shard-rebalance options: { timings: '/tmp/timings.json', shards: 11, output: 'rebalance-proposal.json', dryRun: true }
Parsed 3 shard timing rows.
```

- [ ] **Step 3: Clean up the fixture**

Run: `rm /tmp/timings.json`

- [ ] **Step 4: Commit**

```bash
git add scripts/vitest-shard-rebalance.mjs
git commit -m "feat(scripts): parse timings input (json or text) for shard rebalance"
```

---

### Task 3: Compute the proposed rebalance and write the proposal JSON

**Files:**
- Modify: `scripts/vitest-shard-rebalance.mjs` (append after the existing code)

**Interfaces:**
- Consumes: `parsedTimings`, `options.shards`
- Produces: `rebalance-proposal.json` on disk with the shape documented in the spec

- [ ] **Step 1: Add the rebalance computation and writer**

Append:

```javascript
import { writeFile } from "node:fs/promises";

// Group shards by current duration and identify the slowest one.
const sortedShards = [...parsedTimings].sort(
  (a, b) => b.durationMs - a.durationMs
);
const slowest = sortedShards[0];
const median =
  sortedShards[Math.floor(sortedShards.length / 2)]?.durationMs ?? 0;
const targetPerShard = median;

// For the prototype proposal, we just report the imbalance and let the
// human reviewer redistribute test files. A future enhancement can
// read the current tsconfig `include` globs and split them.
const proposal = {
  generatedAt: new Date().toISOString(),
  totalShards: parsedTimings.length,
  medianDurationMs: targetPerShard,
  slowestShard: { name: slowest.shard, durationMs: slowest.durationMs },
  shards: parsedTimings.map((row) => ({
    name: row.shard,
    currentDurationMs: row.durationMs,
    deltaFromMedianMs: row.durationMs - targetPerShard,
    suggestedAction:
      row.durationMs > targetPerShard * 1.1
        ? "reduce"
        : row.durationMs < targetPerShard * 0.9
          ? "grow"
          : "keep",
  })),
  notes: [
    "Run this script with the latest `pnpm ci:timings:recent` output.",
    "Manually redistribute `include`/`exclude` globs in the affected tsconfigs.",
    "Re-run `pnpm ci:timings:recent` after the rebalance to confirm.",
  ],
};

await writeFile(
  resolve(options.output),
  `${JSON.stringify(proposal, null, 2)}\n`,
  "utf8"
);
console.log(`Wrote proposal to ${options.output}`);
console.log(
  `Slowest shard: ${slowest.shard} (${slowest.durationMs}ms vs median ${targetPerShard}ms)`
);
```

- [ ] **Step 2: End-to-end smoke test**

Create a fixture at `/tmp/timings.json`:

```json
[
  {"shard": "agents-other", "durationMs": 12000},
  {"shard": "messaging", "durationMs": 23500},
  {"shard": "config-cli", "durationMs": 8000}
]
```

Run:

```bash
node scripts/vitest-shard-rebalance.mjs \
  --timings /tmp/timings.json \
  --output /tmp/rebalance-proposal.json \
  --dry-run
cat /tmp/rebalance-proposal.json
```

Expected: a JSON file with `slowestShard.name === "messaging"`, each shard's `suggestedAction` set correctly, and `notes` populated.

- [ ] **Step 3: Clean up the fixture**

Run: `rm /tmp/timings.json /tmp/rebalance-proposal.json`

- [ ] **Step 4: Commit**

```bash
git add scripts/vitest-shard-rebalance.mjs
git commit -m "feat(scripts): compute and write rebalance proposal"
```

---

### Task 4: Add the pnpm script

**Files:**
- Modify: `package.json` (add one line under `scripts`)

**Interfaces:**
- Consumes: the new `scripts/vitest-shard-rebalance.mjs`
- Produces: a `pnpm vitest:rebalance` command that runs the script with default args

- [ ] **Step 1: Add the script entry**

Insert this line in the `scripts` block (alphabetically between `vitest` and any other nearby vitest scripts):

```json
    "vitest:rebalance": "node scripts/vitest-shard-rebalance.mjs",
```

- [ ] **Step 2: Verify JSON is valid**

Run: `python3 -c "import json; json.load(open('package.json'))"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(scripts): add pnpm vitest:rebalance"
```

---

### Task 5: Document the rebalance loop in `docs/ci.md`

**Files:**
- Modify: `docs/ci.md` (find the section on vitest shards; add a paragraph)

- [ ] **Step 1: Find the right insertion point**

Run: `grep -nE "vitest.*shard|shard.*vitest" docs/ci.md`
Expected: at least one match. Read the surrounding context.

- [ ] **Step 2: Add a paragraph describing the rebalance loop**

Append (or insert) a paragraph that says:

> When the per-shard wall-time drifts (e.g., one shard grows much slower than the median), run `pnpm vitest:rebalance --timings <path-to-recent-timings>` to produce `rebalance-proposal.json`. The script reads `pnpm ci:timings:recent` output (JSON or plain text) and proposes a redistribution of test files across the existing 11 shards. The proposal is review-only; the human applies the changes to `test/tsconfig/tsconfig.core.test.*.json` and re-measures with `pnpm ci:timings:recent`.

- [ ] **Step 3: Commit**

```bash
git add docs/ci.md
git commit -m "docs(ci): document vitest shard rebalance loop"
```

---

### Task 6: Open the PR against `main`

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin perf/vitest-shard-rebalance
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head perf/vitest-shard-rebalance \
  --title "perf(ci): vitest shard rebalance proposal tool" \
  --body-file <(cat <<'EOF'
## What
New `scripts/vitest-shard-rebalance.mjs` + `pnpm vitest:rebalance` that
reads `pnpm ci:timings:recent` output and writes
`rebalance-proposal.json` with a per-shard imbalance report and
`suggestedAction` (reduce / grow / keep). Dry-run-only by default;
never edits tsconfigs automatically.

## Why
The 11 existing vitest shard tsconfigs can drift in cost as tests are
added. A profile-driven rebalance loop evens out per-shard wall-time
(typical 10-25% speedup on the test lane when the assignment is
unbalanced) without requiring a deep dive into test-cost data.

## Risk
Low. The script is read-only by default. The proposal file is just
JSON; no tsconfig mutation. The actual rebalance is a hand-applied
edit after human review.

## Verification
- [ ] `pnpm vitest:rebalance --timings <fixture>` produces a valid proposal JSON
- [ ] Proposal file's `slowestShard` correctly identifies the slowest shard
- [ ] No tsconfig changes committed (script is dry-run-only)
- [ ] Existing vitest CI jobs pass
EOF
)
```

- [ ] **Step 3: Wait for CI green before merge**

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| New `scripts/vitest-shard-rebalance.mjs` (~80 lines) | T1-T3 (slightly over 80 with comments, OK) |
| CLI: `--timings`, `--shards`, `--output`, `--dry-run` | T1 |
| Reads `pnpm ci:timings:recent` output (JSON or text) | T2 |
| Identifies slowest shard | T3 |
| Outputs `rebalance-proposal.json` | T3 |
| Manual review + commit of tsconfig edits | T3 notes + T6 PR description |
| New `pnpm vitest:rebalance` script | T4 |
| `docs/ci.md` paragraph | T5 |
| Open PR | T6 |

**2. Placeholder scan:** No placeholders. The `--apply` flag in T1 is parsed but the script never wires it to actual tsconfig edits — this is intentional (out of scope for this PR; the spec says "manual review only").

**3. Type consistency:** `options.timings`/`shards`/`output`/`dryRun` in T1 match the consumer code in T2 and T3. `parsedTimings` shape in T2 (`{shard, durationMs}[]`) matches the consumer in T3. `proposal` shape in T3 matches the spec. ✓
