// Gateway-boot singleton helpers for the techdomme gateway-skin.
//
// `initTechdommeSingletons` opens the openclaw shared state database
// (the process-level singleton, see openOpenClawStateDatabase in
// src/state/openclaw-state-db.ts), wires the
// KyselyTechdommeActivationProvider to it, and caches the (provider,
// resolver) pair. `getTechdommeSingletons` reads from the cache.
//
// Integration point: in the openclaw gateway's boot sequence (the
// place that calls openOpenClawStateDatabase once for the rest of the
// gateway), call `initTechdommeSingletons()` with no arguments. The
// rest of the gateway then reads the singletons via
// `getTechdommeSingletons()`:
//   - `wireTechdommeIntoSessionCreate(...)` in the sessions.create handler
//   - `techdommeAuxHandlers(getTechdommeSingletons().provider, getTechdommeSingletons().resolver)`
//     in the aux-handler map

import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  KyselyTechdommeActivationProvider,
  type TechdommeActivationProvider,
} from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";

export type TechdommeSingletons = {
  provider: TechdommeActivationProvider;
  resolver: TechdommeActivationResolver;
};

let cachedSingletons: TechdommeSingletons | undefined;

/**
 * One-time boot-time initialization. Open the shared openclaw state
 * database and wire the techdomme activation provider + resolver to
 * it. Subsequent calls return the cached singletons.
 */
export function initTechdommeSingletons(): TechdommeSingletons {
  if (cachedSingletons) {
    return cachedSingletons;
  }
  const { db } = openOpenClawStateDatabase();
  const provider = new KyselyTechdommeActivationProvider(db);
  const resolver = new TechdommeActivationResolver(provider, "en");
  cachedSingletons = { provider, resolver };
  return cachedSingletons;
}

/**
 * Read the boot-populated techdomme singletons. Lazy-initializes on
 * first access: the first call opens the shared openclaw state
 * database (via the process-level singleton in
 * src/state/openclaw-state-db.ts) and wires the activation provider +
 * resolver. Subsequent calls return the cached pair.
 *
 * This means the openclaw server does not need an explicit
 * "initTechdommeSingletons" call at boot — the first session-create
 * or first aux RPC triggers the lazy init. Callers that want to
 * warm the singletons at boot can still call `initTechdommeSingletons`
 * explicitly; that function is now a no-op alias for
 * `getTechdommeSingletons` to keep the boot-friendly name in scope.
 */
export function getTechdommeSingletons(): TechdommeSingletons {
  if (!cachedSingletons) {
    return initTechdommeSingletons();
  }
  return cachedSingletons;
}

