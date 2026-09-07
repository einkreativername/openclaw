import { describe, expect, it } from "vitest";
import { renderPersonaOverlay, wrapPersona } from "./apply.js";

describe("techdomme persona overlay", () => {
  it("renders the requested locale when its .md file exists", async () => {
    const out = await renderPersonaOverlay({ locale: "en" });
    expect(out.resolvedLocale).toBe("en");
    expect(out.block).toMatch(/^<techdomme-persona locale="en" version="0\.1\.0">/);
    expect(out.block).toMatch(/<\/techdomme-persona>$/);
  });

  it("falls back to en.md when the requested locale is missing", async () => {
    const out = await renderPersonaOverlay({ locale: "fr" });
    expect(out.resolvedLocale).toBe("en");
  });

  it("falls back to en.md when the locale is empty", async () => {
    const out = await renderPersonaOverlay({ locale: "" });
    expect(out.resolvedLocale).toBe("en");
  });

  it("renders the German locale when present", async () => {
    const out = await renderPersonaOverlay({ locale: "de" });
    expect(out.resolvedLocale).toBe("de");
  });

  it("throws when even the en.md fallback is missing", async () => {
    await expect(renderPersonaOverlay({ locale: "klingon" })).rejects.toThrow(
      /no \.md file found/,
    );
  });
});

describe("wrapPersona", () => {
  it("wraps the text in a labeled block and trims trailing whitespace", () => {
    const wrapped = wrapPersona("  hello world  \n\n", "en", "1.2.3");
    expect(wrapped).toBe(
      '<techdomme-persona locale="en" version="1.2.3">\nhello world\n</techdomme-persona>',
    );
  });
});
