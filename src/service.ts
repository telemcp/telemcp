// The tool logic. Everything here talks to Telegram only through TelegramPort, so it is testable offline.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { apiCredentials, type Config, ensureConfigFile, loadConfig, normalizeLimits } from "./config.js";
import type { Store } from "./db.js";
import { LOGIN_HINT, ToolError } from "./errors.js";
import { authError, type Clock, realClock, SendGuard, typingMs } from "./limits.js";
import { log } from "./log.js";
import { deleteSession, type Paths, readSession, saveSession } from "./paths.js";
import type { Connector, IncomingEvent, PendingLogin, TelegramPort } from "./port.js";
import type { ChatInfo, ChatType, MeInfo, MessageInfo, StoredMessage, UserInfo } from "./types.js";
import {
  CHANNEL,
  CONTRACT_VERSION,
  messageId,
  parseMessageId,
  toWireMessage,
  type WireAccount,
  type WireMessage,
} from "./wire.js";

export interface Recipient {
  telegram_user_id?: string;
  telegram_username?: string;
  phone?: string;
  contact_id?: string;
}

export interface ServiceOptions {
  paths: Paths;
  store: Store;
  connector: Connector;
  clock?: Clock;
  env?: NodeJS.ProcessEnv;
  /** Inject a config instead of reading config.json (tests). */
  config?: Config;
}

type Phase = "disconnected" | "code_required" | "password_required" | "connected";

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_UPLOAD = 2000 * 1024 * 1024;

export class TeleService {
  readonly store: Store;
  readonly guard: SendGuard;
  private paths: Paths;
  private connector: Connector;
  private clock: Clock;
  private env: NodeJS.ProcessEnv;
  private fixedConfig?: Config;
  private cachedConfig?: { mtime: number; cfg: Config };
  private port?: TelegramPort;
  private me?: MeInfo;
  private pending?: PendingLogin;
  private phase: Phase = "disconnected";
  private waiters = new Set<() => void>();

  constructor(o: ServiceOptions) {
    this.paths = o.paths;
    this.store = o.store;
    this.connector = o.connector;
    this.clock = o.clock ?? realClock;
    this.env = o.env ?? process.env;
    this.fixedConfig = o.config;
    this.guard = new SendGuard(this.store, () => this.config().limits, this.clock);
    this.store.onInsert((m) => {
      if (!m.outgoing) for (const w of [...this.waiters]) w();
    });
  }

  /** config.json is re-read when it changes, so edited limits apply without a restart. */
  config(): Config {
    if (this.fixedConfig) return this.fixedConfig;
    let mtime = 0;
    try {
      mtime = statSync(this.paths.config).mtimeMs;
    } catch {
      // no file yet
    }
    if (!this.cachedConfig || this.cachedConfig.mtime !== mtime) {
      try {
        this.cachedConfig = { mtime, cfg: loadConfig(this.paths) };
      } catch (e) {
        log.warn("config.json could not be read, using the last good copy", e);
        if (!this.cachedConfig) this.cachedConfig = { mtime, cfg: { limits: normalizeLimits({}) } };
      }
    }
    return this.cachedConfig.cfg;
  }

  get mode(): "user" | "bot" {
    return this.port?.mode ?? this.config().mode ?? (this.env.TELEMCP_BOT_TOKEN ? "bot" : "user");
  }

  get connected(): boolean {
    return this.phase === "connected" && !!this.port;
  }

  accountId(): string {
    const id = this.me?.id ?? this.store.getState("account_id");
    return id ? `tg_${id}` : "tg_local";
  }

  // ---------------------------------------------------------------- lifecycle

  /** Connects with the saved session, or logs a bot in from TELEMCP_BOT_TOKEN. Never throws. */
  async start(): Promise<void> {
    if (this.fixedConfig === undefined) {
      try {
        ensureConfigFile(this.paths);
      } catch (e) {
        log.warn("could not write config.json", e);
      }
    }
    const creds = apiCredentials(this.config(), this.env);
    const session = readSession(this.paths);
    const botToken = this.env.TELEMCP_BOT_TOKEN;
    if (!creds) {
      if (session || botToken) log.warn("api_id / api_hash missing: set TELEGRAM_API_ID and TELEGRAM_API_HASH or run `telemcp login`.");
      else log.info("not logged in. " + LOGIN_HINT);
      return;
    }
    try {
      if (session) {
        await this.attach(await this.connector.fromSession(session, creds));
      } else if (botToken) {
        const port = await this.connector.loginBot(botToken, creds);
        saveSession(this.paths, port.exportSession());
        await this.attach(port);
      } else {
        log.info("not logged in. " + LOGIN_HINT);
      }
    } catch (err) {
      const te = this.guard.handleError(err);
      log.error(`could not connect to Telegram: ${te.message}`);
    }
  }

  private lastAutoConnect = 0;
  private starting?: Promise<void>;

  /**
   * Picks up a session saved by `telemcp login` while the server was already running,
   * so the user does not need to restart their AI assistant. Tried at most every 10 seconds.
   */
  async connectIfSessionAppeared(): Promise<void> {
    if (this.connected || this.pending || this.guard.authProblem()) return;
    if (this.starting) return this.starting;
    const now = this.clock.now();
    if (now - this.lastAutoConnect < 10_000) return;
    this.lastAutoConnect = now;
    if (!readSession(this.paths)) return;
    this.starting = this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  async stop(): Promise<void> {
    for (const w of [...this.waiters]) w();
    await this.port?.disconnect().catch(() => undefined);
    await this.pending?.cancel().catch(() => undefined);
  }

  /** Wire a logged in port into the service. Exposed for tests. */
  async attach(port: TelegramPort): Promise<void> {
    this.me = await port.me();
    this.port = port;
    this.phase = "connected";
    this.pending = undefined;
    this.guard.clearAuthProblem();
    this.store.setState("account_id", this.me.id);
    this.store.setState("identifier", this.me.username ? "@" + this.me.username : this.me.phone ?? this.me.name);
    this.store.setState("connect_kind", port.mode);
    if (!this.store.getState("connected_at")) this.store.setState("connected_at", new Date(this.clock.now()).toISOString());
    this.store.upsertChat({
      id: this.me.id,
      type: "user",
      kind: "user",
      title: "Saved Messages",
      username: this.me.username,
      isBot: this.me.isBot,
    });
    port.onMessage((e) => this.ingestEvent(e));
    log.info(`connected to Telegram as ${this.me.username ? "@" + this.me.username : this.me.name} (${port.mode} mode)`);
  }

  ingestEvent(e: IncomingEvent): void {
    try {
      this.store.upsertChat({ ...e.chat, lastMessageAt: e.message.date });
      if (e.sender) this.store.upsertUser(e.sender);
      this.store.insertMessage(e.message);
    } catch (err) {
      log.warn("could not store an incoming message", err);
    }
  }

  private ingest(r: { messages?: MessageInfo[]; chats?: ChatInfo[]; users?: UserInfo[] }): StoredMessage[] {
    for (const c of r.chats ?? []) this.store.upsertChat(c);
    for (const u of r.users ?? []) {
      this.store.upsertUser(u);
      if (!this.store.getChat(u.id))
        this.store.upsertChat({
          id: u.id,
          type: "user",
          kind: "user",
          title: [u.firstName, u.lastName].filter(Boolean).join(" ") || (u.username ? "@" + u.username : u.id),
          username: u.username,
          accessHash: u.accessHash,
          isBot: u.isBot,
        });
    }
    const out: StoredMessage[] = [];
    for (const m of r.messages ?? []) {
      this.store.insertMessage(m);
      const s = this.store.getMessage(m.chatId, m.id);
      if (s) out.push(s);
    }
    return out;
  }

  // ---------------------------------------------------------------- helpers

  private requirePort(): TelegramPort {
    const problem = this.guard.authProblem();
    if (problem) throw authError(problem);
    if (this.port && this.phase === "connected") return this.port;
    if (this.phase === "code_required")
      throw new ToolError("code_required", "A login is in progress: call submit_telegram_code with the code Telegram sent you.");
    if (this.phase === "password_required")
      throw new ToolError("password_required", "A login is in progress: call submit_telegram_password with your two step verification password.");
    throw new ToolError("no_connected_account", "No Telegram account is connected. " + LOGIN_HINT);
  }

  private notForBots(what: string): never {
    throw new ToolError(
      "not_available_for_bots",
      `${what} is not available in bot mode: Telegram does not let bots do this. telemcp answers from the messages the bot has received since it started.`,
    );
  }

  /** Runs a Telegram call and maps its errors onto contract errors. */
  private async tg<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw this.guard.handleError(err, { bot: this.mode === "bot" });
    }
  }

  private checkAccount(accountId?: string): void {
    const problem = this.guard.authProblem();
    if (problem) throw authError(problem);
    if (accountId && accountId !== this.accountId())
      throw new ToolError("account_not_found", `Unknown account_id ${accountId}. This server has one account: ${this.accountId()}.`);
  }

  /** A chat_id used as a filter: undefined when absent, null when it names no known chat (the result is then empty). */
  private async chatFilter(ref?: string): Promise<ChatInfo | null | undefined> {
    if (ref === undefined || ref === "") return undefined;
    try {
      return await this.resolveChatId(ref);
    } catch (e) {
      if (e instanceof ToolError && e.code === "contact_not_found") return null;
      if (e instanceof ToolError && e.code === "invalid_recipient") throw new ToolError("invalid_chat_id", e.message);
      throw e;
    }
  }

  // ---------------------------------------------------------------- phone numbers on the connection tools

  /** The number this server is connected to (or was given to connect_telegram), as +digits. */
  private knownPhone(): string | undefined {
    const p = this.store.getState("phone_number") ?? this.me?.phone;
    const digits = p?.replace(/\D/g, "");
    return digits ? "+" + digits : undefined;
  }

  /**
   * Checks phoneNumber on a connection tool against the number this server knows. Bot mode has no number
   * (any value is accepted, null is reported). When no number is known yet the given one is remembered.
   */
  private checkPhone(input: unknown): string | null {
    if (this.mode === "bot") return null;
    const digits = String(input ?? "").replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 16)
      throw new ToolError("invalid_input", "phoneNumber must be a phone number in international format, for example +31612345678.");
    const known = this.knownPhone();
    if (known && known.slice(1) !== digits) throw new ToolError("account_not_found", "No connection for that number.");
    if (!known) this.store.setState("phone_number", "+" + digits);
    return "+" + digits;
  }

  private loginResult(phone: string | null, status: string, extra: Record<string, unknown> = {}) {
    return {
      success: true as const,
      phone_number: phone,
      status,
      telegram_user_id: status === "connected" ? (this.me?.id ?? null) : null,
      username: status === "connected" ? (this.me?.username ?? null) : null,
      ...extra,
    };
  }

  private wire(m: StoredMessage): WireMessage {
    const chat = this.store.getChat(m.chatId);
    const sender = m.senderId ? this.store.getUser(m.senderId) : undefined;
    return toWireMessage(m, { accountId: this.accountId(), chat, sender });
  }

  /** chat_id inputs: a chat id, or for convenience an @username. */
  private async resolveChatId(ref: string): Promise<ChatInfo> {
    const r = String(ref).trim();
    if (/^-?\d+$/.test(r)) {
      let chat = this.store.getChat(r);
      if (!chat && this.mode === "user" && this.connected) {
        await this.refreshDialogs(200).catch(() => undefined);
        chat = this.store.getChat(r);
      }
      if (chat) return chat;
      throw new ToolError("contact_not_found", `No chat with id ${r} is known yet. Use list_chats to find chat ids.`);
    }
    if (/^@|^https?:\/\/t\.me\//i.test(r)) return this.resolveUsername(r);
    throw new ToolError("invalid_recipient", `"${r}" is not a chat id. Use list_chats to find chat ids.`);
  }

  private async resolveUsername(input: string): Promise<ChatInfo> {
    const username = input
      .trim()
      .replace(/^https?:\/\/t\.me\//i, "")
      .replace(/^@/, "")
      .replace(/\/.*$/, "");
    if (!/^[A-Za-z0-9_]{4,32}$/.test(username))
      throw new ToolError("invalid_recipient", `"${input}" is not a valid Telegram username.`);
    const local = this.store.findChatByUsername(username);
    if (local) return local;
    const port = this.requirePort();
    const chat = await this.tg(() => port.resolveUsername(username));
    if (!chat) throw new ToolError("contact_not_found", `No Telegram account or chat has the username @${username}.`);
    this.store.upsertChat(chat);
    return this.store.getChat(chat.id) ?? chat;
  }

  async resolveRecipient(to: Recipient): Promise<ChatInfo> {
    if (!to || typeof to !== "object" || Array.isArray(to))
      throw new ToolError("invalid_recipient", "`to` must be one recipient object, for example {\"telegram_username\": \"@name\"}.");
    const keys = (Object.keys(to) as (keyof Recipient)[]).filter((k) => to[k] !== undefined && to[k] !== "");
    if (keys.length !== 1)
      throw new ToolError(
        "invalid_recipient",
        "`to` must name exactly one recipient with exactly one of telegram_user_id, telegram_username, phone or contact_id. There is no bulk send.",
      );
    const key = keys[0];
    const value = String(to[key]).trim();
    if (/[,;\n]/.test(value) && key !== "contact_id")
      throw new ToolError("invalid_recipient", "`to` must name exactly one recipient. There is no bulk send.");
    switch (key) {
      case "telegram_user_id": {
        if (!/^\d+$/.test(value)) throw new ToolError("invalid_recipient", "telegram_user_id must be a positive number.");
        const chat = this.store.getChat(value);
        if (chat?.type === "user") return chat;
        throw new ToolError(
          "contact_not_found",
          `User ${value} is not known to this account yet (Telegram needs to have shown us this user first). Use telegram_username or list_chats.`,
        );
      }
      case "telegram_username":
        return this.resolveUsername(value);
      case "phone": {
        if (!/^\+?[0-9 ()-]{6,20}$/.test(value)) throw new ToolError("invalid_recipient", "phone must be a phone number in international format.");
        if (this.mode === "bot") this.notForBots("Sending by phone number");
        const port = this.requirePort();
        const chat = await this.tg(() => port.findContactByPhone(value));
        if (!chat) throw new ToolError("contact_not_found", `${value} is not in this account's Telegram contacts.`);
        this.store.upsertChat(chat);
        return this.store.getChat(chat.id) ?? chat;
      }
      case "contact_id":
        return this.resolveChatId(value);
      default:
        throw new ToolError("invalid_recipient", "Unknown recipient field.");
    }
  }

  /** A new contact is a private chat with no earlier message in either direction. */
  async isNewContact(chat: ChatInfo): Promise<boolean> {
    if (chat.type !== "user") return false;
    if (this.me && chat.id === this.me.id) return false;
    if (this.store.hasAnyMessage(chat.id) || this.store.hasSentTo(chat.id)) return false;
    if (this.mode === "user" && this.port) {
      const port = this.port;
      const r = await this.tg(() => port.getHistory(chat, { limit: 1 }));
      if (r.messages.length) {
        this.ingest(r);
        return false;
      }
    }
    return true;
  }

  private async refreshDialogs(limit: number): Promise<void> {
    const port = this.requirePort();
    const r = await this.tg(() => port.listDialogs(limit));
    for (const c of r.chats) this.store.upsertChat(c);
    for (const m of r.messages) this.store.insertMessage(m);
  }

  // ---------------------------------------------------------------- account tools

  account(): WireAccount {
    const u = this.guard.usage();
    let status: WireAccount["status"] = "disconnected";
    if (u.authProblem?.kind === "banned") status = "restricted";
    else if (u.authProblem) status = "disconnected";
    else if (this.connected) status = u.peerFloodToday ? "restricted" : "connected";
    else if (this.phase === "code_required" || this.phase === "password_required") status = "connecting";
    const kind = (this.port?.mode ?? this.store.getState("connect_kind") ?? this.mode) as "user" | "bot";
    return {
      id: this.accountId(),
      channel: CHANNEL,
      connect_kind: kind === "bot" ? "bot" : "user",
      identifier: this.store.getState("identifier") ?? null,
      status,
      connected_at: status === "disconnected" ? null : (this.store.getState("connected_at") ?? null),
      limits: {
        sends_today: u.sends,
        sends_cap: u.sendsCap,
        new_contacts_today: u.newContacts,
        new_contacts_cap: u.newContactsCap,
        ramp_day: null,
      },
    };
  }

  /** get_telegram_status: the connection state plus a plain explanation of what to do next. */
  status(input: { phoneNumber: string }): {
    success: true;
    phone_number: string | null;
    status: "connected" | "code_required" | "password_required" | "initializing" | "disconnected" | "not_initialized" | "error";
    telegram_user_id: string | null;
    live: boolean;
    limits: WireAccount["limits"];
    detail: string;
  } {
    const phone = this.checkPhone(input.phoneNumber);
    const a = this.account();
    const u = this.guard.usage();
    let detail: string;
    if (u.authProblem) detail = authError(u.authProblem).message;
    else if (a.status === "connecting")
      detail = this.phase === "code_required" ? "Waiting for submit_telegram_code." : "Waiting for submit_telegram_password.";
    else if (!this.connected)
      detail = apiCredentials(this.config(), this.env)
        ? "Not connected. " + LOGIN_HINT
        : "Not connected, and no api_id / api_hash is configured. Get them at https://my.telegram.org (API development tools), then run `telemcp login`.";
    else if (u.floodUntil) detail = `Connected. Sends paused by Telegram (${u.floodReason}) until ${new Date(u.floodUntil).toISOString()}.`;
    else if (u.peerFloodToday) detail = "Connected. Telegram returned PEER_FLOOD today: new contact sends are stopped until local midnight.";
    else detail = `Connected in ${this.mode} mode.`;
    let status: ReturnType<TeleService["status"]>["status"];
    if (u.authProblem) status = "error";
    else if (this.connected) status = "connected";
    else if (this.phase === "code_required" || this.phase === "password_required") status = this.phase;
    else if (this.starting) status = "initializing";
    else status = readSession(this.paths) || this.store.getState("account_id") ? "disconnected" : "not_initialized";
    return {
      success: true,
      phone_number: phone,
      status,
      telegram_user_id: this.connected ? (this.me?.id ?? null) : null,
      live: this.connected,
      limits: a.limits,
      detail,
    };
  }

  listAccounts(): {
    accounts: WireAccount[];
    channels: { channel: string; label: string; connect_kind: string; max_accounts: number }[];
  } {
    return {
      accounts: [this.account()],
      channels: [{ channel: CHANNEL, label: "Telegram", connect_kind: "code", max_accounts: 1 }],
    };
  }

  usage(): Record<string, unknown> {
    const u = this.guard.usage();
    const out: Record<string, unknown> = {
      plan: "self-hosted",
      day: u.day,
      sends: u.sends,
      sends_cap: u.sendsCap,
      new_contacts: u.newContacts,
      new_contacts_cap: u.newContactsCap,
      status: u.authProblem?.kind === "banned" ? "suspended" : "active",
      accounts_total: 1,
      accounts_connected: this.connected ? 1 : 0,
      accounts_cap: 1,
      ramp_day: null,
      contract_version: CONTRACT_VERSION,
    };
    if (u.authProblem?.kind === "banned") out.suspended_reason = u.authProblem.reason;
    if (u.floodUntil) out.paused_until = new Date(u.floodUntil).toISOString();
    if (u.peerFloodToday) out.new_contacts_stopped_today = true;
    if (u.nextNewContactAt) out.next_new_contact_at = new Date(u.nextNewContactAt).toISOString();
    return out;
  }

  async connectTelegram(input: { phone_number: string; mode?: "code" | "qr"; force_new?: boolean }) {
    if (input.mode === "qr") throw new ToolError("invalid_input", "QR login is not supported by self-hosted telemcp; use mode code.");
    const phone = String(input.phone_number ?? "").replace(/[\s()-]/g, "");
    if (!/^\+?\d{6,16}$/.test(phone))
      throw new ToolError("invalid_input", "phone_number must be your Telegram phone number in international format, for example +31612345678.");
    const digits = "+" + phone.replace(/\D/g, "");
    if (input.force_new) {
      if (this.port || this.pending || readSession(this.paths)) await this.logOutLocal();
    } else if (this.connected && !this.guard.authProblem()) {
      if (this.mode === "bot") return this.connectResult(null, "connected");
      const known = this.knownPhone();
      if (known && known !== digits)
        throw new ToolError("invalid_input", `This server is connected to another number. Pass force_new: true to log it out and connect ${digits}.`);
      return this.connectResult(known ?? digits, "connected");
    }
    if (this.mode === "bot" && this.env.TELEMCP_BOT_TOKEN) this.notForBots("Phone login");
    const creds = apiCredentials(this.config(), this.env);
    if (!creds)
      throw new ToolError(
        "invalid_input",
        "No api_id / api_hash configured. Get them at https://my.telegram.org (API development tools) and set TELEGRAM_API_ID and TELEGRAM_API_HASH, or run `telemcp login` in a terminal.",
      );
    await this.pending?.cancel().catch(() => undefined);
    this.pending = await this.tg(() => this.connector.startUserLogin(phone, creds));
    this.phase = "code_required";
    this.store.setState("phone_number", digits);
    return this.connectResult(digits, "code_required");
  }

  private connectResult(phone: string | null, status: "code_required" | "connected") {
    return { success: true as const, phone_number: phone, status, session_id: "local", account_id: "local" };
  }

  async submitCode(input: { phoneNumber: string; code: string }) {
    const phone = this.checkPhone(input.phoneNumber);
    const pending = this.pending;
    if (!pending || this.phase !== "code_required")
      throw new ToolError("code_required", "No login is waiting for a code. Call connect_telegram first.");
    const code = String(input.code ?? "").replace(/\D/g, "");
    if (!code) throw new ToolError("invalid_code", "The code is the digits Telegram sent you.");
    const r = await this.tg(() => pending.submitCode(code));
    if (r.status === "password_required") {
      this.phase = "password_required";
      return this.loginResult(phone, "password_required", r.hint ? { hint: r.hint } : {});
    }
    await this.finishLogin(r.port);
    return this.loginResult(phone, "connected");
  }

  async submitPassword(input: { phoneNumber: string; password: string }) {
    const phone = this.checkPhone(input.phoneNumber);
    const pending = this.pending;
    if (!pending || this.phase !== "password_required")
      throw new ToolError("password_required", "No login is waiting for a password. Call connect_telegram first.");
    const port = await this.tg(() => pending.submitPassword(String(input.password ?? "")));
    await this.finishLogin(port);
    return this.loginResult(phone, "connected");
  }

  private async finishLogin(port: TelegramPort): Promise<void> {
    saveSession(this.paths, port.exportSession());
    this.store.setState("connected_at", new Date(this.clock.now()).toISOString());
    await this.port?.disconnect().catch(() => undefined);
    await this.attach(port);
  }

  async disconnectTelegram(input: { phoneNumber: string }): Promise<{ success: true; phone_number: string | null; status: "removed" }> {
    const phone = this.checkPhone(input.phoneNumber);
    await this.logOutLocal();
    return { success: true, phone_number: phone, status: "removed" };
  }

  /** Logs out of Telegram (best effort) and removes the local session and the remembered number. */
  private async logOutLocal(): Promise<void> {
    const port = this.port;
    this.port = undefined;
    this.phase = "disconnected";
    await this.pending?.cancel().catch(() => undefined);
    this.pending = undefined;
    if (port) {
      await port.logOut().catch((e) => log.warn("logout call failed, removing the local session anyway", e));
      await port.disconnect().catch(() => undefined);
    }
    deleteSession(this.paths);
    this.store.setState("connected_at", undefined);
    this.store.setState("phone_number", undefined);
    this.guard.clearAuthProblem();
  }

  // ---------------------------------------------------------------- messaging tools

  async sendMessage(input: {
    account_id?: string;
    to: Recipient;
    text?: string;
    media_url?: string;
    media_path?: string;
    reply_to?: string;
    opt_in?: boolean;
  }): Promise<{ message_id: string; status: "sent"; reply_to_applied: boolean }> {
    this.checkAccount(input.account_id);
    const text = input.text ?? "";
    const hasMedia = !!(input.media_url || input.media_path);
    if (input.media_url && input.media_path)
      throw new ToolError("invalid_input", "Pass media_url or media_path, not both.");
    if (!text.trim()) throw new ToolError("invalid_text", "text is required: the message, or the caption when media is attached.");
    if (text.length > MAX_TEXT) throw new ToolError("invalid_text", `text is longer than ${MAX_TEXT} characters.`);
    if (hasMedia && text.length > MAX_CAPTION)
      throw new ToolError("invalid_text", `A media caption is limited to ${MAX_CAPTION} characters. Send the text as its own message.`);
    if (input.opt_in) log.debug("send_message with opt_in: true (accepted; self-hosted limits apply as usual)");

    let file: string | undefined;
    if (input.media_url) {
      let u: URL;
      try {
        u = new URL(input.media_url);
      } catch {
        throw new ToolError("invalid_media_url", "media_url is not a valid URL.");
      }
      if (u.protocol !== "https:") throw new ToolError("invalid_media_url", "media_url must be an https URL.");
      file = u.toString();
    } else if (input.media_path) {
      const p = resolve(input.media_path.replace(/^~(?=$|\/)/, homedir()));
      if (!existsSync(p) || !statSync(p).isFile())
        throw new ToolError("media_unavailable", `No file at ${p}.`);
      if (statSync(p).size > MAX_UPLOAD) throw new ToolError("media_unavailable", "The file is larger than Telegram's 2 GB limit.");
      file = p;
    }

    const port = this.requirePort();
    const chat = await this.resolveRecipient(input.to);

    let replyTo: number | undefined;
    if (input.reply_to !== undefined && input.reply_to !== "") {
      const raw = String(input.reply_to);
      const parsed = parseMessageId(raw);
      if (parsed) {
        if (parsed.chatId !== chat.id)
          throw new ToolError("invalid_reply_to", "reply_to belongs to a different chat than the recipient.");
        replyTo = parsed.msgId;
      } else if (/^\d+$/.test(raw)) replyTo = Number(raw);
      else throw new ToolError("invalid_reply_to", "reply_to must be a message id from this server.");
    }

    const newContact = await this.isNewContact(chat);
    const limits = this.config().limits;
    const sent = await this.guard.run({ chatId: chat.id, kind: file ? "media" : "text", newContact }, async () => {
      if (port.mode === "user" && limits.typing_indicator && !file && text) {
        await port.setTyping(chat).catch(() => undefined);
        await this.clock.sleep(typingMs(text));
      }
      return file
        ? port.sendFile(chat, file, { caption: text || undefined, replyTo })
        : port.sendText(chat, text, replyTo);
    });
    const m = { ...sent, chatId: sent.chatId || chat.id, outgoing: true };
    this.store.insertMessage(m);
    return { message_id: messageId(m.chatId, m.id), status: "sent", reply_to_applied: replyTo !== undefined };
  }

  async getMessage(input: { id: string }): Promise<WireMessage> {
    this.checkAccount();
    const p = parseMessageId(String(input.id ?? ""));
    if (!p) throw new ToolError("invalid_input", "id must be a message id from this server, like 123456:42.");
    let m = this.store.getMessage(p.chatId, p.msgId);
    if (!m && this.mode === "user" && this.connected) {
      const chat = this.store.getChat(p.chatId);
      if (chat) {
        const port = this.requirePort();
        const r = await this.tg(() => port.getHistory(chat, { limit: 1, offsetId: p.msgId + 1 }));
        this.ingest(r);
        m = this.store.getMessage(p.chatId, p.msgId);
      }
    }
    if (!m) throw new ToolError("message_not_found", `Message ${input.id} was not found.`);
    return this.wire(m);
  }

  async listMessages(input: {
    account_id?: string;
    limit?: number;
    direction?: "inbound" | "outbound";
    before?: string;
    chat_id?: string;
  }): Promise<{ messages: WireMessage[]; next_cursor: string | null }> {
    this.checkAccount(input.account_id);
    const limit = clamp(input.limit ?? 50, 1, 100);
    let before: { date: number; seq: number } | undefined;
    if (input.before) {
      const m = /^(\d+)\.(\d+)$/.exec(input.before);
      if (!m) throw new ToolError("invalid_cursor", "before must be a next_cursor value returned by list_messages.");
      before = { date: Number(m[1]), seq: Number(m[2]) };
    }
    const chat = await this.chatFilter(input.chat_id);
    if (chat === null) return { messages: [], next_cursor: null };
    if (chat && this.mode === "user" && this.connected) {
      const port = this.requirePort();
      let offsetId: number | undefined;
      if (before) {
        const anchor = this.store.getMessageBySeq(before.seq);
        offsetId = anchor && anchor.chatId === chat.id ? anchor.id : undefined;
      }
      if (!before || offsetId) {
        const c = chat;
        const r = await this.tg(() => port.getHistory(c, { limit, offsetId }));
        this.ingest(r);
      }
    } else if (!this.connected && this.store.counts().messages === 0) {
      this.requirePort();
    }
    const rows = this.store.listMessages({ limit: limit + 1, chatId: chat?.id, direction: input.direction, before });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      messages: page.map((m) => this.wire(m)),
      next_cursor: rows.length > limit && last ? `${last.date}.${last.seq}` : null,
    };
  }

  async waitForMessages(
    input: { account_id?: string; cursor?: string; timeout_s?: number; chat_id?: string },
    signal?: AbortSignal,
  ): Promise<{ messages: WireMessage[]; cursor: string }> {
    this.checkAccount(input.account_id);
    if (!this.connected) this.requirePort();
    const timeoutMs = clamp(input.timeout_s ?? 25, 0, 55) * 1000;
    let cursor: number;
    if (input.cursor !== undefined && input.cursor !== "") {
      if (!/^\d+$/.test(String(input.cursor)))
        throw new ToolError("invalid_cursor", "cursor must be a cursor value returned by wait_for_messages.");
      cursor = Number(input.cursor);
    } else cursor = this.store.maxSeq();
    const chat = await this.chatFilter(input.chat_id);
    if (chat === null) return { messages: [], cursor: String(cursor) };

    const take = () => this.store.inboundAfter(cursor, chat?.id, 100);
    let found = take();
    if (!found.length && timeoutMs > 0) {
      await new Promise<void>((done) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.waiters.delete(check);
          signal?.removeEventListener("abort", finish);
          done();
        };
        const check = () => {
          if (take().length) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        this.waiters.add(check);
        signal?.addEventListener("abort", finish);
      });
      found = take();
    }
    const next = found.length ? found[found.length - 1].seq : cursor;
    return { messages: found.map((m) => this.wire(m)), cursor: String(next) };
  }

  async listChats(input: {
    account_id?: string;
    query?: string;
    limit?: number;
    type?: ChatType;
  }): Promise<{
    chats: { chat_id: string; channel: "telegram"; name: string; type: ChatType; unread_count: number; last_message_at: string | null; username?: string }[];
  }> {
    this.checkAccount(input.account_id);
    const limit = clamp(input.limit ?? 50, 1, 200);
    if (this.mode === "user") {
      if (this.connected) await this.refreshDialogs(Math.max(100, Math.min(500, input.query || input.type ? 500 : limit)));
      else if (this.store.counts().chats === 0) this.requirePort();
    }
    const chats = this.store.listChats({ query: input.query?.trim() || undefined, type: input.type, limit });
    return {
      chats: chats
        .filter((c) => !(this.me && c.id === this.me.id && !c.lastMessageAt))
        .map((c) => ({
          chat_id: c.id,
          channel: CHANNEL,
          name: c.title,
          type: c.type,
          unread_count: c.unreadCount ?? 0,
          last_message_at: c.lastMessageAt ? new Date(c.lastMessageAt * 1000).toISOString() : null,
          ...(c.username ? { username: c.username } : {}),
        })),
    };
  }

  async searchMessages(input: {
    query: string;
    account_id?: string;
    chat_id?: string;
    limit?: number;
  }): Promise<{ messages: WireMessage[] }> {
    this.checkAccount(input.account_id);
    const query = String(input.query ?? "").trim();
    if (query.length < 2) throw new ToolError("invalid_query", "query needs at least 2 characters.");
    const limit = clamp(input.limit ?? 20, 1, 100);
    const chat = await this.chatFilter(input.chat_id);
    if (chat === null) return { messages: [] };
    const seen = new Map<string, StoredMessage>();
    if (this.mode === "user" && this.connected) {
      const port = this.requirePort();
      const r = await this.tg(() => (chat ? port.searchChat(chat, query, limit) : port.searchGlobal(query, limit)));
      for (const m of this.ingest(r)) seen.set(messageId(m.chatId, m.id), m);
    }
    for (const m of this.store.searchMessages(query, { chatId: chat?.id, limit }))
      if (!seen.has(messageId(m.chatId, m.id))) seen.set(messageId(m.chatId, m.id), m);
    const all = [...seen.values()].sort((a, b) => b.date - a.date || b.seq - a.seq).slice(0, limit);
    return { messages: all.map((m) => this.wire(m)) };
  }

  async markRead(input: { chat_id: string; account_id?: string }): Promise<{ marked: true; receipt_sent: boolean }> {
    this.checkAccount(input.account_id);
    if (this.mode === "bot") this.notForBots("mark_read");
    const port = this.requirePort();
    const chat = await this.resolveChatId(input.chat_id);
    await this.tg(() => port.markRead(chat));
    this.store.setUnread(chat.id, 0);
    return { marked: true, receipt_sent: true };
  }
}

function clamp(n: number, min: number, max: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}
