// Techdomme admin RPC handlers. Two methods:
//
//   - techdomme.setUserPref({ userId, enabled, locale? })
//   - techdomme.setChannelOverride({ channelId, enabled | null })
//
// Both methods:
//   1. Validate the input (user/channel id non-empty, enabled is boolean).
//   2. Call the provider's setUserPref / setChannelOverride.
//   3. Invalidate the resolver cache so the next session for that
//      user/channel reflects the new state.
//
// Integration point (openclaw-server-specific): the openclaw server-aux
// handler file (`src/gateway/server-aux-handlers.ts`) exports a
// `GatewayRequestHandlers` map. Add `techdomme` handlers by importing
// the helper functions here and wrapping them in handler-shaped async
// functions. A future implementation commit will do that one-line
// integration.
//
// This file is intentionally a pure module with no transport code, so
// the openclaw server integration can be a thin shim.

import {
  InMemoryTechdommeActivationProvider,
  KyselyTechdommeActivationProvider,
  type TechdommeActivationProvider,
  type UserTechdommePref,
  type ChannelTechdommeOverride,
} from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";

export type SetUserPrefInput = {
  userId: string;
  enabled: boolean;
  locale?: string;
};

export type SetUserPrefResult = {
  pref: UserTechdommePref;
};

export type SetChannelOverrideInput = {
  channelId: string;
  // `null` clears the override (inherit user default).
  enabled: boolean | null;
};

export type SetChannelOverrideResult = {
  override: ChannelTechdommeOverride;
};

export type TechdommeRpcError = {
  code: "invalid_request" | "internal_error";
  message: string;
};

export class TechdommeRpcValidationError extends Error {
  readonly code = "invalid_request" as const;
  constructor(message: string) {
    super(message);
    this.name = "TechdommeRpcValidationError";
  }
}

/**
 * Set the techdomme user pref. Validates the input, calls the provider,
 * invalidates the resolver cache, returns the updated row.
 */
export async function setUserPref(
  input: SetUserPrefInput,
  deps: {
    provider?: TechdommeActivationProvider;
    resolver?: TechdommeActivationResolver;
  } = {},
): Promise<SetUserPrefResult> {
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    throw new TechdommeRpcValidationError("userId is required");
  }
  if (typeof input.enabled !== "boolean") {
    throw new TechdommeRpcValidationError("enabled must be a boolean");
  }

  const provider = deps.provider ?? new InMemoryTechdommeActivationProvider();
  const resolver =
    deps.resolver ?? new TechdommeActivationResolver(provider, "en");

  const pref = await provider.setUserPref(input.userId, input.enabled, input.locale);

  // Invalidate every cached entry for this user (across all channels).
  resolver.invalidateUser(input.userId);

  return { pref };
}

/**
 * Set the techdomme channel override. `enabled: null` clears the override
 * (channel falls back to the user default).
 */
export async function setChannelOverride(
  input: SetChannelOverrideInput,
  deps: {
    provider?: TechdommeActivationProvider;
    resolver?: TechdommeActivationResolver;
  } = {},
): Promise<SetChannelOverrideResult> {
  if (typeof input.channelId !== "string" || input.channelId.length === 0) {
    throw new TechdommeRpcValidationError("channelId is required");
  }
  if (input.enabled !== null && typeof input.enabled !== "boolean") {
    throw new TechdommeRpcValidationError("enabled must be a boolean or null");
  }

  const provider = deps.provider ?? new InMemoryTechdommeActivationProvider();
  const resolver =
    deps.resolver ?? new TechdommeActivationResolver(provider, "en");

  const override = await provider.setChannelOverride(input.channelId, input.enabled);

  // Invalidate every cached entry for this channel (across all users).
  resolver.invalidateChannel(input.channelId);

  return { override };
}

// Re-exports for callers.
export type {
  TechdommeActivationProvider,
  UserTechdommePref,
  ChannelTechdommeOverride,
};
export { KyselyTechdommeActivationProvider, InMemoryTechdommeActivationProvider };
