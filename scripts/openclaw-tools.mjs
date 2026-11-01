#!/usr/bin/env node
/**
 * openclaw tools — Skill-Runner-Wrapper.
 *
 * Upstream OpenClaw reserves the "tool"/"tools" command roots but ships no
 * implementation for them (see src/cli/command-registration-policy.ts), so
 * `openclaw tools …` can only ever answer "unknown command". This wrapper
 * provides the documented invocation path for the FD skill fleet:
 *
 *   openclaw tools list  [--json]
 *   openclaw tools info  <skill> [--json]
 *   openclaw tools check [--json]
 *   openclaw tools call  <skill> [action] [json-payload]
 *
 * Runner contract (verified against the installed skill fleet):
 *   - <skill>/index.cjs        → exports run(payload); preferred entry point.
 *   - <skill>/scripts/run.cjs  → standalone CLI runner; JSON payload in argv[2].
 *   - neither                  → prompt-only skill, not callable.
 *
 * Only Node builtins are used: the script runs as a plain ESM module inside
 * the container image without any dependency resolution.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Default channel context for FD calls; overridable via env.
 *
 * Only the channel *type* has a non-personal default. The channel user id is
 * personal identity and therefore never has a built-in fallback: it must be
 * supplied by the caller (payload) or by the environment. Silently defaulting to
 * a foreign identity would attribute calls to someone else.
 */
const DEFAULT_CHANNEL_TYPE = "telegram";

/** Hard ceiling for a single skill call. */
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

/**
 * Resolve the per-call timeout.
 *
 * `OPENCLAW_TOOLS_CALL_TIMEOUT_MS` overrides the default for slow skills. The
 * value is resolved lazily (only when a call actually runs) and validated
 * strictly: only a positive integer is accepted. An invalid value is a hard
 * configuration error instead of a silent fallback, because a silently
 * ignored override would hide a misconfigured timeout until the next hang.
 */
function resolveCallTimeoutMs() {
  const raw = process.env.OPENCLAW_TOOLS_CALL_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_CALL_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ToolsError(
      `invalid OPENCLAW_TOOLS_CALL_TIMEOUT_MS: expected a positive integer of milliseconds, got "${raw}"`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToolsError(
      `invalid OPENCLAW_TOOLS_CALL_TIMEOUT_MS: expected a positive integer of milliseconds, got "${raw}"`,
    );
  }
  return value;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "dist", "build", "coverage"]);
const SKIP_FILES = new Set(["SKILL.md"]);

class ToolsError extends Error {}

// ---------------------------------------------------------------------------
// skill discovery
// ---------------------------------------------------------------------------

function skillRoots() {
  const roots = [];
  const push = (candidate) => {
    if (!candidate) return;
    try {
      if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return;
      roots.push(path.resolve(candidate));
    } catch {
      /* unreadable candidate */
    }
  };

  const envRoots = process.env.OPENCLAW_SKILLS_DIR;
  if (envRoots) {
    for (const entry of envRoots.split(path.delimiter)) push(entry);
  }

  const configDir =
    process.env.OPENCLAW_CONFIG_DIR ||
    process.env.OPENCLAW_STATE_DIR ||
    path.join(homedir(), ".openclaw");
  push(path.join(configDir, "skills"));
  push(path.join(homedir(), ".openclaw", "skills"));
  push("/app/skills");

  return [...new Set(roots)];
}

function findSkillDirs(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (existsSync(path.join(full, "SKILL.md"))) {
        found.push(full);
        continue; // a skill directory is never a parent of another skill
      }
      stack.push(full);
    }
  }
  return found;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const candidate = lines[j];
        if (candidate.trim() === "") {
          parts.push(" ");
          continue;
        }
        if (/^\s/.test(candidate)) {
          parts.push(candidate.trim());
          continue;
        }
        break;
      }
      i = j - 1;
      value = parts.join(" ").replace(/\s+/g, " ").trim();
    } else {
      value = value.replace(/^["']|["']$/g, "").trim();
    }
    fields[key] = value;
  }
  return fields;
}

function analyzeIndexSource(source) {
  const hasRun =
    /module\.exports\s*=\s*\{[^}]*\brun\b/.test(source) ||
    /exports\.run\s*=/.test(source) ||
    /function\s+run\s*\(/.test(source);
  let contract = "payload";
  if (/function\s+run\s*\(\s*\{\s*intent\b/.test(source)) contract = "intent";
  else if (/function\s+run\s*\(\s*\{\s*action\b/.test(source)) contract = "action";
  else if (/function\s+run\s*\(\s*payload\s*,\s*deps/.test(source)) contract = "payload+deps";
  const actions = [];
  const actionPattern = /case\s+['"]([^'"]+)['"]\s*:/g;
  let actionMatch = actionPattern.exec(source);
  while (actionMatch) {
    if (!actions.includes(actionMatch[1])) actions.push(actionMatch[1]);
    actionMatch = actionPattern.exec(source);
  }
  return { hasRun, contract, actions };
}

function detectRunner(dir) {
  const indexPath = path.join(dir, "index.cjs");
  const scriptPath = path.join(dir, "scripts", "run.cjs");
  if (existsSync(indexPath)) {
    let source = "";
    try {
      source = readFileSync(indexPath, "utf8");
    } catch {
      /* unreadable */
    }
    const analysis = analyzeIndexSource(source);
    if (analysis.hasRun) {
      return { kind: "index", path: indexPath, ...analysis, actions: analysis.actions };
    }
  }
  if (existsSync(scriptPath)) {
    return { kind: "script", path: scriptPath, hasRun: true, contract: "payload", actions: [] };
  }
  return { kind: "none", path: null, hasRun: false, contract: "none", actions: [] };
}

function loadSkills() {
  const skills = [];
  const seen = new Set();
  for (const root of skillRoots()) {
    for (const dir of findSkillDirs(root)) {
      const key = path.resolve(dir);
      if (seen.has(key)) continue;
      seen.add(key);
      let raw = "";
      try {
        raw = readFileSync(path.join(dir, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const frontmatter = parseFrontmatter(raw);
      const runner = detectRunner(dir);
      const name = frontmatter.name || path.basename(dir);
      skills.push({
        name,
        dir,
        relativeDir: path.relative(root, dir),
        description: frontmatter.description || "",
        runner: runner.kind,
        runnerPath: runner.path,
        contract: runner.contract,
        executable: runner.kind !== "none",
        actions: runner.actions,
      });
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function findSkill(skills, needle) {
  const lowered = needle.toLowerCase();
  return (
    skills.find((skill) => skill.name.toLowerCase() === lowered) ||
    skills.find((skill) => path.basename(skill.dir).toLowerCase() === lowered) ||
    skills.find((skill) => skill.relativeDir.toLowerCase() === lowered) ||
    skills.find((skill) => skill.dir.toLowerCase().endsWith(`/${lowered}`))
  );
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

function readProcEnviron() {
  try {
    const raw = readFileSync("/proc/1/environ", "utf8");
    const env = {};
    for (const entry of raw.split("\0")) {
      const index = entry.indexOf("=");
      if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
    }
    return env;
  } catch {
    return {};
  }
}

/**
 * The agent worker does not inherit the gateway environment, so the service
 * token can be missing even though the gateway process has it. Read it from
 * the init process environment as a fallback. The value is never logged.
 */
function hydrateServiceEnvironment() {
  if (process.env.SERVICE_TOKEN && process.env.KINKYGATE_API_KEY) return;
  const procEnv = readProcEnviron();
  for (const key of [
    "SERVICE_TOKEN",
    "KINKYGATE_API_KEY",
    "KG_API_TOKEN",
    "KINKYGATE_API_URL",
    "FD_SKILL_BASE_URL",
  ]) {
    if (!process.env[key] && procEnv[key]) process.env[key] = procEnv[key];
  }
}

// ---------------------------------------------------------------------------
// output plumbing
// ---------------------------------------------------------------------------

/**
 * Tracked writes for stdout/stderr.
 *
 * The wrapper must not depend on the event loop draining before it exits:
 * a skill runner may leave sockets or timers open (an in-process `run()`
 * that never resolves keeps its handles alive), and `process.exitCode` alone
 * would then hang the caller forever. Every write is therefore registered
 * here so the exit path can wait for the stream to actually flush before
 * terminating the process.
 *
 * Stream ordering guarantees that a write callback only fires once the
 * preceding chunks of the same stream have been flushed as well, so awaiting
 * the tracked writes is enough to know that stdout/stderr are complete.
 */
const pendingWrites = new Set();

function writeTracked(stream, chunk) {
  let settle;
  const tracked = new Promise((resolve) => {
    settle = resolve;
  });
  pendingWrites.add(tracked);
  stream.write(chunk, () => {
    pendingWrites.delete(tracked);
    settle();
  });
  return tracked;
}

function writeOut(chunk) {
  return writeTracked(process.stdout, chunk);
}

function writeErr(chunk) {
  return writeTracked(process.stderr, chunk);
}

/** Wait until every tracked stdout/stderr write has been flushed. */
async function flushWrites() {
  while (pendingWrites.size > 0) {
    await Promise.all([...pendingWrites]);
  }
}

/**
 * Terminate deterministically after flushing output.
 *
 * `process.exit()` is used on purpose: the wrapper owns the whole process
 * lifetime and must not be kept alive by handles owned by a skill runner.
 */
async function exitWith(code) {
  process.exitCode = code;
  await flushWrites();
  process.exit(code);
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

function cmdList(args) {
  const skills = loadSkills();
  if (args.includes("--json")) {
    printJson(
      skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        path: skill.dir,
        runner: skill.runner,
        executable: skill.executable,
        actions: skill.actions,
      })),
    );
    return 0;
  }
  if (skills.length === 0) {
    writeErr("no skills found\n");
    return 1;
  }
  for (const skill of skills) {
    const marker = skill.executable ? "run" : " - ";
    const actions = skill.actions.length > 0 ? ` [${skill.actions.join(", ")}]` : "";
    writeOut(`${marker}  ${skill.name}${actions}\n`);
    if (skill.description) writeOut(`      ${skill.description}\n`);
  }
  writeOut(`\n${skills.length} skills, ${skills.filter((s) => s.executable).length} executable\n`);
  return 0;
}

function cmdInfo(args) {
  const name = args.find((arg) => !arg.startsWith("--"));
  if (!name) throw new ToolsError("usage: openclaw tools info <skill> [--json]");
  const skills = loadSkills();
  const skill = findSkill(skills, name);
  if (!skill) throw new ToolsError(`unknown skill: ${name}`);
  const info = {
    name: skill.name,
    description: skill.description,
    path: skill.dir,
    runner: skill.runner,
    runnerPath: skill.runnerPath,
    contract: skill.contract,
    executable: skill.executable,
    actions: skill.actions,
  };
  if (args.includes("--json")) {
    printJson(info);
    return 0;
  }
  writeOut(`${info.name}\n`);
  if (info.description) writeOut(`  ${info.description}\n`);
  writeOut(`  path:     ${info.path}\n`);
  writeOut(`  runner:   ${info.runner}\n`);
  writeOut(`  contract: ${info.contract}\n`);
  writeOut(`  callable: ${info.executable ? "yes" : "no (prompt-only skill)"}\n`);
  if (info.actions.length > 0) writeOut(`  actions:  ${info.actions.join(", ")}\n`);
  return 0;
}

function cmdCheck(args) {
  const skills = loadSkills();
  const report = skills.map((skill) => {
    let status = "ok";
    let detail = "";
    if (!skill.executable) {
      status = "prompt-only";
      detail = "no index.cjs and no scripts/run.cjs";
    } else if (skill.runner === "index") {
      detail = `run(${skill.contract})`;
    } else {
      detail = "scripts/run.cjs runner";
    }
    return {
      name: skill.name,
      runner: skill.runner,
      contract: skill.contract,
      status,
      detail,
      actions: skill.actions,
    };
  });
  if (args.includes("--json")) {
    printJson(report);
    return 0;
  }
  let failed = 0;
  for (const entry of report) {
    if (entry.status !== "ok") failed += 1;
    writeOut(`${entry.status === "ok" ? "ok  " : "skip"}  ${entry.name}  (${entry.detail})\n`);
  }
  const callable = report.filter((entry) => entry.status === "ok").length;
  writeOut(`\n${report.length} skills, ${callable} callable, ${failed} not callable\n`);
  return 0;
}

function buildPayload(actionArg, jsonArg) {
  const payload = {};
  if (jsonArg !== undefined && jsonArg !== "") {
    const raw = jsonArg.startsWith("@") ? readFileSync(jsonArg.slice(1), "utf8") : jsonArg;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ToolsError(`invalid JSON payload: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ToolsError("payload must be a JSON object");
    }
    Object.assign(payload, parsed);
  }
  const action = actionArg || payload.action;
  if (action) payload.action = action;
  if (!payload.channelType)
    payload.channelType = process.env.OPENCLAW_CHANNEL_TYPE || DEFAULT_CHANNEL_TYPE;
  if (!payload.channelUserId) payload.channelUserId = process.env.OPENCLAW_CHANNEL_USER_ID;
  if (!payload.channelUserId) {
    throw new ToolsError(
      "missing channelUserId: pass it in the JSON payload or set OPENCLAW_CHANNEL_USER_ID",
    );
  }
  return payload;
}

async function callSkillIndex(skill, payload) {
  const module = require(skill.runnerPath);
  const fn =
    typeof module?.run === "function"
      ? module.run
      : typeof module?.default?.run === "function"
        ? module.default.run
        : null;
  if (!fn) throw new ToolsError(`skill ${skill.name} does not export a run() function`);

  let argument = payload;
  if (skill.contract === "intent") {
    argument = {
      intent: payload.intent ?? payload.action ?? null,
      payload: payload.payload ?? payload,
      source_agent: payload.source_agent ?? "openclaw-tools",
    };
  }
  return await fn(argument);
}

function callSkillScript(skill, payload, timeoutMs) {
  const result = spawnSync(process.execPath, [skill.runnerPath, JSON.stringify(payload)], {
    cwd: skill.dir,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new ToolsError(`skill ${skill.name} timed out after ${timeoutMs}ms`);
    }
    throw new ToolsError(`${skill.name} runner failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new ToolsError(
      `${skill.name} runner exited with ${result.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }
  const stdout = (result.stdout || "").trim();
  if (!stdout) return { success: true, output: "" };
  try {
    return JSON.parse(stdout);
  } catch {
    return { success: true, output: stdout };
  }
}

async function cmdCall(args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const name = positional[0];
  if (!name) throw new ToolsError("usage: openclaw tools call <skill> [action] [json-payload]");
  const skills = loadSkills();
  const skill = findSkill(skills, name);
  if (!skill) throw new ToolsError(`unknown skill: ${name}`);
  if (!skill.executable) {
    throw new ToolsError(`skill ${skill.name} has no executable runner (prompt-only skill)`);
  }

  hydrateServiceEnvironment();
  const payload = buildPayload(positional[1], positional[2]);

  // Resolve once so the script timeout and the in-process watchdog share the
  // same budget; a mismatch would report a timeout that never happened.
  const timeoutMs = resolveCallTimeoutMs();

  const result = await withTimeout(
    skill.runner === "index"
      ? callSkillIndex(skill, payload)
      : callSkillScript(skill, payload, timeoutMs),
    timeoutMs,
    `skill ${skill.name} timed out after ${timeoutMs}ms`,
  );

  printJson(result === undefined ? { success: true } : result);
  return 0;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolsError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function printJson(value) {
  writeOut(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return [
    "openclaw tools — skill runner",
    "",
    "Usage:",
    "  openclaw tools list  [--json]",
    "  openclaw tools info  <skill> [--json]",
    "  openclaw tools check [--json]",
    "  openclaw tools call  <skill> [action] [json-payload]",
    "",
    "Environment:",
    "  OPENCLAW_SKILLS_DIR      skill roots (path-delimited)",
    "  OPENCLAW_CHANNEL_TYPE    default channel type (telegram)",
    "  OPENCLAW_CHANNEL_USER_ID channel user id (required; no built-in default)",
    `  OPENCLAW_TOOLS_CALL_TIMEOUT_MS per-call timeout in ms (default ${DEFAULT_CALL_TIMEOUT_MS}; must be > 0)`,
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    writeOut(`${usage()}\n`);
    return subcommand ? 0 : 1;
  }

  switch (subcommand) {
    case "list":
      return cmdList(rest);
    case "info":
      return cmdInfo(rest);
    case "check":
      return cmdCheck(rest);
    case "call":
      return await cmdCall(rest);
    default:
      throw new ToolsError(`unknown tools subcommand: ${subcommand}`);
  }
}

main()
  .then((code) => exitWith(code ?? 0))
  .catch((error) => {
    const message =
      error instanceof ToolsError ? error.message : `unexpected failure: ${error?.stack || error}`;
    return writeErr(`${message}\n`).then(() => exitWith(1));
  });
