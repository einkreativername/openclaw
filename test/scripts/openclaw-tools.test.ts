import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const WRAPPER = path.join(REPO_ROOT, "scripts/openclaw-tools.mjs");

const CHANNEL_USER_ID = "8363157125";

type Fixture = {
  base: string;
  skillsRoot: string;
  home: string;
};

const fixtures: Fixture[] = [];

function createFixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "openclaw-tools-test-"));
  const skillsRoot = path.join(base, "skills");
  const home = path.join(base, "home");
  mkdirSync(skillsRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  const fixture = { base, skillsRoot, home };
  fixtures.push(fixture);
  return fixture;
}

/** Write a skill whose runner is an in-process `index.cjs` exporting `run`. */
function writeIndexSkill(fixture: Fixture, name: string, source: string): void {
  const dir = path.join(fixture.skillsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture skill for wrapper regression tests\n---\n\n# ${name}\n`,
  );
  writeFileSync(path.join(dir, "index.cjs"), source);
}

/** Write a skill whose runner is a standalone `scripts/run.cjs` CLI. */
function writeScriptSkill(fixture: Fixture, name: string, source: string): void {
  const dir = path.join(fixture.skillsRoot, name);
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture skill for wrapper regression tests\n---\n\n# ${name}\n`,
  );
  writeFileSync(path.join(dir, "scripts", "run.cjs"), source);
}

type RunResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runWrapper(
  fixture: Fixture,
  args: string[],
  env: Record<string, string | undefined> = {},
): RunResult {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    childEnv[key] = value;
  }
  // Keep the fixture hermetic: no host skills, no host config dir, no
  // inherited timeout override.
  delete childEnv.OPENCLAW_CONFIG_DIR;
  delete childEnv.OPENCLAW_STATE_DIR;
  delete childEnv.OPENCLAW_TOOLS_CALL_TIMEOUT_MS;
  childEnv.OPENCLAW_SKILLS_DIR = fixture.skillsRoot;
  childEnv.OPENCLAW_CHANNEL_USER_ID = CHANNEL_USER_ID;
  childEnv.HOME = fixture.home;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }

  const result = spawnSync(process.execPath, [WRAPPER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: childEnv,
    timeout: 20_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

afterEach(() => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) continue;
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

describe("openclaw tools wrapper", () => {
  it("documents the default per-call timeout", () => {
    const fixture = createFixture();
    const result = runWrapper(fixture, ["help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "OPENCLAW_TOOLS_CALL_TIMEOUT_MS per-call timeout in ms (default 90000; must be > 0)",
    );
  });

  it("fails a hanging skill with the configured timeout budget", () => {
    const fixture = createFixture();
    writeIndexSkill(
      fixture,
      "fd-test-hang",
      [
        "exports.run = async function run(payload) {",
        "  setInterval(() => {}, 1000);",
        "  await new Promise(() => {});",
        "};",
      ].join("\n"),
    );

    const result = runWrapper(fixture, ["call", "fd-test-hang", "ping"], {
      OPENCLAW_TOOLS_CALL_TIMEOUT_MS: "500",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fd-test-hang timed out after 500ms");
    expect(result.stdout).toBe("");
  });

  it("applies the configured timeout budget to script runners", () => {
    const fixture = createFixture();
    writeScriptSkill(fixture, "fd-test-hang-script", ["setTimeout(() => {}, 10000);"].join("\n"));

    const result = runWrapper(fixture, ["call", "fd-test-hang-script", "ping"], {
      OPENCLAW_TOOLS_CALL_TIMEOUT_MS: "500",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fd-test-hang-script timed out after 500ms");
  });

  it("returns the skill result and exits even when the runner leaks a handle", () => {
    const fixture = createFixture();
    writeIndexSkill(
      fixture,
      "fd-test-leaky",
      [
        "exports.run = async function run(payload) {",
        "  setInterval(() => {}, 1000);",
        "  return { success: true, action: payload.action ?? null };",
        "};",
      ].join("\n"),
    );

    const result = runWrapper(fixture, ["call", "fd-test-leaky", "ping"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ success: true, action: "ping" });
  });

  it.each(["abc", "0", "-1", "1.5", "1e3"])("rejects an invalid timeout override (%j)", (value) => {
    const fixture = createFixture();
    writeIndexSkill(
      fixture,
      "fd-test-invalid-timeout",
      ["exports.run = async function run() { return { success: true }; };"].join("\n"),
    );

    const result = runWrapper(fixture, ["call", "fd-test-invalid-timeout", "ping"], {
      OPENCLAW_TOOLS_CALL_TIMEOUT_MS: value,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid OPENCLAW_TOOLS_CALL_TIMEOUT_MS");
    expect(result.stdout).toBe("");
  });

  it.each(["", "  "])("falls back to the default timeout for a blank override (%j)", (value) => {
    const fixture = createFixture();
    writeIndexSkill(
      fixture,
      "fd-test-blank-timeout",
      ["exports.run = async function run() { return { success: true }; };"].join("\n"),
    );

    const result = runWrapper(fixture, ["call", "fd-test-blank-timeout", "ping"], {
      OPENCLAW_TOOLS_CALL_TIMEOUT_MS: value,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ success: true });
  });
});
