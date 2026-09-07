// Gateway-boot singleton helpers for the techdomme gateway-skin.
//
// Creates the long-lived provider + resolver that the rest of the
// gateway uses. The provider is wired to the openclaw DatabaseSync so
// techdomme reads + writes hit the same SQLite database as everything
// else in the gateway.
//
// Integration point: in the openclaw gateway's boot sequence (wherever
// the `KyselyTechdommeActivationProvider` should be instantiated), call
// `createTechdommeSingletons(db)` once and pass the returned
// `{ provider, resolver }` to:
//   - `wireTechdommeIntoSessionCreate(...)` (in the sessions.create handler)
//   - `techdommeAuxHandlers(provider, resolver)` (in the aux-handler map)

import type { DatabaseSync } from "node:sqlite";
import {
  KyselyTechdommeActivationProvider,
  type TechdommeActivationProvider,
} from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";

export type TechdommeSingletons = {
  provider: TechdommeActivationProvider;
  resolver: TechdommeActivationResolver;
};

export function createTechdommeSingletons(db: DatabaseSync): TechdommeSingletons {
  const provider = new KyselyTechdommeActivationProvider(db);
  const resolver = new TechdommeActivationResolver(provider, "en");
  return { provider, resolver };
}
