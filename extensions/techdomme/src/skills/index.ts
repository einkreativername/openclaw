/**
 * Techdomme skill registry. Iterates over the skill files in this directory
 * and registers each with the openclaw skill registry.
 *
 * Future per-skill specs add new files in this directory and re-export
 * them here. No manifest change is needed.
 *
 * The current Spec 0 ships one skill: `placeholder-mode-info`.
 */

import * as placeholderModeInfo from "./placeholder-mode-info.js";

type SkillModule = {
  name: string;
  description: string;
  appliesWhen?: (ctx: unknown) => boolean;
  run: (args: unknown, ctx: unknown) => Promise<unknown> | unknown;
};

const SKILL_MODULES: SkillModule[] = [
  // Add new skills here as they are added in follow-on specs.
  placeholderModeInfo as SkillModule,
];

export type RegisterTechdommeSkillsInput = {
  registry: {
    register(skill: SkillModule): void;
    unregister(name: string): void;
  };
  log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
  };
};

/**
 * Register every techdomme skill. Returns the list of successfully
 * registered names so the entry point can clean them up on session end.
 *
 * Edge cases:
 *   - Two skills declare the same name -> the duplicate is skipped with a
 *     warn. The first registered wins.
 *   - A skill file fails to load (e.g., a typo in the export) -> that
 *     skill is skipped with a warn; the rest register.
 */
export function registerTechdommeSkills(
  input: RegisterTechdommeSkillsInput,
): string[] {
  const seen = new Set<string>();
  const registered: string[] = [];

  for (const skill of SKILL_MODULES) {
    if (seen.has(skill.name)) {
      input.log?.warn("techdomme skill name collision; skipping duplicate", {
        name: skill.name,
      });
      continue;
    }
    if (typeof skill.name !== "string" || skill.name.length === 0) {
      input.log?.warn("techdomme skill has no name; skipping", {});
      continue;
    }
    if (typeof skill.description !== "string" || skill.description.length === 0) {
      input.log?.warn("techdomme skill has no description; skipping", {
        name: skill.name,
      });
      continue;
    }
    if (typeof skill.run !== "function") {
      input.log?.warn("techdomme skill has no run function; skipping", {
        name: skill.name,
      });
      continue;
    }

    try {
      input.registry.register(skill);
      seen.add(skill.name);
      registered.push(skill.name);
      input.log?.info("techdomme skill registered", { name: skill.name });
    } catch (err) {
      input.log?.warn("techdomme skill registration failed; skipping", {
        name: skill.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return registered;
}
