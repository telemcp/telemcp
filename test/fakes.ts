import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS, type Config } from "../src/config.js";
import { Store } from "../src/db.js";
import type { Clock } from "../src/limits.js";
import { resolvePaths } from "../src/paths.js";
import type { ApiCreds, CodeResult, Connector, FetchResult, IncomingEvent, PendingLogin, TelegramPort } from "../src/port.js";
import { TeleService } from "../src/service.js";
import type { ChatInfo, MeInfo, MessageInfo } from "../src/types.js";

export class FakeClock implements Clock {
  t: number;
  slept: number[] = [];
  constructor(start = new Date(2026, 0, 15, 10, 0, 0).getTime()) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.slept.push(ms);
    this.t += ms;
  }
  random() {
    return 0.5;
  }
}

export function rpcError(errorMessage: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(errorMessage), { errorMessage, ...extra });
}

export class FakePort implements TelegramPort {
  sent: { chat: ChatInfo; text?: string; file?: string; replyTo?: number }[] = [];
  typing: string[] = [];
  read: string[] = [];
  history = new Map<string, MessageInfo[]>();
  usernames = new Map<string, ChatInfo>();
  contacts = new Map<string, ChatInfo>();
  dialogs: (ChatInfo & { unreadCount: number })[] = [];
  nextError?: Error;
  private handlers: ((e: IncomingEvent) => void)[] = [];
  private nextId = 1000;
  calls: string[] = [];

  constructor(
    readonly mode: "user" | "bot" = "user",
    readonly self: MeInfo = { id: "1", name: "Me", username: "me_user", isBot: mode === "bot" },
  ) {}

  private maybeFail(name: string) {
    this.calls.push(name);
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = undefined;
      throw e;
    }
  }
  async me() {
    return this.self;
  }
  async listDialogs(limit: number) {
    this.maybeFail("listDialogs");
    return { chats: this.dialogs.slice(0, limit), messages: [] };
  }
  async resolveUsername(u: string) {
    this.maybeFail("resolveUsername");
    return this.usernames.get(u.toLowerCase());
  }
  async findContactByPhone(p: string) {
    this.maybeFail("findContactByPhone");
    return this.contacts.get(p.replace(/\D/g, ""));
  }
  async getHistory(chat: ChatInfo, opts: { limit: number; offsetId?: number }): Promise<FetchResult> {
    this.maybeFail("getHistory");
    const all = (this.history.get(chat.id) ?? []).filter((m) => !opts.offsetId || m.id < opts.offsetId).sort((a, b) => b.id - a.id);
    return { messages: all.slice(0, opts.limit), chats: [chat], users: [] };
  }
  async searchGlobal(q: string, limit: number): Promise<FetchResult> {
    this.maybeFail("searchGlobal");
    const msgs = [...this.history.values()].flat().filter((m) => m.text.includes(q));
    return { messages: msgs.slice(0, limit), chats: [], users: [] };
  }
  async searchChat(chat: ChatInfo, q: string, limit: number): Promise<FetchResult> {
    this.maybeFail("searchChat");
    return { messages: (this.history.get(chat.id) ?? []).filter((m) => m.text.includes(q)).slice(0, limit), chats: [chat], users: [] };
  }
  async sendText(chat: ChatInfo, text: string, replyTo?: number): Promise<MessageInfo> {
    this.maybeFail("sendText");
    this.sent.push({ chat, text, replyTo });
    return { chatId: chat.id, id: this.nextId++, outgoing: true, date: 1_768_000_000, text, replyTo };
  }
  async sendFile(chat: ChatInfo, file: string, opts: { caption?: string; replyTo?: number }): Promise<MessageInfo> {
    this.maybeFail("sendFile");
    this.sent.push({ chat, file, text: opts.caption, replyTo: opts.replyTo });
    return { chatId: chat.id, id: this.nextId++, outgoing: true, date: 1_768_000_000, text: opts.caption ?? "", media: "image/jpeg" };
  }
  async setTyping(chat: ChatInfo) {
    this.typing.push(chat.id);
  }
  async markRead(chat: ChatInfo) {
    this.maybeFail("markRead");
    this.read.push(chat.id);
  }
  onMessage(cb: (e: IncomingEvent) => void) {
    this.handlers.push(cb);
  }
  emit(e: IncomingEvent) {
    for (const h of this.handlers) h(e);
  }
  exportSession() {
    return "fake-session";
  }
  async logOut() {}
  async disconnect() {}
}

export class FakeConnector implements Connector {
  constructor(public port: FakePort = new FakePort()) {}
  passwordNeeded = false;
  async fromSession(_s: string, _c: ApiCreds) {
    return this.port;
  }
  async loginBot(_t: string, _c: ApiCreds) {
    return this.port;
  }
  async startUserLogin(phone: string): Promise<PendingLogin> {
    const port = this.port;
    const needPw = this.passwordNeeded;
    return {
      phone,
      codeViaApp: true,
      async submitCode(code: string): Promise<CodeResult> {
        if (code !== "12345") throw rpcError("PHONE_CODE_INVALID");
        return needPw ? { status: "password_required", hint: "pet" } : { status: "connected", port };
      },
      async submitPassword(pw: string) {
        if (pw !== "secret") throw rpcError("PASSWORD_HASH_INVALID");
        return port;
      },
      async cancel() {},
    };
  }
}

export const alice: ChatInfo = { id: "100", type: "user", kind: "user", title: "Alice", username: "alice", accessHash: "5" };
export const bob: ChatInfo = { id: "200", type: "user", kind: "user", title: "Bob", username: "bobby", accessHash: "6" };
export const group: ChatInfo = { id: "-300", type: "group", kind: "chat", title: "Book Club" };
export const channel: ChatInfo = { id: "-100400", type: "channel", kind: "channel", title: "News", username: "newsch", accessHash: "7" };

export function makeService(opts: { mode?: "user" | "bot"; config?: Partial<Config["limits"]>; port?: FakePort } = {}) {
  const home = mkdtempSync(join(tmpdir(), "telemcp-test-"));
  const paths = resolvePaths(home);
  const clock = new FakeClock();
  const store = new Store(":memory:", () => clock.now());
  const port = opts.port ?? new FakePort(opts.mode ?? "user");
  const connector = new FakeConnector(port);
  const service = new TeleService({
    paths,
    store,
    connector,
    clock,
    env: { TELEGRAM_API_ID: "1", TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef" },
    config: { limits: { ...DEFAULT_LIMITS, ...opts.config } },
  });
  return { service, store, port, connector, clock, paths, home };
}

export function msg(chat: ChatInfo, id: number, text: string, outgoing = false, date = 1_767_000_000 + id): MessageInfo {
  return { chatId: chat.id, id, text, outgoing, date, senderId: outgoing ? "1" : chat.type === "user" ? chat.id : "900" };
}
