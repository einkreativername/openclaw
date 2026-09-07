// Vitest tests for the Techdomme activation resolver.
//
// Covers the 4 activation combinations from the spec §0.2:
//   1. no user row, no channel row
//   2. user-set, no channel row
//   3. no user row, channel override set
//   4. user-set, channel override set (override wins)
//
// Plus:
//   - cache hit / miss
//   - error fallback (provider throws -> fail-closed)
//   - invalidate paths

import { describe, expect, it } from "vitest";
import {
  InMemoryTechdommeActivationProvider,
  type TechdommeActivationProvider,
} from "./provider.js";
import { TechdommeActivationResolver } from "./activation.js";

function newResolver(provider: TechdommeActivationProvider) {
  return new TechdommeActivationResolver(provider, "en");
}

describe("TechdommeActivationResolver", () => {
  it("returns off when no user pref and no channel override exist", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({ active: false, source: "off" });
  });

  it("returns user-source active when the user pref is enabled", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true, "de");
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({
      active: true,
      source: "user",
      locale: "de",
    });
  });

  it("returns user-source inactive when the user pref is disabled", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", false, "en");
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({ active: false, source: "user" });
  });

  it("returns channel-source when the channel override is set and user pref is absent", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setChannelOverride("channel-A", true);
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({ active: true, source: "channel" });
  });

  it("channel override wins over user pref when both are set", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true, "en");
    await provider.setChannelOverride("channel-A", false);
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({ active: false, source: "channel" });
  });

  it("channel override = NULL inherits the user pref", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true, "fr");
    await provider.setChannelOverride("channel-A", null);
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({ active: true, source: "user", locale: "fr" });
  });

  it("caches the result and returns the same value on subsequent calls", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true);
    const resolver = newResolver(provider);

    const first = await resolver.resolve("user-1", "channel-A");
    // Mutate the provider after the first resolve; cache should still serve the old value.
    await provider.setUserPref("user-1", false);
    const second = await resolver.resolve("user-1", "channel-A");

    expect(first).toMatchObject({ active: true, source: "user" });
    expect(second).toMatchObject({ active: true, source: "user" });
  });

  it("re-reads after cache TTL expires", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true);
    let now = 1_000_000;
    const resolver = new TechdommeActivationResolver(provider, "en");

    const first = await resolver.resolve("user-1", "channel-A", {
      now: () => now,
      ttlMs: 1000,
    });
    now += 2000; // jump past the TTL
    await provider.setUserPref("user-1", false);
    const second = await resolver.resolve("user-1", "channel-A", {
      now: () => now,
      ttlMs: 1000,
    });

    expect(first.active).toBe(true);
    expect(second.active).toBe(false);
  });

  it("fails closed when the provider throws", async () => {
    const provider: TechdommeActivationProvider = {
      async getUserPref() {
        throw new Error("db unreachable");
      },
      async getChannelOverride() {
        throw new Error("db unreachable");
      },
      async setUserPref() {
        throw new Error("not used");
      },
      async setChannelOverride() {
        throw new Error("not used");
      },
      async recordActivation() {
        throw new Error("not used");
      },
    };
    const resolver = newResolver(provider);

    const mode = await resolver.resolve("user-1", "channel-A");

    expect(mode).toMatchObject({
      active: false,
      source: "off",
      reason: expect.stringContaining("activation_error"),
    });
  });

  it("invalidate(user, channel) clears only that entry", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true);
    await provider.setUserPref("user-2", true);
    const resolver = newResolver(provider);

    await resolver.resolve("user-1", "channel-A");
    await resolver.resolve("user-2", "channel-A");
    resolver.invalidate("user-1", "channel-A");
    await provider.setUserPref("user-1", false);
    await provider.setUserPref("user-2", false);

    const a = await resolver.resolve("user-1", "channel-A", { bypassCache: true });
    const b = await resolver.resolve("user-2", "channel-A", { bypassCache: true });
    expect(a.active).toBe(false);
    expect(b.active).toBe(false);
  });

  it("invalidateUser clears all entries for that user across channels", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true);
    const resolver = newResolver(provider);

    await resolver.resolve("user-1", "channel-A");
    await resolver.resolve("user-1", "channel-B");
    resolver.invalidateUser("user-1");
    await provider.setUserPref("user-1", false);

    const a = await resolver.resolve("user-1", "channel-A", { bypassCache: true });
    const b = await resolver.resolve("user-1", "channel-B", { bypassCache: true });
    expect(a.active).toBe(false);
    expect(b.active).toBe(false);
  });
});
