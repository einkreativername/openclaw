// Techdomme activation provider. Reads from and writes to the three new
// tables added in OPENCLAW_STATE_SCHEMA_VERSION 17:
//
//   - user_techdomme_prefs
//   - channel_techdomme_overrides
//   - techdomme_mode_activations
//
// The provider is intentionally a thin layer over a Kysely handle. We
// keep the surface narrow so the activation resolver can be unit-tested
// with an in-memory mock implementation.
//
// TODO(regen-types): once the Kysely database type includes the three
// new tables (regenerated from the v17 SQL), the `db` parameter below
// should be typed as `Kysely<OpenClawStateKyselyDatabase>` and the
// `prepare(...)` strings can become typed `db.selectFrom(...)` calls.
// Until then we go through the raw handle to avoid coupling the
// gateway-skin to a not-yet-regenerated Kysely type.

import type { DatabaseSync } from "node:sqlite";

export type UserTechdommePref = {
  userId: string;
  techdommeEnabled: boolean;
  locale: string;
};

export type ChannelTechdommeOverride = {
  channelId: string;
  // `null` = inherit user default; `boolean` = explicit override.
  techdommeEnabled: boolean | null;
};

export type TechdommeActivationProvider = {
  getUserPref(userId: string): Promise<UserTechdommePref | null>;
  getChannelOverride(channelId: string): Promise<ChannelTechdommeOverride | null>;
  setUserPref(
    userId: string,
    techdommeEnabled: boolean,
    locale?: string,
  ): Promise<UserTechdommePref>;
  setChannelOverride(
    channelId: string,
    techdommeEnabled: boolean | null,
  ): Promise<ChannelTechdommeOverride>;
  recordActivation(input: {
    userId: string;
    channelId: string;
    sessionId: string;
    modeSource: "user" | "channel" | "off";
    reason?: string;
    extensionVersion?: string;
    activatedAtMs: number;
  }): Promise<void>;
};

type Row = Record<string, unknown>;

function nowMs(): number {
  return Date.now();
}

function rowToUserPref(row: Row): UserTechdommePref {
  return {
    userId: String(row.user_id),
    techdommeEnabled: Number(row.techdomme_enabled) === 1,
    locale: String(row.locale),
  };
}

function rowToChannelOverride(row: Row): ChannelTechdommeOverride {
  return {
    channelId: String(row.channel_id),
    techdommeEnabled:
      row.techdomme_enabled === null || row.techdomme_enabled === undefined
        ? null
        : Number(row.techdomme_enabled) === 1,
  };
}

export class KyselyTechdommeActivationProvider implements TechdommeActivationProvider {
  constructor(private readonly db: DatabaseSync) {}

  async getUserPref(userId: string): Promise<UserTechdommePref | null> {
    const row = this.db
      .prepare("SELECT user_id, techdomme_enabled, locale FROM user_techdomme_prefs WHERE user_id = ?")
      .get(userId) as Row | undefined;
    return row ? rowToUserPref(row) : null;
  }

  async getChannelOverride(channelId: string): Promise<ChannelTechdommeOverride | null> {
    const row = this.db
      .prepare("SELECT channel_id, techdomme_enabled FROM channel_techdomme_overrides WHERE channel_id = ?")
      .get(channelId) as Row | undefined;
    return row ? rowToChannelOverride(row) : null;
  }

  async setUserPref(
    userId: string,
    techdommeEnabled: boolean,
    locale: string = "en",
  ): Promise<UserTechdommePref> {
    const now = nowMs();
    const flag = techdommeEnabled ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO user_techdomme_prefs (user_id, techdomme_enabled, locale, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           techdomme_enabled = excluded.techdomme_enabled,
           locale = excluded.locale,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(userId, flag, locale, now, now);
    return { userId, techdommeEnabled, locale };
  }

  async setChannelOverride(
    channelId: string,
    techdommeEnabled: boolean | null,
  ): Promise<ChannelTechdommeOverride> {
    const now = nowMs();
    const flag = techdommeEnabled === null ? null : techdommeEnabled ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO channel_techdomme_overrides (channel_id, techdomme_enabled, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           techdomme_enabled = excluded.techdomme_enabled,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(channelId, flag, now, now);
    return { channelId, techdommeEnabled };
  }

  async recordActivation(input: {
    userId: string;
    channelId: string;
    sessionId: string;
    modeSource: "user" | "channel" | "off";
    reason?: string;
    extensionVersion?: string;
    activatedAtMs: number;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO techdomme_mode_activations
           (id, user_id, channel_id, session_id, mode_source, reason, extension_version, activated_at_ms)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.userId,
        input.channelId,
        input.sessionId,
        input.modeSource,
        input.reason ?? null,
        input.extensionVersion ?? null,
        input.activatedAtMs,
      );
  }
}

// In-memory provider for tests and for callers that want a fresh session
// resolver without touching the on-disk state DB.
export class InMemoryTechdommeActivationProvider implements TechdommeActivationProvider {
  private readonly userPrefs = new Map<string, UserTechdommePref>();
  private readonly channelOverrides = new Map<string, ChannelTechdommeOverride>();
  public readonly activationLog: Array<{
    userId: string;
    channelId: string;
    sessionId: string;
    modeSource: "user" | "channel" | "off";
    reason?: string;
    extensionVersion?: string;
    activatedAtMs: number;
  }> = [];

  async getUserPref(userId: string): Promise<UserTechdommePref | null> {
    return this.userPrefs.get(userId) ?? null;
  }

  async getChannelOverride(channelId: string): Promise<ChannelTechdommeOverride | null> {
    return this.channelOverrides.get(channelId) ?? null;
  }

  async setUserPref(
    userId: string,
    techdommeEnabled: boolean,
    locale: string = "en",
  ): Promise<UserTechdommePref> {
    const pref = { userId, techdommeEnabled, locale };
    this.userPrefs.set(userId, pref);
    return pref;
  }

  async setChannelOverride(
    channelId: string,
    techdommeEnabled: boolean | null,
  ): Promise<ChannelTechdommeOverride> {
    const override = { channelId, techdommeEnabled };
    this.channelOverrides.set(channelId, override);
    return override;
  }

  async recordActivation(input: {
    userId: string;
    channelId: string;
    sessionId: string;
    modeSource: "user" | "channel" | "off";
    reason?: string;
    extensionVersion?: string;
    activatedAtMs: number;
  }): Promise<void> {
    this.activationLog.push({ ...input });
  }
}
