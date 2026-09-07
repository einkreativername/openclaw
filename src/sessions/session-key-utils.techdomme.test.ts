// Tests for the techdomme channel-id helper added to session-key-utils.
//
// Keeps the new helper's test coverage adjacent to its definition so the
// project structure stays predictable.

import { describe, expect, it } from "vitest";
import { parseTechdommeChannelIdFromSessionKey } from "./session-key-utils.js";

describe("parseTechdommeChannelIdFromSessionKey", () => {
  it("returns the channel name for an agent-shaped channel key", () => {
    expect(parseTechdommeChannelIdFromSessionKey("agent:ops:discord:channel:42")).toBe("discord");
    expect(parseTechdommeChannelIdFromSessionKey("agent:ops:telegram:direct:user1")).toBe("telegram");
  });

  it("returns null for the main session key", () => {
    expect(parseTechdommeChannelIdFromSessionKey("main")).toBeNull();
    expect(parseTechdommeChannelIdFromSessionKey("agent:ops:main")).toBeNull();
  });

  it("returns null for cron, acp, and subagent scopes", () => {
    expect(parseTechdommeChannelIdFromSessionKey("agent:ops:cron:job-1:run:abc")).toBeNull();
    expect(parseTechdommeChannelIdFromSessionKey("agent:ops:acp:foo")).toBeNull();
    expect(parseTechdommeChannelIdFromSessionKey("agent:ops:subagent:depth-1")).toBeNull();
  });

  it("returns null for empty / undefined / non-agent-shaped input", () => {
    expect(parseTechdommeChannelIdFromSessionKey(undefined)).toBeNull();
    expect(parseTechdommeChannelIdFromSessionKey(null)).toBeNull();
    expect(parseTechdommeChannelIdFromSessionKey("")).toBeNull();
    expect(parseTechdommeChannelIdFromSessionKey("discord:channel:42")).toBeNull();
  });
});
