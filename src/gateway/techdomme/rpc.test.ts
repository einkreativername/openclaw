// Vitest tests for the techdomme admin RPC handlers.

import { describe, expect, it } from "vitest";
import { InMemoryTechdommeActivationProvider } from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";
import {
  setUserPref,
  setChannelOverride,
  TechdommeRpcValidationError,
} from "./rpc.js";

describe("setUserPref", () => {
  it("writes the user pref and returns the updated row", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");

    const result = await setUserPref(
      { userId: "user-1", enabled: true, locale: "de" },
      { provider, resolver },
    );

    expect(result.pref).toEqual({ userId: "user-1", techdommeEnabled: true, locale: "de" });
    const stored = await provider.getUserPref("user-1");
    expect(stored).toEqual(result.pref);
  });

  it("invalidates the resolver cache for the user", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");
    await provider.setUserPref("user-1", false);

    // Warm the cache.
    await resolver.resolve("user-1", "channel-A");

    // Flip the pref, then call setUserPref which should invalidate.
    const result = await setUserPref(
      { userId: "user-1", enabled: true },
      { provider, resolver },
    );
    expect(result.pref.techdommeEnabled).toBe(true);

    // Next resolve should see the new value.
    const mode = await resolver.resolve("user-1", "channel-A", { bypassCache: true });
    expect(mode).toMatchObject({ active: true, source: "user" });
  });

  it("rejects empty userId", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");
    await expect(
      setUserPref({ userId: "", enabled: true }, { provider, resolver }),
    ).rejects.toBeInstanceOf(TechdommeRpcValidationError);
  });

  it("rejects non-boolean enabled", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");
    await expect(
      // @ts-expect-error: intentionally wrong type
      setUserPref({ userId: "user-1", enabled: "yes" }, { provider, resolver }),
    ).rejects.toBeInstanceOf(TechdommeRpcValidationError);
  });

  it("defaults locale to 'en' when omitted", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");

    const result = await setUserPref(
      { userId: "user-1", enabled: true },
      { provider, resolver },
    );

    expect(result.pref.locale).toBe("en");
  });
});

describe("setChannelOverride", () => {
  it("writes the channel override and returns the updated row", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");

    const result = await setChannelOverride(
      { channelId: "channel-A", enabled: true },
      { provider, resolver },
    );

    expect(result.override).toEqual({ channelId: "channel-A", techdommeEnabled: true });
    const stored = await provider.getChannelOverride("channel-A");
    expect(stored).toEqual(result.override);
  });

  it("null clears the override", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");

    const result = await setChannelOverride(
      { channelId: "channel-A", enabled: null },
      { provider, resolver },
    );

    expect(result.override.techdommeEnabled).toBeNull();
  });

  it("invalidates the resolver cache for the channel", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");
    await provider.setUserPref("user-1", true);

    // Warm the cache.
    await resolver.resolve("user-1", "channel-A");

    // Set an override that turns the user pref off, then resolve again
    // (cache invalidated by setChannelOverride).
    await setChannelOverride(
      { channelId: "channel-A", enabled: false },
      { provider, resolver },
    );

    const mode = await resolver.resolve("user-1", "channel-A", { bypassCache: true });
    expect(mode).toMatchObject({ active: false, source: "channel" });
  });

  it("rejects empty channelId", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");
    await expect(
      setChannelOverride({ channelId: "", enabled: true }, { provider, resolver }),
    ).rejects.toBeInstanceOf(TechdommeRpcValidationError);
  });

  it("rejects non-boolean / non-null enabled", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = new TechdommeActivationResolver(provider, "en");
    await expect(
      // @ts-expect-error: intentionally wrong type
      setChannelOverride({ channelId: "channel-A", enabled: 1 }, { provider, resolver }),
    ).rejects.toBeInstanceOf(TechdommeRpcValidationError);
  });
});
