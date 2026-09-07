// Openclaw server-side integration helpers for the techdomme gateway-skin.
//
// These helpers bridge between the openclaw server's data shapes (session
// entry, websocket client, runtime config) and the techdomme middleware's
// pure-function interface. They are pure: no side effects beyond the
// audit-log write that the middleware performs.
//
// The actual call-site for `wireTechdommeIntoSessionCreate` is the
// `sessions.create` handler in
// `src/gateway/server-methods/sessions-create.ts`. The handler is a 700+
// line state machine; the wire-in is a 5-line try/catch before the final
// `respond(true, { ... })` call. See the bottom of this file for the
// exact snippet.
//
// Channel resolution: the openclaw session-key naming carries channel
// information when the session is bound to a channel (e.g. a Discord
// channel, a Telegram chat). For DM sessions, `channelId` is `null` and
// the resolver falls back to the user-default activation. The wire-in
// extracts the channel id from the session key when the key is shaped
// like "<agent>:<channel>" and leaves it null otherwise.

import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  attachTechdommeContextToSession,
  type TechdommeAttachableSession,
  type TechdommeSessionContext,
} from "./middleware.js";
import {
  InMemoryTechdommeActivationProvider,
  type TechdommeActivationProvider,
} from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";

/**
 * Openclaw-shaped input for the wire-in. All fields are required by the
 * caller (the integration site), but `channelId` may be `null` to indicate
 * a DM session (no channel binding).
 */
export type OpenClawTechdommeWireInput = {
  session: Pick<InternalSessionEntry, "sessionId"> & {
    // The session key, e.g. "agent:discord:channel:123" or "main".
    key: string;
    // The user who owns the session, in openclaw's identity shape.
    userId: string;
    // The channel, when the session is channel-bound. `null` for DMs.
    channelId: string | null;
  };
  // A provider. In production this is the Kysely-backed one wired to the
  // gateway's DatabaseSync. Tests pass the in-memory variant.
  provider?: TechdommeActivationProvider;
  // Override the extension version string recorded in the audit row.
  extensionVersion?: string;
  // Override the clock for tests.
  nowMs?: () => number;
};

/**
 * Build a TechdommeAttachableSession from openclaw's session + user +
 * channel triple. The middleware reads this object directly.
 */
function buildAttachableSession(input: OpenClawTechdommeWireInput): TechdommeAttachableSession {
  return {
    id: input.session.sessionId,
    userId: input.session.userId,
    // channelId null is meaningful: the resolver's "channel null -> inherit
    // user default" path is the correct semantics for DM sessions.
    channelId: input.session.channelId ?? "",
  };
}

/**
 * Wire the techdomme context into a freshly-created openclaw session. Call
 * this from inside the `sessions.create` handler, AFTER the session has
 * been persisted (`created.entry.sessionId` is available) and BEFORE the
 * final `respond(true, ...)` returns the result to the caller.
 *
 * Failure mode: any error is caught and logged as a warning. The session
 * is not affected. The user can still opt in to techdomme on the next
 * session start.
 *
 * Returns the resolved mode for callers that want to log the decision
 * directly (e.g. emit it as a `sessions.changed` event payload).
 */
export async function wireTechdommeIntoSessionCreate(
  input: OpenClawTechdommeWireInput,
): Promise<TechdommeSessionContext> {
  if (!input.provider) {
    // Wire-in sites must construct or look up a provider at boot. The
    // recommended pattern is `createTechdommeSingletons(db)` once in the
    // gateway boot and pass the returned provider here. We do not
    // silently fall back to a no-op in-memory provider because that
    // would make the techdomme state invisible to the rest of the
    // gateway and produce surprising results on a production deploy.
    throw new Error(
      "wireTechdommeIntoSessionCreate: input.provider is required. " +
        "Construct one via createTechdommeSingletons(openclawStateDb) at " +
        "gateway boot and pass the returned provider in.",
    );
  }
  const provider = input.provider;
  const resolver = new TechdommeActivationResolver(
    provider,
    (input.session.channelId ? inferLocaleFromChannel(input.session.channelId) : "en"),
  );
  const session = buildAttachableSession(input);
  const augmented = await attachTechdommeContextToSession(session, {
    provider,
    resolver,
    auditProvider: provider,
    extensionVersion: input.extensionVersion,
    nowMs: input.nowMs,
  });
  // The middleware writes techdomme in place. We return that snapshot so
  // callers can include it in their RPC response payload if desired.
  return augmented.techdomme!;
}

/**
 * Infer a locale hint from a channel id. This is a best-effort fallback
 * for the case where the openclaw user pref has no row yet. The first
 * session for a new user defaults to "en" unless the channel id carries
 * a recognized locale marker (e.g. "channel-de-123" -> "de").
 */
function inferLocaleFromChannel(channelId: string): string {
  const match = channelId.match(/(?:^|[^a-z])(de|fr|es|it|ja|zh|ko|en)(?:$|[^a-z])/i);
  return match ? match[1].toLowerCase() : "en";
}

// Re-export so the wire-in file is the only import the openclaw server
// needs to know about. The actual pure module can stay internal to the
// techdomme package.
export { InMemoryTechdommeActivationProvider };
export type { TechdommeActivationProvider, TechdommeSessionContext };

/* -----------------------------------------------------------------------
 * EXACT CALL-SITE SNIPPET for src/gateway/server-methods/sessions-create.ts
 * -----------------------------------------------------------------------
 *
 * Inside the `sessions.create` handler, immediately before the final
 * `respond(true, { ... })` call (the one that returns the create result
 * to the caller), add:
 *
 *   // Techdomme gateway-skin (Spec 0): attach the activation context
 *   // so the extension entry point can read `session.techdomme.active`
 *   // on the first turn. Best-effort: any failure is logged + ignored.
 *   let techdomme: TechdommeSessionContext | undefined;
 *   try {
 *     techdomme = await wireTechdommeIntoSessionCreate({
 *       session: {
 *         sessionId: created.entry.sessionId,
 *         key: created.key,
 *         userId: client?.connect?.userId ?? "anonymous",
 *         channelId: parseChannelIdFromSessionKey(created.key),
 *       },
 *       provider: techdommeProvider, // gateway-boot-populated singleton
 *       extensionVersion: "0.1.0",
 *     });
 *   } catch (err) {
 *     // The activation resolver already fails closed; we just log.
 *     console.warn("[techdomme] session-start attach failed", err);
 *   }
 *
 * Then include `techdomme` in the respond payload if defined:
 *
 *   respond(true, {
 *     ...,
 *     ...(techdomme ? { techdomme } : {}),
 *   });
 *
 * Required top-of-file imports (add next to the existing `import` block):
 *
 *   import { wireTechdommeIntoSessionCreate } from "../techdomme/integration.js";
 *   import type { TechdommeSessionContext } from "../techdomme/middleware.js";
 *   import { techdommeProvider } from "../techdomme/gateway-singleton.js";
 *   // parseChannelIdFromSessionKey lives in src/routing/session-key.js
 *   // (existing helper). If absent, return null for DM sessions.
 *
 * The `techdommeProvider` singleton is the gateway-boot-populated
 * KyselyTechdommeActivationProvider wired to the openclaw DatabaseSync.
 * See `src/gateway/techdomme/gateway-singleton.ts` for the wiring helper.
 *
 * Channel id parsing: openclaw session keys for channel-bound sessions
 * have the form "<agent>:<channel-kind>:<channel-id>". For DMs the
 * channel-kind segment is absent. The exact parser belongs in
 * src/routing/session-key.js; if it is not exposed there yet, add it as
 * `parseChannelIdFromSessionKey(key: string): string | null`.
 *
 * The wire-in is intentionally a try/catch: the openclaw session-create
 * pipeline must continue working even if the techdomme database is
 * unreachable. The middleware's own fail-closed behavior covers the
 * resolver path; this try/catch is belt-and-suspenders.
 * --------------------------------------------------------------------- */
