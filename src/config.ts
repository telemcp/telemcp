import { existsSync, readFileSync } from "node:fs";
import { ensureHome, type Paths, writePrivate } from "./paths.js";

export interface Limits {
  /** Messages (text or media) sent per local calendar day, across all chats. */
  daily_message_cap: number;
  /** First messages to private chats with no earlier message in either direction, per day. */
  daily_new_contact_cap: number;
  /** Minimum gap between two new contact sends, drawn at random between min and max seconds. */
  new_contact_delay_seconds: { min: number; max: number };
  /** Gap between any two sends, drawn at random between min and max seconds. */
  send_delay_seconds: { min: number; max: number };
  /** Show "typing" before a user account sends text, for a time proportional to its length. */
  typing_indicator: boolean;
}

export interface Config {
  /** "user" (MTProto user account) or "bot" (bot token). Set by `telemcp login`. */
  mode?: "user" | "bot";
  /** Your own api_id from my.telegram.org. Environment TELEGRAM_API_ID wins over this. */
  api_id?: number;
  /** Your own api_hash from my.telegram.org. Environment TELEGRAM_API_HASH wins over this. */
  api_hash?: string;
  limits: Limits;
}

export const DEFAULT_LIMITS: Limits = {
  daily_message_cap: 200,
  daily_new_contact_cap: 20,
  new_contact_delay_seconds: { min: 45, max: 120 },
  send_delay_seconds: { min: 1, max: 3 },
  typing_indicator: true,
};

function num(v: unknown, fallback: number, min = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function range(v: unknown, fallback: { min: number; max: number }): { min: number; max: number } {
  if (!v || typeof v !== "object") return { ...fallback };
  const o = v as Record<string, unknown>;
  const min = num(o.min, fallback.min);
  const max = num(o.max, fallback.max);
  return max >= min ? { min, max } : { min: max, max: min };
}

export function normalizeLimits(raw: unknown): Limits {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    daily_message_cap: Math.floor(num(o.daily_message_cap, DEFAULT_LIMITS.daily_message_cap)),
    daily_new_contact_cap: Math.floor(num(o.daily_new_contact_cap, DEFAULT_LIMITS.daily_new_contact_cap)),
    new_contact_delay_seconds: range(o.new_contact_delay_seconds, DEFAULT_LIMITS.new_contact_delay_seconds),
    send_delay_seconds: range(o.send_delay_seconds, DEFAULT_LIMITS.send_delay_seconds),
    typing_indicator: typeof o.typing_indicator === "boolean" ? o.typing_indicator : DEFAULT_LIMITS.typing_indicator,
  };
}

export function loadConfig(p: Paths): Config {
  let raw: Record<string, unknown> = {};
  if (existsSync(p.config)) {
    try {
      raw = JSON.parse(readFileSync(p.config, "utf8"));
    } catch (e) {
      throw new Error(`Could not parse ${p.config}: ${(e as Error).message}`);
    }
  }
  const cfg: Config = { limits: normalizeLimits(raw.limits) };
  if (raw.mode === "user" || raw.mode === "bot") cfg.mode = raw.mode;
  const id = num(raw.api_id, NaN, 1);
  if (Number.isFinite(id)) cfg.api_id = Math.floor(id);
  if (typeof raw.api_hash === "string" && raw.api_hash) cfg.api_hash = raw.api_hash;
  return cfg;
}

export function saveConfig(p: Paths, cfg: Config): void {
  ensureHome(p);
  writePrivate(p.config, JSON.stringify(cfg, null, 2) + "\n");
}

/** Writes config.json with defaults if it does not exist yet, so the limits are easy to find and edit. */
export function ensureConfigFile(p: Paths): Config {
  const cfg = loadConfig(p);
  if (!existsSync(p.config)) saveConfig(p, cfg);
  return cfg;
}

export interface ApiCredentials {
  apiId: number;
  apiHash: string;
}

export function apiCredentials(cfg: Config, env = process.env): ApiCredentials | undefined {
  const envId = env.TELEGRAM_API_ID ? Number(env.TELEGRAM_API_ID) : NaN;
  const apiId = Number.isFinite(envId) && envId > 0 ? Math.floor(envId) : cfg.api_id;
  const apiHash = env.TELEGRAM_API_HASH || cfg.api_hash;
  if (!apiId || !apiHash) return undefined;
  return { apiId, apiHash };
}
