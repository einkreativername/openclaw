/**
 * Placeholder skill shipped with the techdomme gateway-skin (Spec 0).
 *
 * Returns a status object describing the active techdomme session. It is
 * intentionally minimal: a real follow-on skill spec will replace this
 * with the first substantive techdomme skill (likely "code review" or
 * "task discipline").
 *
 * Schema (per spec §0.3):
 *   { name, description, appliesWhen(ctx), run(args, ctx) }
 */

export type PlaceholderModeInfoInput = {
  // The TechdommeSessionContext the gateway middleware attached.
  techdomme: {
    active: boolean;
    source: "user" | "channel" | "off";
    reason?: string;
    locale: string;
    version: number;
  };
  // Minimal session surface so the placeholder is useful for smoke tests.
  session: {
    id: string;
    userId: string;
    channelId: string;
  };
};

export type PlaceholderModeInfoOutput = {
  skill: "techdomme-mode-info";
  active: boolean;
  source: "user" | "channel" | "off";
  reason?: string;
  locale: string;
  extensionVersion: string;
  session: { id: string; userId: string; channelId: string };
};

export const name = "techdomme-mode-info";

export const description =
  "Returns a status object describing the active techdomme session. " +
  "Useful as a smoke test for the techdomme gateway-skin wiring.";

export const appliesWhen = (ctx: unknown): boolean => {
  if (typeof ctx !== "object" || ctx === null) return false;
  const c = ctx as { techdomme?: { active?: boolean } };
  return c.techdomme?.active === true;
};

export const run = async (
  _args: unknown,
  ctx: unknown,
): Promise<PlaceholderModeInfoOutput> => {
  if (typeof ctx !== "object" || ctx === null) {
    throw new Error("techdomme-mode-info: missing context");
  }
  const c = ctx as PlaceholderModeInfoInput;
  if (!c.techdomme || !c.session) {
    throw new Error("techdomme-mode-info: context missing techdomme/session");
  }
  return {
    skill: "techdomme-mode-info",
    active: c.techdomme.active,
    source: c.techdomme.source,
    reason: c.techdomme.reason,
    locale: c.techdomme.locale,
    extensionVersion: "0.1.0",
    session: {
      id: c.session.id,
      userId: c.session.userId,
      channelId: c.session.channelId,
    },
  };
};
