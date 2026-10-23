// The safety limits, kept deliberately simple:
//   daily message cap, daily new contact cap, a jittered gap between new contacts,
//   a short jittered gap between any two sends, and honest handling of FLOOD_WAIT / PEER_FLOOD.
// State that must survive a restart (flood pause, peer flood day, auth failure) lives in the state table.

import type { Limits } from "./config.js";
import { dayKey, type Store } from "./db.js";
import { classifyTelegramError, LOGIN_HINT, ToolError } from "./errors.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

const K = {
  floodUntil: "flood_until",
  floodReason: "flood_reason",
  peerFloodDay: "peer_flood_day",
  nextNewContactAt: "next_new_contact_at",
  authProblem: "auth_problem",
  authProblemKind: "auth_problem_kind",
};

/** Milliseconds until the next local midnight, when the daily caps reset. */
export function msUntilMidnight(now: number): number {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now;
}

/** How long to show "typing" for a text of this length (user mode only). */
export function typingMs(text: string): number {
  return Math.min(6000, Math.max(800, text.length * 40));
}

export interface UsageSnapshot {
  day: string;
  sends: number;
  sendsCap: number;
  newContacts: number;
  newContactsCap: number;
  floodUntil?: number;
  floodReason?: string;
  peerFloodToday: boolean;
  nextNewContactAt?: number;
  authProblem?: { kind: "revoked" | "banned"; reason: string };
}

export class SendGuard {
  private lastSendAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private store: Store,
    private limits: () => Limits,
    private clock: Clock = realClock,
  ) {}

  private jitter(range: { min: number; max: number }): number {
    return (range.min + (range.max - range.min) * this.clock.random()) * 1000;
  }

  usage(): UsageSnapshot {
    const now = this.clock.now();
    const day = dayKey(now);
    const c = this.store.countSends(day);
    const l = this.limits();
    const floodUntil = Number(this.store.getState(K.floodUntil) || 0);
    const next = Number(this.store.getState(K.nextNewContactAt) || 0);
    const authReason = this.store.getState(K.authProblem);
    return {
      day,
      sends: c.messages,
      sendsCap: l.daily_message_cap,
      newContacts: c.newContacts,
      newContactsCap: l.daily_new_contact_cap,
      floodUntil: floodUntil > now ? floodUntil : undefined,
      floodReason: floodUntil > now ? this.store.getState(K.floodReason) : undefined,
      peerFloodToday: this.store.getState(K.peerFloodDay) === day,
      nextNewContactAt: next > now ? next : undefined,
      authProblem: authReason
        ? { kind: this.store.getState(K.authProblemKind) === "banned" ? "banned" : "revoked", reason: authReason }
        : undefined,
    };
  }

  authProblem(): UsageSnapshot["authProblem"] {
    return this.usage().authProblem;
  }

  clearAuthProblem(): void {
    this.store.setState(K.authProblem, undefined);
    this.store.setState(K.authProblemKind, undefined);
  }

  /** Throws a ToolError when the send must not happen. Nothing is queued on a refusal. */
  check(opts: { newContact: boolean }): void {
    const u = this.usage();
    const now = this.clock.now();
    if (u.authProblem) throw authError(u.authProblem);
    if (u.floodUntil) {
      throw new ToolError(
        "rate_limited",
        `Telegram asked us to wait (${u.floodReason || "FLOOD_WAIT"}). Sends are paused until ${new Date(u.floodUntil).toISOString()}.`,
        (u.floodUntil - now) / 1000,
      );
    }
    if (u.sends >= u.sendsCap) {
      throw new ToolError(
        "daily_send_cap",
        `Daily message cap reached (${u.sends}/${u.sendsCap}). It resets at local midnight. Change daily_message_cap in config.json to adjust it.`,
        msUntilMidnight(now) / 1000,
      );
    }
    if (opts.newContact) {
      if (u.peerFloodToday) {
        throw new ToolError(
          "rate_limited",
          "Telegram returned PEER_FLOOD earlier today: it limits this account from messaging people who have not talked to it. New contact sends are stopped until local midnight. Messages to existing chats still work.",
          msUntilMidnight(now) / 1000,
        );
      }
      if (u.newContacts >= u.newContactsCap) {
        throw new ToolError(
          "new_contact_cap",
          `Daily new contact cap reached (${u.newContacts}/${u.newContactsCap}). It resets at local midnight. Change daily_new_contact_cap in config.json to adjust it.`,
          msUntilMidnight(now) / 1000,
        );
      }
      if (u.nextNewContactAt) {
        throw new ToolError(
          "rate_limited",
          "New contacts are spaced out. The next message to a new contact is allowed after the delay below.",
          (u.nextNewContactAt - now) / 1000,
        );
      }
    }
  }

  /**
   * Runs one send under the limits: checks, waits the short gap since the previous send,
   * performs it, records the result and converts Telegram errors into contract errors.
   * Sends are serialised so two concurrent tool calls cannot both slip under a cap.
   */
  run<T>(opts: { chatId: string; kind: "text" | "media"; newContact: boolean }, send: () => Promise<T>): Promise<T> {
    const job = this.queue.then(async () => {
      this.check(opts);
      const gap = this.jitter(this.limits().send_delay_seconds);
      const wait = this.lastSendAt + gap - this.clock.now();
      if (this.lastSendAt && wait > 0) await this.clock.sleep(wait);
      const at = this.clock.now();
      try {
        const out = await send();
        this.lastSendAt = this.clock.now();
        this.store.recordSend({ at, day: dayKey(at), chatId: opts.chatId, kind: opts.kind, newContact: opts.newContact, ok: true });
        if (opts.newContact) {
          const next = this.clock.now() + this.jitter(this.limits().new_contact_delay_seconds);
          this.store.setState(K.nextNewContactAt, String(Math.round(next)));
        }
        return out;
      } catch (err) {
        this.lastSendAt = this.clock.now();
        const te = this.handleError(err, { newContact: opts.newContact });
        this.store.recordSend({
          at,
          day: dayKey(at),
          chatId: opts.chatId,
          kind: opts.kind,
          newContact: opts.newContact,
          ok: false,
          error: te.code + ": " + te.message,
        });
        throw te;
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** Persists what a Telegram error means and returns the contract error to show. Never retries. */
  handleError(err: unknown, ctx: { newContact?: boolean; bot?: boolean } = {}): ToolError {
    if (err instanceof ToolError) return err;
    const c = classifyTelegramError(err);
    const now = this.clock.now();
    switch (c.kind) {
      case "flood_wait": {
        const until = now + c.seconds * 1000;
        const prev = Number(this.store.getState(K.floodUntil) || 0);
        if (until > prev) {
          this.store.setState(K.floodUntil, String(until));
          this.store.setState(K.floodReason, c.raw);
        }
        return new ToolError(
          "rate_limited",
          `Telegram returned ${c.raw}: wait ${c.seconds} seconds. telemcp does not retry inside the wait; sends are paused until then.`,
          c.seconds,
        );
      }
      case "peer_flood":
        this.store.setState(K.peerFloodDay, dayKey(now));
        return new ToolError(
          "rate_limited",
          "Telegram returned PEER_FLOOD: it limits this account from messaging people who have not talked to it. New contact sends are stopped until local midnight. Messages to existing chats still work.",
          msUntilMidnight(now) / 1000,
        );
      case "auth_revoked":
        this.store.setState(K.authProblem, c.raw);
        this.store.setState(K.authProblemKind, "revoked");
        return authError({ kind: "revoked", reason: c.raw });
      case "banned":
        this.store.setState(K.authProblem, c.raw);
        this.store.setState(K.authProblemKind, "banned");
        return authError({ kind: "banned", reason: c.raw });
      case "not_found":
        return new ToolError("contact_not_found", `Telegram could not find that chat (${c.raw}).`);
      case "invalid_recipient":
        if (ctx.bot && c.raw === "PEER_ID_INVALID")
          return new ToolError(
            "needs_inbound_first",
            "A bot can only message people who started a chat with it first (PEER_ID_INVALID).",
          );
        return new ToolError("invalid_recipient", `Telegram refused this recipient (${c.raw}).`);
      case "media":
        return new ToolError("media_unavailable", `Telegram could not use that media (${c.raw}).`);
      case "bot_method":
        return new ToolError("not_available_for_bots", "Telegram does not allow bots to do this (BOT_METHOD_INVALID).");
      case "bad_api_credentials":
        return new ToolError(
          "invalid_input",
          c.raw === "ACCESS_TOKEN_INVALID"
            ? "Telegram rejected the bot token (ACCESS_TOKEN_INVALID). Copy it again from @BotFather."
            : `Telegram rejected the api_id / api_hash (${c.raw}). Copy both again from https://my.telegram.org (API development tools).`,
        );
      case "invalid_code":
        return new ToolError("invalid_code", `Telegram rejected it (${c.raw}).`);
      case "password_needed":
        return new ToolError("password_required", "This account has two step verification. Call submit_telegram_password.");
      default:
        return new ToolError("telegram_error", c.raw || "Unknown Telegram error");
    }
  }
}

export function authError(p: { kind: "revoked" | "banned"; reason: string }): ToolError {
  if (p.kind === "banned")
    return new ToolError(
      "account_suspended",
      `Telegram reports this account as deactivated or banned (${p.reason}). telemcp stopped all sends. Check the account in the official Telegram app; once it works there, run \`telemcp login\` again.`,
    );
  return new ToolError(
    "no_connected_account",
    `The Telegram session is no longer valid (${p.reason}), for example because it was ended from another device. telemcp stopped. ${LOGIN_HINT}`,
  );
}
