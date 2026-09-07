/**
 * Techdomme persona overlay. Reads the locale-specific .md file, falls back
 * to en.md, wraps in a labeled XML block, and hands the block to the openclaw
 * SDK to prepend to the active agent's system prompt.
 *
 * The actual SDK call (`ctx.systemPrompt.prepend(...)` or equivalent) is left
 * as a TODO until the SDK exposes a stable hook. Until then the function
 * returns the rendered overlay string so callers can verify content; the
 * extension entry point logs a warning if the SDK hook is unavailable.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type PersonaOverlayInput = {
  locale: string;
  version?: string;
  log?: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
};

export type PersonaOverlayOutput = {
  // The XML-wrapped persona block, ready to be prepended to a system prompt.
  block: string;
  // The locale that was actually used (may be the fallback if the requested
  // locale was missing).
  resolvedLocale: string;
};

export async function renderPersonaOverlay(
  input: PersonaOverlayInput,
): Promise<PersonaOverlayOutput> {
  const requested = input.locale || "en";
  const candidates = [requested, "en"];
  let lastError: unknown = null;

  for (const locale of candidates) {
    const path = resolve(__dirname, `${locale}.md`);
    try {
      const text = await readFile(path, "utf8");
      const block = wrapPersona(text, locale, input.version ?? "0.1.0");
      return { block, resolvedLocale: locale };
    } catch (err) {
      lastError = err;
      // try the next candidate
    }
  }

  throw new Error(
    `techdomme persona overlay: no .md file found for locale '${requested}' (last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`,
  );
}

function wrapPersona(text: string, locale: string, version: string): string {
  const trimmed = text.trim();
  return (
    `<techdomme-persona locale="${locale}" version="${version}">\n` +
    `${trimmed}\n` +
    `</techdomme-persona>`
  );
}

/**
 * Apply the persona overlay to the active agent's system prompt.
 *
 * The SDK surface for system-prompt mutation is not yet stable in the version
 * of openclaw this extension ships against. Until it is, the function:
 *   1. Renders the persona block.
 *   2. Logs the resolved locale (or a warning on miss).
 *   3. Returns the rendered block so the entry point can verify it.
 *
 * The actual `ctx.systemPrompt.prepend(block)` call is a one-liner once the
 * SDK exposes the hook. A TODO(sdk-hook) comment marks the call site.
 */
export async function applyPersonaOverlay(input: PersonaOverlayInput): Promise<PersonaOverlayOutput> {
  const rendered = await renderPersonaOverlay(input);

  // TODO(sdk-hook): call ctx.systemPrompt.prepend(rendered.block) when the
  // openclaw SDK exposes a stable system-prompt mutation hook. Until then we
  // log and return so the entry point can verify content was loaded.
  if (input.log) {
    input.log.info("techdomme persona overlay rendered", {
      resolvedLocale: rendered.resolvedLocale,
      blockLength: rendered.block.length,
    });
  }

  return rendered;
}
