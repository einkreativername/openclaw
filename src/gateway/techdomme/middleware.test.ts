// Vitest tests for the techdomme session-start middleware.

import { describe, expect, it } from "vitest";
import { InMemoryTechdommeActivationProvider } from "./provider.js";
import {
  attachTechdommeContextToSession,
  resolveAndAttachTechdommeContext,
} from "./middleware.js";

function newSession(overrides: Partial<{ id: string; userId: string; channelId: string }> = {}) {
  return {
    id: overrides.id ?? "session-1",
    userId: overrides.userId ?? "user-1",
    channelId: overrides.channelId ?? "channel-A",
  };
}

describe("attachTechdommeContextToSession", () => {
  it("attaches a 'user' mode when the user pref is enabled", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true, "de");

    const session = newSession();
    const out = await attachTechdommeContextToSession(session, { provider, auditProvider: provider });

    expect(out.techdomme).toEqual({
      active: true,
      source: "user",
      locale: "de",
      reason: undefined,
      version: expect.any(Number),
    });
  });

  it("attaches a 'channel' mode when the channel override is set", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setChannelOverride("channel-A", true);

    const session = newSession();
    const out = await attachTechdommeContextToSession(session, { provider, auditProvider: provider });

    expect(out.techdomme).toMatchObject({ active: true, source: "channel" });
  });

  it("attaches an 'off' mode when no pref and no override exist", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const session = newSession();
    const out = await attachTechdommeContextToSession(session, { provider, auditProvider: provider });

    expect(out.techdomme).toMatchObject({ active: false, source: "off" });
  });

  it("is idempotent — re-attaching returns the same context", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true);

    const session = newSession();
    const first = await attachTechdommeContextToSession(session, { provider, auditProvider: provider });
    const second = await attachTechdommeContextToSession(first, { provider, auditProvider: provider });

    expect(second.techdomme).toEqual(first.techdomme);
  });

  it("writes exactly one audit row per session start", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true);

    const session = newSession();
    await attachTechdommeContextToSession(session, { provider, auditProvider: provider });

    expect(provider.activationLog).toHaveLength(1);
    expect(provider.activationLog[0]).toMatchObject({
      userId: "user-1",
      channelId: "channel-A",
      sessionId: "session-1",
      modeSource: "user",
    });
  });

  it("audit write failure is logged but does not throw", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    const auditProvider: typeof provider = {
      ...provider,
      async recordActivation() {
        throw new Error("audit table locked");
      },
    };

    // Silence the expected warn() so the test output stays clean.
    const originalWarn = console.warn;
    let warned = false;
    console.warn = (msg: string) => {
      if (msg.includes("[techdomme] failed to record activation row")) warned = true;
    };
    try {
      const session = newSession();
      const out = await attachTechdommeContextToSession(session, {
        provider,
        auditProvider,
      });
      expect(out.techdomme).toBeDefined();
      expect(warned).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("fails closed when the resolver throws (provider error)", async () => {
    const provider: import("./provider.js").TechdommeActivationProvider = {
      async getUserPref() {
        throw new Error("db down");
      },
      async getChannelOverride() {
        throw new Error("db down");
      },
      async setUserPref() {
        throw new Error("not used");
      },
      async setChannelOverride() {
        throw new Error("not used");
      },
      async recordActivation() {
        // no-op
      },
    };

    const session = newSession();
    const out = await attachTechdommeContextToSession(session, { provider, auditProvider: provider });

    expect(out.techdomme).toMatchObject({
      active: false,
      source: "off",
      reason: expect.stringContaining("activation_error"),
    });
  });
});

describe("resolveAndAttachTechdommeContext", () => {
  it("returns both the augmented session and the resolved mode", async () => {
    const provider = new InMemoryTechdommeActivationProvider();
    await provider.setUserPref("user-1", true, "fr");

    const session = newSession();
    const { session: out, mode } = await resolveAndAttachTechdommeContext(session, {
      provider,
      auditProvider: provider,
    });

    expect(out.techdomme).toEqual({
      active: true,
      source: "user",
      locale: "fr",
      reason: undefined,
      version: mode.version,
    });
    expect(mode).toMatchObject({ active: true, source: "user", locale: "fr" });
  });
});
