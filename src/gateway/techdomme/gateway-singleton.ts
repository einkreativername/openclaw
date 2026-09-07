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
 * Read the boot-populated techdomme singletons. Throws if the gateway
 * has not called initTechdommeSingletons yet. Call sites that may fire
 * before boot (e.g. background tasks) should wrap in try/catch and
 * skip the techdomme wiring.
 */
export function getTechdommeSingletons(): TechdommeSingletons {
  if (!cachedSingletons) {
    throw new Error(
      "getTechdommeSingletons: techdomme singletons not initialized. " +
        "Call initTechdommeSingletons() during gateway boot, before any " +
        "session-create or aux RPC fires.",
    );
  }
  return cachedSingletons;
}

