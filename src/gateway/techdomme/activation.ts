// Techdomme activation resolver. Pure function over a TechdommeActivationProvider,
// with a per-process LRU cache (60s TTL) keyed by (userId, channelId).
//
// On any provider failure the resolver fails CLOSED: returns
// { active: false, source: "off", reason: "activation_error" }. The session
// continues normally — no persona, no skills. The caller is expected to
// log a warning and write an audit row with reason="activation_error".
//
// This file deliberately has no I/O of its own; the provider is injected
// so the activation logic is testable in isolation.

import type { TechdommeActivationProvider } from "./provider.js";

export type TechdommeModeSource = "user" | "channel" | "off";

export type TechdommeMode = {
  active: boolean;
  source: TechdommeModeSource;
  reason?: string;
  locale: string;
  version: number;
};

const DEFAULT_TTL_MS = 60_000;

type CacheEntry = {
  value: TechdommeMode;
  expiresAt: number;
};

export type ActivationResolveOptions = {
  now?: () => number;
  ttlMs?: number;
  // For tests: skip the cache entirely.
  bypassCache?: boolean;
};

export class TechdommeActivationResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly provider: TechdommeActivationProvider,
    private readonly defaultLocale: string = "en",
  ) {}

  async resolve(
    userId: string,
    channelId: string,
    options: ActivationResolveOptions = {},
  ): Promise<TechdommeMode> {
    const now = options.now ?? Date.now;
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;

    if (!options.bypassCache) {
      const cached = this.cache.get(this.cacheKey(userId, channelId));
      if (cached && cached.expiresAt > now()) {
        return cached.value;
      }
    }

    let value: TechdommeMode;
    try {
      value = await this.compute(userId, channelId, now);
    } catch (err) {
      // Fail-closed: never throw from resolve. The caller logs + audits.
      const reason = err instanceof Error ? `activation_error: ${err.message}` : "activation_error";
      value = {
        active: false,
        source: "off",
        reason,
        locale: this.defaultLocale,
        version: 0,
      };
    }

    this.cache.set(this.cacheKey(userId, channelId), {
      value,
      expiresAt: now() + ttl,
    });
    return value;
  }

  invalidate(userId: string, channelId: string): void {
    this.cache.delete(this.cacheKey(userId, channelId));
  }

  invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}\u0000`)) {
        this.cache.delete(key);
      }
    }
  }

  invalidateChannel(channelId: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`\u0000${channelId}`)) {
        this.cache.delete(key);
      }
    }
  }

  private async compute(
    userId: string,
    channelId: string,
    now: () => number,
  ): Promise<TechdommeMode> {
    const [userPref, channelOverride] = await Promise.all([
      this.provider.getUserPref(userId),
      this.provider.getChannelOverride(channelId),
    ]);

    if (channelOverride && channelOverride.techdommeEnabled !== null) {
      return {
        active: channelOverride.techdommeEnabled,
        source: "channel",
        locale: userPref?.locale ?? this.defaultLocale,
        version: now(),
      };
    }

    if (userPref) {
      return {
        active: userPref.techdommeEnabled,
        source: "user",
        locale: userPref.locale,
        version: now(),
      };
    }

    return {
      active: false,
      source: "off",
      locale: this.defaultLocale,
      version: now(),
    };
  }

  private cacheKey(userId: string, channelId: string): string {
    return `${userId}\u0000${channelId}`;
  }
}
