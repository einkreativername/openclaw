// Techdomme session-start middleware.
//
// Reads (userId, channelId) from an incoming session-start event, calls the
// activation resolver, attaches a TechdommeSessionContext to the session
// object, and writes one row to the audit log. Returns the augmented session.
//
// Integration point (openclaw-server-specific): the openclaw server has a
// session-start lifecycle that lives in `src/gateway/server.sessions.*` and
// `src/gateway/server-aux-handlers.ts`. To wire the middleware in, call
// `attachTechdommeContextToSession(...)` from the right hook. A future
// implementation will integrate via one of:
//
//   1. A new entry in `server-aux-handlers.ts` that the session-start RPC
//      calls before any agent dispatch (preferred).
//   2. A side-effecting import in the appropriate session lifecycle module.
//
// Both options are documented below. For now, this file is intentionally a
// pure module that the wiring code can call.
//
// Failure modes (spec §0.4):
//   - Provider error -> the resolver already fails closed. We still write
//     an audit row with modeSource="off" + reason="activation_error".
//   - Audit log write fails -> log a warning. The session still proceeds
//     with the (off) techdomme context.

import {
  InMemoryTechdommeActivationProvider,
  KyselyTechdommeActivationProvider,
  type TechdommeActivationProvider,
  type UserTechdommePref,
  type ChannelTechdommeOverride,
} from "./provider.js";
import { TechdommeActivationResolver, type TechdommeMode } from "./activation.js";

export type TechdommeSessionContext = {
  active: boolean;
  source: "user" | "channel" | "off";
  reason?: string;
  locale: string;
  version: number;
};

export type TechdommeAttachableSession = {
  id: string;
  userId: string;
  channelId: string;
  // The middleware writes the resolved mode here so downstream consumers
  // (extension entry point, agent dispatch, UI surfaces) can read it.
  // The field is optional so a session can be constructed before the
  // middleware runs; the middleware then augments the object in place.
  techdomme?: TechdommeSessionContext;
};

export type AttachTechdommeContextDeps = {
  provider?: TechdommeActivationProvider;
  resolver?: TechdommeActivationResolver;
  // When provided, audit rows are written via this provider's
  // recordActivation method. When omitted, the middleware still resolves
  // the mode and attaches the context, but skips the audit write.
  auditProvider?: TechdommeActivationProvider;
  // Override the clock for tests.
  nowMs?: () => number;
  // Override the extension version that goes into the audit row.
  extensionVersion?: string;
};

/**
 * Resolve the techdomme mode for a session-start event and attach it to
 * the session object. Also writes one audit row.
 *
 * This function is a no-op if the session already has a `techdomme` context
 * attached (idempotent — call sites can re-invoke safely).
 *
 * Returns the same session object for caller convenience.
 */
export async function attachTechdommeContextToSession<S extends TechdommeAttachableSession>(
  session: S,
  deps: AttachTechdommeContextDeps = {},
): Promise<S> {
  if (session.techdomme) {
    return session;
  }

  const resolver =
    deps.resolver ??
    new TechdommeActivationResolver(
      deps.provider ?? new InMemoryTechdommeActivationProvider(),
      "en",
    );

  const mode: TechdommeMode = await resolver.resolve(
    session.userId,
    session.channelId,
  );

  const ctx: TechdommeSessionContext = {
    active: mode.active,
    source: mode.source,
    reason: mode.reason,
    locale: mode.locale,
    version: mode.version,
  };

  session.techdomme = ctx;

  if (deps.auditProvider) {
    try {
      await deps.auditProvider.recordActivation({
        userId: session.userId,
        channelId: session.channelId,
        sessionId: session.id,
        modeSource: ctx.source,
        reason: ctx.reason,
        extensionVersion: deps.extensionVersion,
        activatedAtMs: (deps.nowMs ?? Date.now)(),
      });
    } catch (err) {
      // best-effort: the audit write is allowed to fail without breaking
      // the session.
      // eslint-disable-next-line no-console
      console.warn(
        "[techdomme] failed to record activation row",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return session;
}

/**
 * Helper for the openclaw server-aux-handlers integration. The full server
 * integration lives in `src/gateway/server-aux-handlers.ts` (a follow-on
 * commit). This helper is a thin convenience that:
 *   1. Resolves and attaches the techdomme context.
 *   2. Returns an object with both the augmented session AND the recorded
 *      mode (for callers that want to log the activation directly).
 */
export async function resolveAndAttachTechdommeContext<S extends TechdommeAttachableSession>(
  session: S,
  deps: AttachTechdommeContextDeps = {},
): Promise<{ session: S; mode: TechdommeMode }> {
  const resolver =
    deps.resolver ??
    new TechdommeActivationResolver(
      deps.provider ?? new InMemoryTechdommeActivationProvider(),
      "en",
    );
  const mode = await resolver.resolve(session.userId, session.channelId);
  await attachTechdommeContextToSession(session, { ...deps, resolver });
  return { session, mode };
}

// Re-export the provider types so callers can wire the real DB-backed
// provider into the middleware without importing the provider module
// directly.
export type {
  TechdommeActivationProvider,
  UserTechdommePref,
  ChannelTechdommeOverride,
};
export { KyselyTechdommeActivationProvider, InMemoryTechdommeActivationProvider };
