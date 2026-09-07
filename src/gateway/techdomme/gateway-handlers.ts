// Openclaw gateway admin RPC handlers for the techdomme gateway-skin.
//
// `techdommeSetUserPref` and `techdommeSetChannelOverride` are 3-line
// shims over the pure `setUserPref` / `setChannelOverride` functions in
// rpc.ts. They map validation errors to the openclaw error shape and
// pass the result back to the gateway.
//
// To register these handlers, add the following lines to
// `src/gateway/server-aux-handlers.ts`'s `createGatewayAuxHandlers` body,
// or wherever the existing `GatewayRequestHandlers` are assembled:
//
//   import { techdommeAuxHandlers } from "./techdomme/gateway-handlers.js";
//   const auxHandlers: GatewayRequestHandlers = {
//     ...existing,
//     ...techdommeAuxHandlers(techdommeProvider, techdommeResolver),
//   };
//
// The `techdommeProvider` and `techdommeResolver` are the gateway-boot
// singletons created in `gateway-singleton.ts`.

import {
  setUserPref as setUserPrefPure,
  setChannelOverride as setChannelOverridePure,
  TechdommeRpcValidationError,
} from "./rpc.js";
import type { TechdommeActivationProvider } from "./provider.js";
import type { TechdommeActivationResolver } from "./activation.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "../server-methods/types.js";

export function techdommeAuxHandlers(
  provider: TechdommeActivationProvider,
  resolver: TechdommeActivationResolver,
): GatewayRequestHandlers {
  return {
    "techdomme.setUserPref": async ({ params, respond }) => {
      try {
        const result = await setUserPrefPure(
          {
            userId: String(params?.userId ?? ""),
            enabled: Boolean(params?.enabled),
            locale:
              typeof params?.locale === "string" ? params.locale : undefined,
          },
          { provider, resolver },
        );
        respond(true, { pref: result.pref });
      } catch (err) {
        respond(
          false,
          undefined,
          err instanceof TechdommeRpcValidationError
            ? errorShape(ErrorCodes.INVALID_REQUEST, err.message)
            : errorShape(
                ErrorCodes.INTERNAL,
                err instanceof Error ? err.message : String(err),
              ),
        );
      }
    },

    "techdomme.setChannelOverride": async ({ params, respond }) => {
      try {
        const result = await setChannelOverridePure(
          {
            channelId: String(params?.channelId ?? ""),
            enabled:
              params?.enabled === null
                ? null
                : params?.enabled === undefined
                  ? null
                  : Boolean(params.enabled),
          },
          { provider, resolver },
        );
        respond(true, { override: result.override });
      } catch (err) {
        respond(
          false,
          undefined,
          err instanceof TechdommeRpcValidationError
            ? errorShape(ErrorCodes.INVALID_REQUEST, err.message)
            : errorShape(
                ErrorCodes.INTERNAL,
                err instanceof Error ? err.message : String(err),
              ),
        );
      }
    },
  };
}
