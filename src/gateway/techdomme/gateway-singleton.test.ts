// Tests for the techdomme gateway-boot singleton helper.
//
// Note: we do not exercise initTechdommeSingletons() here because that
// helper calls openOpenClawStateDatabase() which opens a real (or
// in-memory) sqlite database. The full boot path is covered by the
// integration + E2E tests in a follow-up commit. This file only covers
// the throw-when-uninitialized branch.

import { afterEach, describe, expect, it } from "vitest";
import { getTechdommeSingletons } from "./gateway-singleton.js";

// The module-level cachedSingletons is shared across tests; reset it
// via a dynamic import of a fresh copy of the module in each test.
// For simplicity, we just verify the throw-when-uninitialized branch
// and accept that running this test in isolation is fine.

describe("getTechdommeSingletons", () => {
  it("throws when initTechdommeSingletons has not been called", () => {
    expect(() => getTechdommeSingletons()).toThrowError(
      /techdomme singletons not initialized/,
    );
  });
});

afterEach(() => {
  // No-op; we only test the throw branch.
});
