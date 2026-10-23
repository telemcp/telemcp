// Door contract v1 error codes and the mapping from Telegram RPC errors onto them.

export type ErrorCode =
  | "no_connected_account"
  | "account_not_found"
  | "account_suspended"
  | "invalid_recipient"
  | "contact_not_found"
  | "needs_inbound_first"
  | "daily_send_cap"
  | "new_contact_cap"
  | "rate_limited"
  | "media_unavailable"
  | "not_available_for_bots"
  | "code_required"
  | "password_required"
  | "invalid_code"
  | "message_not_found"
  | "invalid_input"
  | "invalid_text"
  | "invalid_media_url"
  | "invalid_reply_to"
  | "invalid_chat_id"
  | "invalid_cursor"
  | "invalid_query"
  | "telegram_error";

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON(): { error_code: string; error: string; retry_after_s?: number } {
    const out: { error_code: string; error: string; retry_after_s?: number } = {
      error_code: this.code,
      error: this.message,
    };
    if (this.retryAfterS !== undefined) out.retry_after_s = Math.max(0, Math.ceil(this.retryAfterS));
    return out;
  }
}

/** The HTTP status a lifecycle tool (connect_*, submit_*, get_*_status, disconnect_*) reports for a refusal. */
export function lifecycleStatus(code: ErrorCode): number {
  switch (code) {
    case "account_suspended":
      return 403;
    case "no_connected_account":
    case "account_not_found":
    case "contact_not_found":
      return 404;
    case "code_required":
    case "password_required":
      return 409;
    case "rate_limited":
      return 429;
    case "telegram_error":
      return 502;
    default:
      return 400;
  }
}

export const LOGIN_HINT =
  "Run `telemcp login` in a terminal (or call connect_telegram) to connect your Telegram account. A running server picks up the new login by itself.";

/** What a Telegram error means for us. */
export type Classified =
  | { kind: "flood_wait"; seconds: number; raw: string }
  | { kind: "peer_flood"; raw: string }
  | { kind: "auth_revoked"; raw: string }
  | { kind: "banned"; raw: string }
  | { kind: "password_needed"; raw: string }
  | { kind: "invalid_code"; raw: string }
  | { kind: "not_found"; raw: string }
  | { kind: "invalid_recipient"; raw: string }
  | { kind: "media"; raw: string }
  | { kind: "bot_method"; raw: string }
  | { kind: "bad_api_credentials"; raw: string }
  | { kind: "other"; raw: string };

const AUTH_REVOKED = new Set([
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "AUTH_KEY_INVALID",
  "AUTH_KEY_PERM_EMPTY",
  "AUTH_KEY_DUPLICATED",
]);
const BANNED = new Set(["USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "PHONE_NUMBER_BANNED"]);
const INVALID_CODE = new Set([
  "PHONE_CODE_INVALID",
  "PHONE_CODE_EXPIRED",
  "PHONE_CODE_EMPTY",
  "PASSWORD_HASH_INVALID",
  "PHONE_NUMBER_INVALID",
  "PHONE_NUMBER_UNOCCUPIED",
]);
const NOT_FOUND = new Set(["USERNAME_NOT_OCCUPIED", "USERNAME_INVALID", "CHANNEL_INVALID", "CHAT_ID_INVALID"]);
const INVALID_RECIPIENT = new Set([
  "PEER_ID_INVALID",
  "USER_IS_BLOCKED",
  "INPUT_USER_DEACTIVATED",
  "CHAT_WRITE_FORBIDDEN",
  "CHAT_ADMIN_REQUIRED",
  "CHANNEL_PRIVATE",
  "USER_BANNED_IN_CHANNEL",
  "CHAT_RESTRICTED",
  "USER_PRIVACY_RESTRICTED",
  "YOU_BLOCKED_USER",
  "MSG_ID_INVALID",
]);
const MEDIA = new Set([
  "WEBPAGE_CURL_FAILED",
  "WEBPAGE_MEDIA_EMPTY",
  "MEDIA_EMPTY",
  "MEDIA_INVALID",
  "FILE_PARTS_INVALID",
  "FILE_PART_INVALID",
  "PHOTO_INVALID_DIMENSIONS",
  "PHOTO_EXT_INVALID",
  "IMAGE_PROCESS_FAILED",
  "FILE_REFERENCE_EXPIRED",
  "EXTERNAL_URL_INVALID",
  "CHAT_SEND_MEDIA_FORBIDDEN",
]);

export function telegramErrorName(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const e = err as { errorMessage?: unknown; message?: unknown };
  if (typeof e.errorMessage === "string" && e.errorMessage) return e.errorMessage;
  return typeof e.message === "string" ? e.message : "";
}

export function classifyTelegramError(err: unknown): Classified {
  const raw = telegramErrorName(err);
  const seconds = (err as { seconds?: unknown })?.seconds;
  const wait = /^(?:FLOOD_WAIT|SLOWMODE_WAIT|FLOOD_PREMIUM_WAIT|FLOOD_TEST_PHONE_WAIT)_(\d+)$/.exec(raw);
  if (wait) return { kind: "flood_wait", seconds: Number(wait[1]), raw };
  if ((raw === "FLOOD" || raw === "SLOWMODE_WAIT") && typeof seconds === "number")
    return { kind: "flood_wait", seconds, raw: raw === "FLOOD" ? `FLOOD_WAIT_${seconds}` : raw };
  if (raw === "PEER_FLOOD") return { kind: "peer_flood", raw };
  if (AUTH_REVOKED.has(raw)) return { kind: "auth_revoked", raw };
  if (BANNED.has(raw)) return { kind: "banned", raw };
  if (raw === "SESSION_PASSWORD_NEEDED") return { kind: "password_needed", raw };
  if (INVALID_CODE.has(raw)) return { kind: "invalid_code", raw };
  if (NOT_FOUND.has(raw) || /No user has .* as username|Cannot find any entity/i.test(raw))
    return { kind: "not_found", raw };
  if (INVALID_RECIPIENT.has(raw)) return { kind: "invalid_recipient", raw };
  if (MEDIA.has(raw)) return { kind: "media", raw };
  if (raw === "BOT_METHOD_INVALID") return { kind: "bot_method", raw };
  if (raw === "API_ID_INVALID" || raw === "API_ID_PUBLISHED_FLOOD" || raw === "ACCESS_TOKEN_INVALID")
    return { kind: "bad_api_credentials", raw };
  return { kind: "other", raw };
}
