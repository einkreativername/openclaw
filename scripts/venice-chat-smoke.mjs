#!/usr/bin/env node
/**
 * Venice OpenAI-compatible smoke test.
 * Reads VENICE_API_KEY (+ optional VENICE_BASE_URL / VENICE_MODEL) from env or .env
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2];
  }
}

const apiKey = process.env.VENICE_API_KEY;
const baseUrl = (process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1").replace(/\/$/, "");
const model = process.env.VENICE_MODEL || "zai-org-glm-5-2";

if (!apiKey) {
  console.error("Missing VENICE_API_KEY");
  process.exit(1);
}

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Reply with exactly: venice-ok" }],
    max_tokens: 32,
    temperature: 0,
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error("HTTP", res.status, text.slice(0, 400));
  process.exit(1);
}
const data = JSON.parse(text);
const reply = data?.choices?.[0]?.message?.content ?? "";
console.log("model:", model);
console.log("base:", baseUrl);
console.log("reply:", reply.trim());
console.log("usage:", JSON.stringify(data.usage ?? null));
