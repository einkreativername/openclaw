import { describe, expect, it } from "vitest";
import { applyHookOriginMarker, normalizeHookOrigin, resolveHookOrigin } from "./hooks.js";

describe("hook origin tagging", () => {
  it("normalizes origin slugs", () => {
    expect(normalizeHookOrigin(" GrokBot ")).toBe("grokbot");
    expect(normalizeHookOrigin("bad origin")).toBeUndefined();
    expect(normalizeHookOrigin("")).toBeUndefined();
  });

  it("resolves JSON origin over missing header", () => {
    expect(resolveHookOrigin({ payload: { origin: "grokbot" }, headers: {} })).toBe("grokbot");
  });

  it("resolves x-openclaw-origin header", () => {
    expect(
      resolveHookOrigin({
        payload: {},
        headers: { "x-openclaw-origin": "grokbot" },
      }),
    ).toBe("grokbot");
  });

  it("prepends marker idempotently", () => {
    const once = applyHookOriginMarker("hello", "grokbot");
    expect(once.startsWith("[[openclaw-origin:grokbot]]")).toBe(true);
    expect(applyHookOriginMarker(once, "grokbot")).toBe(once);
  });
});
