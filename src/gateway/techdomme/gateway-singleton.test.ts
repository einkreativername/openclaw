// Tests for the techdomme gateway-boot singleton helper.
//
// Note: the singleton lazy-initializes on first access. We do not
// exercise that lazy init here because it would open the real (or
// in-memory) sqlite database. The full boot path is covered by the
// integration + E2E tests in a follow-up commit. This file covers
// the public surface of the helper without triggering the lazy init.

import { describe, expect, it } from "vitest";
import { getTechdommeSingletons, initTechdommeSingletons } from "./gateway-singleton.js";

describe("gateway-singleton surface", () => {
  it("initTechdommeSingletons and getTechdommeSingletons are both exported as functions", () => {
    expect(typeof initTechdommeSingletons).toBe("function");
    expect(typeof getTechdommeSingletons).toBe("function");
  });
});
