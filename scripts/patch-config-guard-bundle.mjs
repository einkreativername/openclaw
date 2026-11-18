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
 * Bundle shape notes:
 *   OpenClaw 2026.10.9 ships this assignment under the identifier
 *   `configSnapshotOptions`, with `commandName` / `isRestartController`.
 *   OpenClaw 2026.11.5 is the same two-level ternary and the same preflight
 *   conjunction, but the local bindings are minified (e.g. `p`, `a`, `u`).
 *   The patch discovers those bindings from the bundle and applies the same
 *   rewrite; it does not relax verification if the shape cannot be proven.
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

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

/**
 * Longest term first: "tools" must be recognised before "tool", so a term is
 * never matched as a prefix of the other one.
 */
function toolTerms(commandNameIdent) {
  return [`${commandNameIdent} === "tools"`, `${commandNameIdent} === "tool"`];
}

function preflightNeedle(commandNameIdent, restartIdent) {
  return `${commandNameIdent} !== "sessions" && !${restartIdent}`;
}

function preflightReplacement(commandNameIdent, restartIdent) {
  return (
    `${commandNameIdent} !== "sessions" && ${commandNameIdent} !== "tool" && ` +
    `${commandNameIdent} !== "tools" && !${restartIdent}`
  );
}

/**
 * Matches a two-level snapshot ternary:
 *   const <name> = <condA> ? <coreOnly> : <condB> ? <observe> : <tail>;
 * The identifier is no longer hard-coded as `configSnapshotOptions`, because
 * 2026.11.5 minifies it. Semantic checks after the match still require the
 * core-only object, the observe object, and a validateConfigOnly condition.
 */
// condA/condB are expressions, not statements: they must not contain braces or
// semicolons. That keeps the match anchored to the snapshot ternary itself
// instead of swallowing an earlier `const` and the real assignment inside
// a non-greedy scan. The object literals are likewise required to be flat.
const SNAPSHOT_RE = new RegExp(
  String.raw`const (?<name>${IDENT}) = (?<condA>[^;{}]+?) \? (?<coreOnly>\{[^{}]*pluginValidation: "core-only"[^{}]*\}) : (?<condB>[^;{}]+?) \? (?<observe>\{[^{}]*observe: false[^{}]*\}) : (?<tail>[^;{}]+);`,
);

/**
 * The binding that holds commandPath[0] (commandName in 2026.10.9; a minified
 * local such as `a` in 2026.11.5). Fail if it cannot be proven.
 */
function discoverCommandNameIdent(source) {
  const direct = source.match(
    new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*commandPath\s*\[\s*0\s*\]`),
  );
  if (direct) return direct[1];

  const pathBinding = source.match(
    new RegExp(
      String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*${IDENT}\.commandPath\s*\?\?\s*\[\s*\]`,
    ),
  );
  if (pathBinding) {
    const fromArray = source.match(
      new RegExp(String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*${pathBinding[1]}\s*\[\s*0\s*\]`),
    );
    if (fromArray) return fromArray[1];
  }

  throw new Error(
    "config-guard bundle: could not locate the commandName binding; " +
      "the bundle shape changed and the patch cannot be verified",
  );
}

/**
 * The binding for the gateway/daemon restart-controller predicate.
 */
function discoverRestartControllerIdent(source, commandNameIdent) {
  const match = source.match(
    new RegExp(
      String.raw`(?:const|let|var)\s+(${IDENT})\s*=\s*\(\s*${commandNameIdent}\s*===\s*"gateway"\s*\|\|\s*${commandNameIdent}\s*===\s*"daemon"\s*\)`,
    ),
  );
  if (!match) {
    throw new Error(
      "config-guard bundle: could not locate the isRestartController binding; " +
        "the bundle shape changed and the patch cannot be verified",
    );
  }
  return match[1];
}

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
function isToolTerm(operand, terms) {
  return terms.includes(operand.trim());
}

/**
 * Removes the reserved-root operands from a condition, together with the `||`
 * separators that introduced them. Operands are matched exactly, so a
 * condition can never lose more than the reserved roots themselves.
 */
function stripToolTerms(condition, terms) {
  return splitTopLevelOr(condition)
    .filter((operand) => !isToolTerm(operand, terms))
    .join(" || ");
}

function hasToolTerm(condition, terms) {
  return splitTopLevelOr(condition).some((operand) => isToolTerm(operand, terms));
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

function snapshotSemanticErrors(groups) {
  const { condA, coreOnly, observe } = groups;
  if (!coreOnly.includes('pluginValidation: "core-only"')) {
    return 'the core-only branch does not carry pluginValidation: "core-only"';
  }
  if (!observe.includes("observe: false")) {
    return "the observe branch does not carry observe: false";
  }
  // Property access is required so a coincidental identifier is not enough.
  // The receiver may be `params` (2026.10.9) or a minified local (2026.11.5).
  if (!/\.validateConfigOnly\b/.test(condA)) {
    return "the first snapshot condition does not reference validateConfigOnly";
  }
  return null;
}

/**
 * Parses the snapshot statement and reports the conditions it found.
 */
function parseSnapshot(source) {
  const candidates = [];
  for (const match of source.matchAll(new RegExp(SNAPSHOT_RE, "g"))) {
    const error = snapshotSemanticErrors(match.groups);
    if (!error) {
      candidates.push(match);
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      "config-guard bundle: could not locate the configSnapshotOptions statement; " +
        "the bundle shape changed and the patch cannot be verified",
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      "config-guard bundle: found more than one configSnapshotOptions statement; " +
        "the bundle shape changed and the patch cannot be verified",
    );
  }
  const match = candidates[0];
  const { name, condA, coreOnly, condB, observe, tail } = match.groups;
  return { statement: match[0], name, condA, coreOnly, condB, observe, tail };
}

/**
 * Rewrites the snapshot statement so the reserved roots use core-only plugin
 * validation. Returns the patched statement plus the changes that were made.
 */
function patchSnapshotStatement(parsed, terms) {
  const { statement: original, name, condA, coreOnly, condB, observe, tail } = parsed;

  // Whether the reserved roots still sit on the observe-only branch has to be
  // decided on the *original* condition: the stripped condition never carries
  // a reserved root by construction, so asking the stripped value would
  // always answer "no" and hide a half-applied patch.
  const movedFromObserveBranch = hasToolTerm(condB, terms);
  const nextCondB = stripToolTerms(condB, terms);
  const alreadyOnCoreOnlyBranch = hasToolTerm(condA, terms);

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

  const nextCondA = alreadyOnCoreOnlyBranch ? condA : `${condA.trim()} || ${terms.join(" || ")}`;

  const statement = `const ${name} = ${nextCondA} ? ${coreOnly} : ${nextCondB} ? ${observe} : ${tail};`;
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
  const commandNameIdent = discoverCommandNameIdent(source);
  const restartIdent = discoverRestartControllerIdent(source, commandNameIdent);
  const terms = toolTerms(commandNameIdent);
  const parsed = parseSnapshot(source);

  if (hasToolTerm(parsed.condB, terms)) {
    throw new Error(
      `config-guard bundle: ${file} still references the reserved roots on the observe-only branch`,
    );
  }
  // The reserved roots must be complete operands of the core-only condition.
  // A mere substring hit would also be satisfied by a mangled identifier such
  // as `isRestartControllers`.
  for (const term of terms) {
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
    for (const term of [`${commandNameIdent} !== "tool"`, `${commandNameIdent} !== "tools"`]) {
      if (!source.includes(term)) {
        throw new Error(
          `config-guard bundle: ${file} still runs the startup preflight for the reserved roots`,
        );
      }
    }
    // The skip terms must sit in the same preflight conjunction as the
    // sessions / restart-controller guards, not in an unrelated string.
    const needle = preflightReplacement(commandNameIdent, restartIdent);
    if (!source.includes(needle)) {
      throw new Error(
        `config-guard bundle: ${file} does not skip the startup preflight with the expected condition`,
      );
    }
  }
}

function patchFile(file) {
  const original = fs.readFileSync(file, "utf8");
  const commandNameIdent = discoverCommandNameIdent(original);
  const restartIdent = discoverRestartControllerIdent(original, commandNameIdent);
  const terms = toolTerms(commandNameIdent);
  const alreadyPreflight = original.includes(`${commandNameIdent} !== "tool"`);

  const parsed = parseSnapshot(original);
  // The patch may only reshape the existing condition; it must never introduce
  // a new identifier (e.g. a mangled `commandName` variant). The allowed set is
  // derived from the file as it was before the patch.
  const allowedIdentifiers = identifiersOf(original);
  const snapshot = patchSnapshotStatement(parsed, terms);

  let next = original;
  const changes = [];
  if (!alreadyPreflight) {
    const oldNeedle = preflightNeedle(commandNameIdent, restartIdent);
    const occurrences = next.split(oldNeedle).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `config-guard bundle: ${file} does not contain exactly one expected startup preflight condition`,
      );
    }
    next = next.replace(oldNeedle, preflightReplacement(commandNameIdent, restartIdent));
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
