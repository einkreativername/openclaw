#!/usr/bin/env node
// Resolves a sensible thread count for oxfmt. The project's existing
// `oxfmt --write --threads=1` is a deliberate OOM guard, but it is artificially
// slow on multi-vCPU hosts. This runner spawns oxfmt with `--threads=N` where
// N is the smaller of (host CPUs - 1) and 4 — enough parallelism to recover
// most of the wall-clock time without spiking memory on GitHub-hosted runners.
import { spawn } from "node:child_process";
import { cpus } from "node:os";

const args = process.argv.slice(2);
const threads = Math.min(Math.max(1, cpus().length - 1), 4);
const child = spawn("oxfmt", [...args, `--threads=${threads}`], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
