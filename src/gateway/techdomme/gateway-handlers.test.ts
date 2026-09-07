// Tests for the openclaw gateway admin RPC handlers.

import { describe, expect, it } from "vitest";
import { InMemoryTechdommeActivationProvider } from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";
import { techdommeAuxHandlers } from "./gateway-handlers.js";

type MockRespond = (ok: boolean, payload?: unknown, error?: unknown) => void;

function makeHandlerSet() {
  const provider = new InMemoryTechdommeActivationProvider();
  const resolver = new TechdommeActivationResolver(provider, "en");
  const handlers = techdommeAuxHandlers(provider, resolver);
  return { provider, resolver, handlers };
}

function makeCall(
  handlers: ReturnType<typeof techdommeAuxHandlers>,
  method: keyof ReturnType<typeof techdommeAuxHandlers>,
  params: unknown,
) {
  return new Promise<{ ok: boolean; payload: unknown; error: unknown }>((resolve) => {
    const respond: MockRespond = (ok, payload, error) => {
      resolve({ ok, payload, error });
    };
    const handler = handlers[method] as (args: {
      params: unknown;
      respond: MockRespond;
    }) => Promise<void>;
    void handler({ params, respond });
  });
}

describe("techdomme.setUserPref", () => {
  it("writes the user pref and returns the row", async () => {
    const { handlers, provider } = makeHandlerSet();

    const out = await makeCall(handlers, "techdomme.setUserPref", {
      userId: "user-1",
      enabled: true,
      locale: "fr",
    });

    expect(out.ok).toBe(true);
    expect((out.payload as { pref: { userId: string; techdommeEnabled: boolean; locale: string } }).pref).toEqual({
      userId: "user-1",
      techdommeEnabled: true,
      locale: "fr",
    });
    expect(await provider.getUserPref("user-1")).toMatchObject({ locale: "fr" });
  });

  it("rejects an empty userId with INVALID_REQUEST", async () => {
    const { handlers } = makeHandlerSet();

    const out = await makeCall(handlers, "techdomme.setUserPref", {
      userId: "",
      enabled: true,
    });

    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects a non-boolean enabled with INVALID_REQUEST", async () => {
    const { handlers } = makeHandlerSet();

    const out = await makeCall(handlers, "techdomme.setUserPref", {
      userId: "user-1",
      enabled: "yes",
    });

    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("invalidates the resolver cache for the user", async () => {
    const { handlers, resolver, provider } = makeHandlerSet();
    await provider.setUserPref("user-1", false);
    await resolver.resolve("user-1", "channel-A"); // warm cache

    await makeCall(handlers, "techdomme.setUserPref", {
      userId: "user-1",
      enabled: true,
    });

    const mode = await resolver.resolve("user-1", "channel-A", { bypassCache: true });
    expect(mode.active).toBe(true);
  });
});

describe("techdomme.setChannelOverride", () => {
  it("writes the channel override and returns the row", async () => {
    const { handlers, provider } = makeHandlerSet();

    const out = await makeCall(handlers, "techdomme.setChannelOverride", {
      channelId: "channel-A",
      enabled: true,
    });

    expect(out.ok).toBe(true);
    expect((out.payload as { override: { channelId: string; techdommeEnabled: boolean | null } }).override).toEqual({
      channelId: "channel-A",
      techdommeEnabled: true,
    });
    expect(await provider.getChannelOverride("channel-A")).toMatchObject({
      techdommeEnabled: true,
    });
  });

  it("null clears the override", async () => {
    const { handlers, provider } = makeHandlerSet();

    const out = await makeCall(handlers, "techdomme.setChannelOverride", {
      channelId: "channel-A",
      enabled: null,
    });

    expect(out.ok).toBe(true);
    expect((out.payload as { override: { techdommeEnabled: boolean | null } }).override.techdommeEnabled).toBeNull();
    expect(await provider.getChannelOverride("channel-A")).toMatchObject({
      techdommeEnabled: null,
    });
  });

  it("rejects an empty channelId with INVALID_REQUEST", async () => {
    const { handlers } = makeHandlerSet();

    const out = await makeCall(handlers, "techdomme.setChannelOverride", {
      channelId: "",
      enabled: true,
    });

    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
