#!/usr/bin/env node
/**
 * Prunes stale OpenClaw plugin-source capture directories.
 *
 * The Core writes one capture directory per plugin load/admission below
 * `<stateDir>/tmp/plugin-captures/<uuid>/` (contents: `captures/`, `native/`,
 * `owner.sqlite`). The Core classifies that directory as volatile for backups
 * (see `VOLATILE_DIRECTORY_RULES` in `dist/backup-volatile-filter-*.mjs`) but
 * never deletes it, so a failing gateway boot can leave gigabytes behind.
 *
 * This pruner is deliberately independent of the gateway lifecycle: it runs as
 * its own container (see `docker-compose.yml`, service `plugin-captures-pruner`)
 * and therefore also cleans up when the gateway never started successfully.
 *
 * Usage:
 *   node prune-plugin-captures.mjs [--dir DIR] [--max-age-hours N]
 *                                   [--fallback-dir DIR] [--watch]
 *                                   [--interval-seconds N] [--proc-root DIR]
 *                                   [--dry-run] [--json]
 *
 * Safety: the target directory must be named `plugin-captures` and live below a
 * `tmp` directory. Anything else aborts without touching the filesystem.
 *
 * In-use detection: a capture that a live process still holds open (the gateway
 * keeps the capture's `owner.sqlite` open while the capture is applied) is never
 * deleted, regardless of the tree age. The pruner therefore shares the gateway's
 * PID namespace (compose: `pid: "service:openclaw-gateway"`) and scans
 * `/proc/<pid>/fd` for open files below the capture root.
 */

import fs from "node:fs";
import path from "node:path";

const LEGACY_CAPTURE_PREFIXES = [
  "openclaw-plugin-captures-",
  "openclaw-plugin-build-",
  "openclaw-model-catalog-",
];

function parseArgs(argv) {
  const opts = {
    dir: process.env.PLUGIN_CAPTURES_DIR ?? "",
    maxAgeHours: Number(process.env.PLUGIN_CAPTURES_MAX_AGE_HOURS ?? "2"),
    fallbackDir: process.env.PLUGIN_CAPTURES_FALLBACK_DIR ?? "",
    intervalSeconds: Number(process.env.PLUGIN_CAPTURES_INTERVAL_SECONDS ?? "900"),
    procRoot: process.env.PLUGIN_CAPTURES_PROC_ROOT ?? "/proc",
    watch: false,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dir":
        opts.dir = argv[++i] ?? "";
        break;
      case "--max-age-hours":
        opts.maxAgeHours = Number(argv[++i]);
        break;
      case "--fallback-dir":
        opts.fallbackDir = argv[++i] ?? "";
        break;
      case "--interval-seconds":
        opts.intervalSeconds = Number(argv[++i]);
        break;
      case "--proc-root":
        opts.procRoot = argv[++i] ?? "";
        break;
      case "--watch":
        opts.watch = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          "Usage: prune-plugin-captures.mjs [--dir DIR] [--max-age-hours N]\n" +
            "                            [--fallback-dir DIR] [--watch]\n" +
            "                            [--interval-seconds N] [--proc-root DIR]\n" +
            "                            [--dry-run] [--json]\n",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.maxAgeHours) || opts.maxAgeHours <= 0) {
    throw new Error("--max-age-hours must be a positive number");
  }
  if (!Number.isFinite(opts.intervalSeconds) || opts.intervalSeconds <= 0) {
    throw new Error("--interval-seconds must be a positive number");
  }
  return opts;
}

/**
 * Guards against catastrophic deletion: only a directory literally named
 * `plugin-captures` that sits below a `tmp` parent is accepted.
 */
function assertSafeCaptureRoot(dir) {
  const resolved = path.resolve(dir);
  const base = path.basename(resolved);
  if (base !== "plugin-captures") {
    throw new Error(
      `Refusing to prune ${resolved}: target directory must be named "plugin-captures"`,
    );
  }
  if (path.basename(path.dirname(resolved)) !== "tmp") {
    throw new Error(
      `Refusing to prune ${resolved}: expected the parent directory to be named "tmp"`,
    );
  }
  return resolved;
}

/**
 * Reads the NUL-separated argv of a process. Returns null when the file cannot
 * be read (e.g. a process owned by another uid); returns an empty array for a
 * kernel thread without argv.
 */
function readProcCmdline(procRoot, pid) {
  try {
    const raw = fs.readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8");
    return raw.split("\0").filter((part) => part.length > 0);
  } catch {
    return null;
  }
}

/**
 * True when the argv belongs to the gateway process. The gateway is started as
 * `node dist/index.js gateway ...`, so the executable basename is "node" and
 * one argv token is exactly "gateway". Checking the executable keeps the
 * container's PID 1 (`docker-init -- tini -s -- node ... gateway`) out of the
 * candidate set.
 */
function isGatewayProcess(argv) {
  if (!argv || argv.length < 2) return false;
  if (path.basename(argv[0]) !== "node") return false;
  return argv.includes("gateway");
}

/**
 * Guard against pruning inside a foreign or stale PID namespace: the shared
 * namespace must be the one the gateway container runs in. Its PID 1 command
 * line carries the gateway argument.
 */
function assertGatewayNamespace(procRoot) {
  const argv = readProcCmdline(procRoot, 1);
  if (!argv) {
    throw new Error(
      `Refusing to prune: cannot read ${path.join(procRoot, "1", "cmdline")} (no shared PID namespace?)`,
    );
  }
  if (!argv.includes("gateway")) {
    throw new Error(
      `Refusing to prune: PID 1 in ${procRoot} is not the gateway (${argv.join(" ")})`,
    );
  }
}

/**
 * Maps an open file path to the capture it belongs to. The capture name is the
 * directory segment directly below a "plugin-captures" segment; the legacy
 * layout puts the capture directly below a "tmp" directory under a name that
 * starts with one of the known capture prefixes.
 */
function captureNameFromPath(target) {
  if (!target) return null;
  const cleaned = target.replace(/ \(deleted\)$/, "");
  const segments = cleaned.split("/").filter((part) => part.length > 0);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === "plugin-captures") return segments[i + 1];
  }
  for (const segment of segments) {
    if (LEGACY_CAPTURE_PREFIXES.some((prefix) => segment.startsWith(prefix))) {
      return segment;
    }
  }
  return null;
}

/**
 * Scans the shared PID namespace for files the gateway still holds open below a
 * capture directory. Returns the set of capture names that are in use.
 *
 * Fails hard when the gateway process cannot be identified or its file
 * descriptors cannot be read: an incomplete scan would let the pruner delete a
 * capture the gateway is actively using.
 */
function scanOpenFiles(procRoot) {
  assertGatewayNamespace(procRoot);
  let pids;
  try {
    pids = fs
      .readdirSync(procRoot)
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number(name));
  } catch (err) {
    throw new Error(
      `Refusing to prune: cannot read PID namespace ${procRoot} (${err.code ?? err})`,
    );
  }
  const inUse = new Set();
  let gatewayPids = 0;
  let unreadablePids = 0;
  for (const pid of pids) {
    const argv = readProcCmdline(procRoot, pid);
    if (argv === null) {
      unreadablePids++;
      continue;
    }
    if (!isGatewayProcess(argv)) continue;
    gatewayPids++;
    const fdDir = path.join(procRoot, String(pid), "fd");
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch (err) {
      throw new Error(
        `Refusing to prune: cannot read gateway file descriptors in ${fdDir} (${err.code ?? err})`,
      );
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const name = captureNameFromPath(target);
      if (name) inUse.add(name);
    }
  }
  if (gatewayPids === 0) {
    throw new Error(
      `Refusing to prune: no gateway process found in ${procRoot} (wrong PID namespace?)`,
    );
  }
  return { inUse, gatewayPids, unreadablePids };
}

/**
 * Returns the newest mtime (ms) inside `dir`, or null when the entry does not
 * exist. Stops walking as soon as something newer than `stopAfter` is found so
 * large capture trees stay cheap to inspect.
 */
function newestMtime(dir, stopAfter = Number.POSITIVE_INFINITY) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      if (newest >= stopAfter) return;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return newest === 0 ? null : newest;
}

function directorySizeBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        total += fs.lstatSync(full).size;
      } catch {
        /* ignore */
      }
    }
  };
  walk(dir);
  return total;
}

function pruneCaptureRoot(root, cutoff, dryRun, inUse = new Set()) {
  const removed = [];
  const kept = [];
  let freedBytes = 0;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { removed, kept, freedBytes, error: err.code ?? String(err) };
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    // A capture the gateway still holds open is never deleted, no matter how
    // old the tree is.
    if (inUse.has(entry.name)) {
      kept.push({ name: entry.name, newestMtime: newestMtime(full, cutoff), inUse: true });
      continue;
    }
    const newest = newestMtime(full, cutoff);
    if (newest === null || newest >= cutoff) {
      kept.push({ name: entry.name, newestMtime: newest });
      continue;
    }
    const size = directorySizeBytes(full);
    if (!dryRun) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch (err) {
        kept.push({ name: entry.name, error: err.code ?? String(err) });
        continue;
      }
    }
    freedBytes += size;
    removed.push({ name: entry.name, bytes: size, newestMtime: newest });
  }
  return { removed, kept, freedBytes };
}

function pruneFallbackDir(dir, cutoff, dryRun, inUse = new Set()) {
  const removed = [];
  const kept = [];
  let freedBytes = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { removed, kept, freedBytes, error: err.code ?? String(err) };
  }
  for (const entry of entries) {
    if (!LEGACY_CAPTURE_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const full = path.join(dir, entry.name);
    if (inUse.has(entry.name)) {
      kept.push({ name: entry.name, newestMtime: newestMtime(full, cutoff), inUse: true });
      continue;
    }
    const newest = newestMtime(full, cutoff);
    if (newest !== null && newest >= cutoff) {
      kept.push({ name: entry.name, newestMtime: newest });
      continue;
    }
    const size = entry.isDirectory() ? directorySizeBytes(full) : 0;
    if (!dryRun) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch (err) {
        kept.push({ name: entry.name, error: err.code ?? String(err) });
        continue;
      }
    }
    freedBytes += size;
    removed.push({ name: entry.name, bytes: size, newestMtime: newest });
  }
  return { removed, kept, freedBytes };
}

function runOnce(opts) {
  const cutoff = Date.now() - opts.maxAgeHours * 60 * 60 * 1000;
  const root = assertSafeCaptureRoot(opts.dir);
  // Fails hard when the gateway PID namespace is not shared or the gateway's
  // open files cannot be read: an incomplete scan would delete a capture the
  // gateway is actively using.
  const scan = scanOpenFiles(opts.procRoot);
  const inUse = scan.inUse;
  const captures = pruneCaptureRoot(root, cutoff, opts.dryRun, inUse);
  const fallback = opts.fallbackDir
    ? pruneFallbackDir(path.resolve(opts.fallbackDir), cutoff, opts.dryRun, inUse)
    : { removed: [], kept: [], freedBytes: 0 };
  const result = {
    root,
    cutoff: new Date(cutoff).toISOString(),
    maxAgeHours: opts.maxAgeHours,
    dryRun: opts.dryRun,
    inUse: [...inUse].sort(),
    gatewayPids: scan.gatewayPids,
    unreadablePids: scan.unreadablePids,
    captures,
    fallback,
    freedBytes: captures.freedBytes + fallback.freedBytes,
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const removedCount = captures.removed.length + fallback.removed.length;
    process.stdout.write(
      `prune: removed=${removedCount} freed=${(result.freedBytes / 1024 / 1024).toFixed(1)}MiB ` +
        `kept=${captures.kept.length + fallback.kept.length} inUse=${result.inUse.length} ` +
        `cutoff=${result.cutoff}${opts.dryRun ? " (dry-run)" : ""}\n`,
    );
  }
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.watch) {
    runOnce(opts);
    return;
  }
  for (;;) {
    try {
      runOnce(opts);
    } catch (err) {
      process.stderr.write(`prune: cycle failed: ${err?.message ?? err}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalSeconds * 1000));
  }
}

main().catch((err) => {
  process.stderr.write(`prune: ${err?.message ?? err}\n`);
  process.exit(1);
});
