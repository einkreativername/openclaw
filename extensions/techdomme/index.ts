/**
 * Techdomme gateway-skin extension entry point (Spec 0).
 *
 * Responsibilities on every session:
 *   1. Read the TechdommeSessionContext the gateway middleware attached
 *      to the session (set in src/gateway/techdomme/middleware.ts).
 *   2. If active: register the persona overlay hook AND the active
 *      techdomme skills with the openclaw skill registry.
 *   3. Return a cleanup function that unregisters on session end.
 *
 * Failure modes (spec §0.4):
 *   - The session has no TechdommeSessionContext -> no-op, return identity cleanup.
 *   - The persona .md file is missing for the active locale -> fall back to en.md.
 *   - A skill fails to load -> that skill is skipped with a warn; the rest register.
 *   - Two skills declare the same name -> error at registration time, abort the
 *     extension for this session (the session still runs in normal mode).
 *
 * The skill registration is intentionally a thin layer. Future per-skill specs
 * add new files in src/skills/ and call registerTechdommeSkill(...) from here.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { applyPersonaOverlay } from "./src/persona/apply.js";
import { registerTechdommeSkills } from "./src/skills/index.js";

type TechdommeSessionContext = {
  active: boolean;
  source: "user" | "channel" | "off";
  reason?: string;
  locale: string;
  version: number;
};

type TechdommeExtensionContext = {
  // The actual shape comes from openclaw/plugin-sdk. The minimum surface we use
  // is session attachment + a skill-registry hook. Plugin authors are expected
  // to extend this once the SDK surface is stable.
  session?: {
    techdomme?: TechdommeSessionContext;
  };
  skills?: {
    register(skill: {
      name: string;
      description: string;
      appliesWhen?: (ctx: unknown) => boolean;
      run: (args: unknown, ctx: unknown) => Promise<unknown> | unknown;
    }): void;
    unregister(name: string): void;
  };
  log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
  };
};

export default definePluginEntry({
  id: "techdomme",

  async onSessionStart(ctx: TechdommeExtensionContext) {
    const session = ctx.session;
    const skills = ctx.skills;
    const log = ctx.log;
    if (!session || !skills) {
      // Plugin host does not provide the surfaces we need. Bail.
      return () => {};
    }

    const techdomme = session.techdomme;
    if (!techdomme || !techdomme.active) {
      // Not opted in (or activation failed) -> no persona, no skills, no cleanup.
      return () => {};
    }

    if (log) {
      log.info("techdomme mode active", {
        source: techdomme.source,
        locale: techdomme.locale,
        version: techdomme.version,
      });
    }

    // 1. Apply the persona overlay. The apply function mutates the active agent's
    //    system prompt via the SDK; if the SDK does not expose a hook, we log a
    //    warning and continue (fail-soft per spec §0.4).
    try {
      await applyPersonaOverlay({
        locale: techdomme.locale,
        log,
      });
    } catch (err) {
      if (log) {
        log.warn("techdomme persona overlay failed; continuing without overlay", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Register the active skills. The registry enforces unique names and
    //    surfaces a warn-on-skip for any file that fails to load.
    const registeredNames = registerTechdommeSkills({
      registry: skills,
      log,
    });

    return () => {
      for (const name of registeredNames) {
        try {
          skills.unregister(name);
        } catch {
          // best-effort cleanup
        }
      }
    };
  },
});
