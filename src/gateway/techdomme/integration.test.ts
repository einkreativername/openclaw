// Tests for the openclaw server-side integration helpers.

import { describe, expect, it } from "vitest";
import { InMemoryTechdommeActivationProvider } from "./provider.js";
import { wireTechdommeIntoSessionCreate } from "./integration.js";

function makeInput(overrides: {
  userId?: string;
  channelId?: string | null;
  key?: string;
} = {}) {
  return {
    session: {
      sessionId: "session-123",
      key: overrides.key ?? "agent:discord:channel:42",
      userId: overrides.userId ?? "user-1",
      channelId: overrides.channelId === undefined ? "channel-42" : overrides.channelId,
    },
    provider: new InMemoryTechdommeActivationProvider(),
  };
}

describe("wireTechdommeIntoSessionCreate", () => {
  it("attaches an active context when the user pref is enabled", async () => {
    const input = makeInput();
    await input.provider.setUserPref("user-1", true, "de");

    const ctx = await wireTechdommeIntoSessionCreate(input);

    expect(ctx).toMatchObject({ active: true, source: "user", locale: "de" });
  });

  it("attaches a channel-source context when the channel override is set", async () => {
    const input = makeInput({ channelId: "channel-42" });
    await input.provider.setChannelOverride("channel-42", false);

    const ctx = await wireTechdommeIntoSessionCreate(input);

    expect(ctx).toMatchObject({ active: false, source: "channel" });
  });

  it("falls back to user-default when channelId is null (DM session)", async () => {
    const input = makeInput({ channelId: null });
    await input.provider.setUserPref("user-1", true);

    const ctx = await wireTechdommeIntoSessionCreate(input);

    expect(ctx).toMatchObject({ active: true, source: "user" });
  });

  it("returns an off context when no pref and no override exist", async () => {
    const input = makeInput();
    const ctx = await wireTechdommeIntoSessionCreate(input);

    expect(ctx).toMatchObject({ active: false, source: "off" });
  });

  it("writes an audit row on every call", async () => {
    const input = makeInput();
    await wireTechdommeIntoSessionCreate(input);

    expect(input.provider.activationLog).toHaveLength(1);
    expect(input.provider.activationLog[0]).toMatchObject({
      sessionId: "session-123",
      userId: "user-1",
      channelId: "channel-42",
      modeSource: "off",
    });
  });

  it("uses the default locale 'en' when nothing else is known", async () => {
    const input = makeInput({ channelId: null });
    await input.provider.setUserPref("user-1", true); // no locale -> "en"

    const ctx = await wireTechdommeIntoSessionCreate(input);

    expect(ctx.locale).toBe("en");
  });

  it("infers a locale hint from the channel id when the user has no pref", async () => {
    const input = makeInput({ channelId: "channel-de-99", key: "agent:discord:channel:channel-de-99" });
    // No user pref, no channel override -> resolver returns off, but the
    // locale hint should still come from the channel id.
    const ctx = await wireTechdommeIntoSessionCreate(input);

    expect(ctx.locale).toBe("de");
  });
});
