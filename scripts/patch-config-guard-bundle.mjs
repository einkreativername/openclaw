#!/usr/bin/env node
/**
 * Patch the built config-guard bundle inside the image.
 *
 * Why this exists:
 *   The "tool" and "tools" roots are reserved so a plugin cannot claim the
 *   name. They have no implementation, so every invocation can only answer
 *   "unknown command". The config guard still ran the startup preflight for
 *   them, and that preflight discovers plugin metadata, which builds a full
 *   plugin source capture (native binaries included) for a command that can
 *   only report a mistake. The capture left a staging token behind and the
 *   cleanup then spun on it (one core pegged, ~600 MB RSS, a multi-hundred-MB
 *   capture written per attempt).
 *
 * What this patch changes in the built bundle:
 *   1. the startup preflight is skipped for the reserved "tool"/"tools" roots,
 *      so no plugin metadata discovery and no plugin source capture happens.
 *   2. the config snapshot for those roots uses core-only plugin validation,
 *      which is the same treatment read-only diagnostics already get.
 *
 * The snapshot patch belongs on the *core-only* branch of the ternary chain,
 * because that branch is the one that disables plugin metadata discovery.
 * An earlier revision appended the roots to the plain `{ observe: false }`
 * branch, which only suppresses config-health recording and still triggers the
 * capture. This script repairs that shape as well.
 *
 * The patch is idempotent, and it fails loudly on a bundle shape it does not
 * understand: a silent no-op would ship an image whose reserved roots still
 * build captures. Every patched file is re-read and re-verified after the
 * write, so a partially applied patch cannot be reported as "patched".
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Directory that holds the built config-guard bundles.
 *
 * The default is the image path. The override exists so the patch can be
 * exercised against a bundle copy outside the image (local regression test);
 * it is never set in the shipped build.
 */
const DIST = process.env.CONFIG_GUARD_BUNDLE_DIR ?? "/app/dist";
const REPORT = process.env.CONFIG_GUARD_PATCH_REPORT ?? "/tmp/config-guard-patch.json";

const PREFLIGHT_OLD = 'commandName !== "sessions" && !isRestartController';
const PREFLIGHT_NEW =
  'commandName !== "sessions" && commandName !== "tool" && commandName !== "tools" && !isRestartController';

/**
 * Longest term first: "tools" must be recognised before "tool", so a term is
 * never matched as a prefix of the other one.
 */
const TOOL_TERMS = ['commandName === "tools"', 'commandName === "tool"'];

/**
 * Matches the whole snapshot statement:
 *   const configSnapshotOptions = <condA> ? <coreOnly> : <condB> ? <observe> : <tail>;
 * The two object literals are captured verbatim so their original formatting
 * (the core-only object is multi-line in the shipped bundle) survives.
 */
const SNAPSHOT_RE =
  /const configSnapshotOptions = (?<condA>[\s\S]*?) \? (?<coreOnly>\{[\s\S]*?\}) : (?<condB>[\s\S]*?) \? (?<observe>\{[\s\S]*?\}) : (?<tail>[^;]*);/;

/**
 * Splits a condition into its top-level `||` operands.
 *
 * A string-literal aware scan is required: the reserved-root terms contain a
 * quoted string, and a naive split would break on operators inside strings.
 * Depth tracking keeps operators inside parentheses, brackets and braces
 * together with their operand.
 */
function splitTopLevelOr(condition) {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < condition.length; index += 1) {
    const char = condition[index];
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (depth === 0 && char === "|" && condition[index + 1] === "|") {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * True only for an operand that is exactly a reserved-root term. A term that
 * is merely a prefix of an operand (for example `isRestartControllers`) is not
 * a reserved root and must never be stripped.
 */
function isToolTerm(operand) {
  return TOOL_TERMS.includes(operand.trim());
}

/**
 * Removes the reserved-root operands from a condition, together with the `||`
 * separators that introduced them. Operands are matched exactly, so a
 * condition can never lose more than the reserved roots themselves.
 */
function stripToolTerms(condition) {
  return splitTopLevelOr(condition)
    .filter((operand) => !isToolTerm(operand))
    .join(" || ");
}

function hasToolTerm(condition) {
  return splitTopLevelOr(condition).some((operand) => isToolTerm(operand));
}

/**
 * Removes string literals so that their contents cannot be mistaken for
 * identifiers.
 */
function stripStringLiterals(source) {
  let result = "";
  let quote = null;
  let escaped = false;
  for (const char of source) {
    if (quote) {
      if (escaped) {
        escaped = false;
        result += " ";
        continue;
      }
      if (char === "\\") {
        escaped = true;
        result += " ";
        continue;
      }
      result += char === quote ? " " : " ";
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * All identifiers referenced by a source fragment.
 */
function identifiersOf(source) {
  const withoutLiterals = stripStringLiterals(source);
  const found = new Set();
  for (const match of withoutLiterals.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    found.add(match);
  }
  return found;
}

/**
 * Compiles a statement to prove it is syntactically valid JavaScript. The
 * statement is never executed, so unresolved references are irrelevant here.
 */
function assertStatementSyntax(statement, label) {
  try {
    // eslint-disable-next-line no-new-func -- compile-only syntax check
    new Function(statement);
  } catch (error) {
    throw new Error(
      `config-guard bundle: ${label} is not valid JavaScript: ${error?.message ?? String(error)}`,
    );
  }
}

function findTargets() {
  if (!fs.existsSync(DIST)) {
    throw new Error(`Config-guard bundle directory ${DIST} does not exist`);
  }
  const targets = fs
    .readdirSync(DIST)
    .filter((name) => name.startsWith("config-guard-") && name.endsWith(".mjs"))
    .map((name) => path.join(DIST, name));
  if (targets.length === 0) {
    throw new Error(`No config-guard bundle found in ${DIST}`);
  }
  return targets;
}

/**
 * Parses the snapshot statement and reports the conditions it found.
 */
function parseSnapshot(source) {
  const match = source.match(SNAPSHOT_RE);
  if (!match) {
    throw new Error(
      "config-guard bundle: could not locate the configSnapshotOptions statement; " +
        "the bundle shape changed and the patch cannot be verified",
    );
  }
  const { condA, coreOnly, condB, observe, tail } = match.groups;
  if (!coreOnly.includes('pluginValidation: "core-only"')) {
    throw new Error(
      'config-guard bundle: the core-only branch does not carry pluginValidation: "core-only"; ' +
        "the patch cannot be verified",
    );
  }
  if (!observe.includes("observe: false")) {
    throw new Error(
      "config-guard bundle: the observe branch does not carry observe: false; " +
        "the patch cannot be verified",
    );
  }
  if (!condA.includes("params.validateConfigOnly")) {
    throw new Error(
      "config-guard bundle: the first snapshot condition does not reference params.validateConfigOnly; " +
        "the patch cannot be verified",
    );
  }
  return { statement: match[0], condA, coreOnly, condB, observe, tail };
}

/**
 * Rewrites the snapshot statement so the reserved roots use core-only plugin
 * validation. Returns the patched statement plus the changes that were made.
 */
function patchSnapshotStatement(parsed) {
  const { statement: original, condA, coreOnly, condB, observe, tail } = parsed;

  // Whether the reserved roots still sit on the observe-only branch has to be
  // decided on the *original* condition: the stripped condition never carries
  // a reserved root by construction, so asking the stripped value would
  // always answer "no" and hide a half-applied patch.
  const movedFromObserveBranch = hasToolTerm(condB);
  const nextCondB = stripToolTerms(condB);
  const alreadyOnCoreOnlyBranch = hasToolTerm(condA);

  // Stripping must never invent or mangle an identifier. If a term were
  // matched as a prefix of a longer operand, the result would reference an
  // identifier the original condition never mentioned.
  const originalIdentifiers = identifiersOf(condB);
  for (const identifier of identifiersOf(nextCondB)) {
    if (!originalIdentifiers.has(identifier)) {
      throw new Error(
        `config-guard bundle: stripping the reserved roots introduced the identifier "${identifier}"; ` +
          "the condition cannot be rewritten safely",
      );
    }
  }

  // "already patched" means the reserved roots sit on the core-only branch AND
  // the observe-only branch is free of them. A hybrid shape (roots already
  // moved but still lingering on the observe branch) still needs a rewrite.
  if (alreadyOnCoreOnlyBranch && !movedFromObserveBranch) {
    return { original, statement: original, changes: [], status: "already-patched" };
  }

  const nextCondA = alreadyOnCoreOnlyBranch
    ? condA
    : `${condA.trim()} || ${TOOL_TERMS.join(" || ")}`;

  const statement = `const configSnapshotOptions = ${nextCondA} ? ${coreOnly} : ${nextCondB} ? ${observe} : ${tail};`;
  assertStatementSyntax(statement, "the patched configSnapshotOptions statement");
  const changes = [];
  if (movedFromObserveBranch) {
    changes.push("move-reserved-roots-to-core-only-branch");
  }
  if (!alreadyOnCoreOnlyBranch) {
    changes.push("core-only-plugin-validation");
  }
  return { original, statement, changes, status: "patched" };
}

/**
 * Re-reads the written file and proves that the intended shape is really in
 * place. A partially applied patch must not be reported as "patched".
 */
function verifyFile(file, expectPreflightSkipped, options = {}) {
  const source = fs.readFileSync(file, "utf8");
  const parsed = parseSnapshot(source);

  if (hasToolTerm(parsed.condB)) {
    throw new Error(
      `config-guard bundle: ${file} still references the reserved roots on the observe-only branch`,
    );
  }
  // The reserved roots must be complete operands of the core-only condition.
  // A mere substring hit would also be satisfied by a mangled identifier such
  // as `isRestartControllers`.
  for (const term of TOOL_TERMS) {
    if (!splitTopLevelOr(parsed.condA).includes(term)) {
      throw new Error(
        `config-guard bundle: ${file} does not route ${term} through the core-only branch`,
      );
    }
  }
  assertStatementSyntax(parsed.statement, `the configSnapshotOptions statement in ${file}`);

  const allowedIdentifiers = options.allowedIdentifiers;
  if (allowedIdentifiers instanceof Set) {
    for (const identifier of identifiersOf(source)) {
      if (!allowedIdentifiers.has(identifier)) {
        throw new Error(
          `config-guard bundle: ${file} references the identifier "${identifier}", ` +
            "which the patch must not introduce",
        );
      }
    }
  }

  if (expectPreflightSkipped) {
    for (const term of ['commandName !== "tool"', 'commandName !== "tools"']) {
      if (!source.includes(term)) {
        throw new Error(
          `config-guard bundle: ${file} still runs the startup preflight for the reserved roots`,
        );
      }
    }
  }
}

function patchFile(file) {
  const original = fs.readFileSync(file, "utf8");
  const alreadyPreflight = original.includes('commandName !== "tool"');

  const parsed = parseSnapshot(original);
  // The patch may only reshape the existing condition; it must never introduce
  // a new identifier (e.g. a mangled `commandName` variant). The allowed set is
  // derived from the file as it was before the patch.
  const allowedIdentifiers = identifiersOf(original);
  const snapshot = patchSnapshotStatement(parsed);

  let next = original;
  const changes = [];
  if (!alreadyPreflight) {
    if (!next.includes(PREFLIGHT_OLD)) {
      throw new Error(
        `config-guard bundle: ${file} does not contain the expected startup preflight condition`,
      );
    }
    next = next.replace(PREFLIGHT_OLD, PREFLIGHT_NEW);
    changes.push("skip-startup-preflight");
  }
  if (snapshot.status === "patched") {
    next = next.replace(snapshot.original, snapshot.statement);
    changes.push(...snapshot.changes);
  }

  if (next === original) {
    // Nothing to write, but the file still has to carry the intended shape:
    // "already-patched" must be a verified claim, not an assumption.
    verifyFile(file, true, { allowedIdentifiers });
    return { file, status: "already-patched", changes: [], verified: true };
  }

  fs.writeFileSync(file, next, "utf8");
  verifyFile(file, true, { allowedIdentifiers });

  return { file, status: "patched", changes, verified: true };
}

function main() {
  const targets = findTargets();
  const results = targets.map((file) => patchFile(file));
  const report = {
    patchedAt: new Date().toISOString(),
    results,
    anyPatched: results.some((r) => r.status === "patched"),
    allVerified: results.every((r) => r.status === "already-patched" || r.verified === true),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  const message = error?.message ?? String(error);
  process.stderr.write(`config-guard bundle patch failed: ${message}\n`);
  process.exit(1);
}
