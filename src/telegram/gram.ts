// TelegramPort on top of GramJS (the `telegram` package). Both user accounts and bots use this one path.

import bigInt from "big-integer";
import { release } from "node:os";
import { Api, TelegramClient, utils } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";
import { log } from "../log.js";
import type { ApiCreds, CodeResult, Connector, DialogResult, FetchResult, IncomingEvent, PendingLogin, TelegramPort } from "../port.js";
import type { ChatInfo, MeInfo, MessageInfo, UserInfo } from "../types.js";
import { VERSION } from "../version.js";

/** GramJS logs through console.log by default; this keeps it on stderr and quiet. */
class StderrLogger extends Logger {
  constructor() {
    super((process.env.TELEMCP_TELEGRAM_LOG_LEVEL as LogLevel) || LogLevel.ERROR);
  }
  override log(level: LogLevel, message: string): void {
    process.stderr.write(`[telemcp] telegram ${level}: ${message}\n`);
  }
}

function newClient(session: string, creds: ApiCreds): TelegramClient {
  const client = new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    // Never sleep and retry inside a FLOOD_WAIT: surface it so telemcp can pause and report it.
    floodSleepThreshold: 0,
    baseLogger: new StderrLogger(),
    deviceModel: "telemcp",
    systemVersion: `${process.platform} ${release()}`,
    appVersion: VERSION,
  });
  client.setParseMode(undefined);
  return client;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return v.toString();
}

function fullName(first?: string, last?: string): string {
  return [first, last].filter(Boolean).join(" ").trim();
}

export function userToInfo(u: Api.User): UserInfo {
  return {
    id: u.id.toString(),
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    username: u.username ?? u.usernames?.find((x) => x.active)?.username ?? undefined,
    isBot: !!u.bot,
    accessHash: str(u.accessHash),
  };
}

export function entityToChat(e: unknown): ChatInfo | undefined {
  if (e instanceof Api.User) {
    const u = userToInfo(e);
    return {
      id: u.id,
      type: "user",
      kind: "user",
      title: fullName(u.firstName, u.lastName) || (u.username ? "@" + u.username : u.id),
      username: u.username,
      accessHash: u.accessHash,
      isBot: u.isBot,
    };
  }
  if (e instanceof Api.Chat || e instanceof Api.ChatForbidden) {
    return { id: `-${e.id.toString()}`, type: "group", kind: "chat", title: e.title ?? "" };
  }
  if (e instanceof Api.Channel) {
    return {
      id: `-100${e.id.toString()}`,
      type: e.megagroup || e.gigagroup ? "group" : "channel",
      kind: "channel",
      title: e.title ?? "",
      username: e.username ?? e.usernames?.find((x) => x.active)?.username ?? undefined,
      accessHash: str(e.accessHash),
    };
  }
  if (e instanceof Api.ChannelForbidden) {
    return {
      id: `-100${e.id.toString()}`,
      type: e.megagroup ? "group" : "channel",
      kind: "channel",
      title: e.title ?? "",
      accessHash: str(e.accessHash),
    };
  }
  return undefined;
}

export function inputPeer(c: ChatInfo, selfId?: string): Api.TypeInputPeer {
  if (selfId && c.id === selfId) return new Api.InputPeerSelf();
  if (c.kind === "user") return new Api.InputPeerUser({ userId: bigInt(c.id), accessHash: bigInt(c.accessHash ?? "0") });
  if (c.kind === "chat") return new Api.InputPeerChat({ chatId: bigInt(c.id.replace(/^-/, "")) });
  return new Api.InputPeerChannel({ channelId: bigInt(c.id.replace(/^-100/, "")), accessHash: bigInt(c.accessHash ?? "0") });
}

function mediaType(m: Api.Message): string | undefined {
  const media = m.media;
  if (!media) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return "image/jpeg";
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) return media.document.mimeType || "application/octet-stream";
  if (media instanceof Api.MessageMediaWebPage) return undefined;
  return "application/x-telegram-" + media.className.replace(/^MessageMedia/, "").toLowerCase();
}

export function messageToInfo(m: Api.Message, names?: Map<string, string>): MessageInfo | undefined {
  if (!(m instanceof Api.Message)) return undefined;
  const chatId = utils.getPeerId(m.peerId);
  let senderId = m.fromId ? utils.getPeerId(m.fromId) : undefined;
  if (!senderId && m.peerId instanceof Api.PeerUser) senderId = m.out ? undefined : chatId;
  const replyTo = m.replyTo instanceof Api.MessageReplyHeader ? m.replyTo.replyToMsgId : undefined;
  return {
    chatId,
    id: m.id,
    senderId,
    senderName: senderId ? names?.get(senderId) : undefined,
    outgoing: !!m.out,
    date: m.date,
    text: m.message ?? "",
    media: mediaType(m),
    replyTo: replyTo ?? undefined,
  };
}

function collect(res: { messages?: Api.TypeMessage[]; chats?: Api.TypeChat[]; users?: Api.TypeUser[] }): FetchResult {
  const users = (res.users ?? []).filter((u): u is Api.User => u instanceof Api.User).map(userToInfo);
  const chats = [...(res.users ?? []), ...(res.chats ?? [])].map(entityToChat).filter((c): c is ChatInfo => !!c);
  const names = new Map<string, string>();
  for (const u of users) names.set(u.id, fullName(u.firstName, u.lastName) || (u.username ? "@" + u.username : u.id));
  for (const c of chats) if (!names.has(c.id)) names.set(c.id, c.title);
  const messages = (res.messages ?? [])
    .map((m) => (m instanceof Api.Message ? messageToInfo(m, names) : undefined))
    .filter((m): m is MessageInfo => !!m);
  return { messages, chats, users };
}

class GramPort implements TelegramPort {
  private self?: MeInfo;
  private handlers: ((e: IncomingEvent) => void)[] = [];
  private listening = false;

  constructor(
    readonly client: TelegramClient,
    readonly mode: "user" | "bot",
  ) {}

  async me(): Promise<MeInfo> {
    if (this.self) return this.self;
    const u = (await this.client.getMe()) as Api.User;
    this.self = {
      id: u.id.toString(),
      name: fullName(u.firstName ?? undefined, u.lastName ?? undefined) || u.username || u.id.toString(),
      username: u.username ?? undefined,
      isBot: !!u.bot,
      phone: u.phone ? "+" + u.phone : undefined,
    };
    return this.self;
  }

  private peer(c: ChatInfo): Api.TypeInputPeer {
    return inputPeer(c, this.self?.id);
  }

  async listDialogs(limit: number): Promise<DialogResult> {
    const dialogs = await this.client.getDialogs({ limit });
    const chats: DialogResult["chats"] = [];
    const messages: MessageInfo[] = [];
    for (const d of dialogs) {
      const c = entityToChat(d.entity);
      if (!c) continue;
      chats.push({ ...c, unreadCount: d.unreadCount ?? 0, lastMessageAt: d.date || undefined });
      if (d.message instanceof Api.Message) {
        const m = messageToInfo(d.message);
        if (m) messages.push(m);
      }
    }
    return { chats, messages };
  }

  async resolveUsername(username: string): Promise<ChatInfo | undefined> {
    const r = await this.client.invoke(new Api.contacts.ResolveUsername({ username }));
    const want = utils.getPeerId(r.peer);
    return [...r.users, ...r.chats].map(entityToChat).find((c) => c?.id === want);
  }

  async findContactByPhone(phone: string): Promise<ChatInfo | undefined> {
    const digits = phone.replace(/\D/g, "");
    const r = await this.client.invoke(new Api.contacts.GetContacts({ hash: bigInt(0) }));
    if (!(r instanceof Api.contacts.Contacts)) return undefined;
    const u = r.users.find((x) => x instanceof Api.User && x.phone && x.phone.replace(/\D/g, "") === digits);
    return u ? entityToChat(u) : undefined;
  }

  async getHistory(chat: ChatInfo, opts: { limit: number; offsetId?: number }): Promise<FetchResult> {
    const r = await this.client.invoke(
      new Api.messages.GetHistory({
        peer: this.peer(chat),
        offsetId: opts.offsetId ?? 0,
        offsetDate: 0,
        addOffset: 0,
        limit: opts.limit,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    );
    if (r instanceof Api.messages.MessagesNotModified) return { messages: [], chats: [], users: [] };
    return collect(r);
  }

  async searchGlobal(query: string, limit: number): Promise<FetchResult> {
    const r = await this.client.invoke(
      new Api.messages.SearchGlobal({
        q: query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetRate: 0,
        offsetPeer: new Api.InputPeerEmpty(),
        offsetId: 0,
        limit,
      }),
    );
    if (r instanceof Api.messages.MessagesNotModified) return { messages: [], chats: [], users: [] };
    return collect(r);
  }

  async searchChat(chat: ChatInfo, query: string, limit: number): Promise<FetchResult> {
    const r = await this.client.invoke(
      new Api.messages.Search({
        peer: this.peer(chat),
        q: query,
        filter: new Api.InputMessagesFilterEmpty(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: bigInt(0),
      }),
    );
    if (r instanceof Api.messages.MessagesNotModified) return { messages: [], chats: [], users: [] };
    return collect(r);
  }

  private sentInfo(m: Api.Message, chat: ChatInfo): MessageInfo {
    const info = messageToInfo(m);
    return info ? { ...info, chatId: info.chatId || chat.id, outgoing: true } : { chatId: chat.id, id: m.id, outgoing: true, date: Math.floor(Date.now() / 1000), text: "" };
  }

  async sendText(chat: ChatInfo, text: string, replyTo?: number): Promise<MessageInfo> {
    const m = await this.client.sendMessage(this.peer(chat), { message: text, replyTo, parseMode: undefined, linkPreview: true });
    return this.sentInfo(m, chat);
  }

  async sendFile(chat: ChatInfo, file: string, opts: { caption?: string; replyTo?: number }): Promise<MessageInfo> {
    const m = await this.client.sendFile(this.peer(chat), { file, caption: opts.caption, replyTo: opts.replyTo, workers: 1 });
    return this.sentInfo(m, chat);
  }

  async setTyping(chat: ChatInfo): Promise<void> {
    await this.client.invoke(new Api.messages.SetTyping({ peer: this.peer(chat), action: new Api.SendMessageTypingAction() }));
  }

  async markRead(chat: ChatInfo): Promise<void> {
    await this.client.markAsRead(this.peer(chat));
  }

  onMessage(cb: (e: IncomingEvent) => void): void {
    this.handlers.push(cb);
    if (this.listening) return;
    this.listening = true;
    this.client.addEventHandler(async (event: NewMessageEvent) => {
      try {
        const m = event.message;
        const info = messageToInfo(m);
        if (!info) return;
        let chat: ChatInfo | undefined;
        let sender: UserInfo | undefined;
        try {
          chat = entityToChat(await m.getChat());
        } catch {
          // entity not available; fall back below
        }
        try {
          const s = await m.getSender();
          if (s instanceof Api.User) sender = userToInfo(s);
        } catch {
          // sender not available
        }
        if (!chat) {
          const isUser = m.peerId instanceof Api.PeerUser;
          const isChannel = m.peerId instanceof Api.PeerChannel;
          chat = { id: info.chatId, type: isUser ? "user" : "group", kind: isUser ? "user" : isChannel ? "channel" : "chat", title: "" };
        }
        if (sender) info.senderName = fullName(sender.firstName, sender.lastName) || sender.username;
        for (const h of this.handlers) h({ message: info, chat, sender });
      } catch (err) {
        log.warn("could not process an incoming message", err);
      }
    }, new NewMessage({}));
  }

  exportSession(): string {
    return (this.client.session as StringSession).save();
  }

  async logOut(): Promise<void> {
    await this.client.invoke(new Api.auth.LogOut());
  }

  async disconnect(): Promise<void> {
    await this.client.destroy().catch(() => this.client.disconnect());
  }
}

class GramPendingLogin implements PendingLogin {
  constructor(
    private client: TelegramClient,
    readonly phone: string,
    private phoneCodeHash: string,
    readonly codeViaApp: boolean,
  ) {}

  async submitCode(code: string): Promise<CodeResult> {
    try {
      const r = await this.client.invoke(new Api.auth.SignIn({ phoneNumber: this.phone, phoneCodeHash: this.phoneCodeHash, phoneCode: code }));
      if (r instanceof Api.auth.AuthorizationSignUpRequired)
        throw Object.assign(new Error("PHONE_NUMBER_UNOCCUPIED"), { errorMessage: "PHONE_NUMBER_UNOCCUPIED" });
      return { status: "connected", port: await this.done() };
    } catch (err) {
      if ((err as { errorMessage?: string }).errorMessage === "SESSION_PASSWORD_NEEDED") {
        let hint: string | undefined;
        try {
          hint = (await this.client.invoke(new Api.account.GetPassword())).hint ?? undefined;
        } catch {
          // no hint
        }
        return { status: "password_required", hint };
      }
      throw err;
    }
  }

  async submitPassword(password: string): Promise<TelegramPort> {
    const pwd = await this.client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(pwd, password);
    await this.client.invoke(new Api.auth.CheckPassword({ password: check }));
    return this.done();
  }

  private async done(): Promise<TelegramPort> {
    const port = new GramPort(this.client, "user");
    await port.me();
    return port;
  }

  async cancel(): Promise<void> {
    await this.client.destroy().catch(() => undefined);
  }
}

export const gramConnector: Connector = {
  async fromSession(session, creds) {
    const client = newClient(session, creds);
    try {
      await client.connect();
      const probe = new GramPort(client, "user");
      const me = await probe.me();
      if (!me.isBot) return probe;
      const port = new GramPort(client, "bot");
      await port.me();
      return port;
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw err;
    }
  },

  async loginBot(token, creds) {
    const client = newClient("", creds);
    try {
      await client.connect();
      await client.signInBot({ apiId: creds.apiId, apiHash: creds.apiHash }, { botAuthToken: token });
      const port = new GramPort(client, "bot");
      await port.me();
      return port;
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw err;
    }
  },

  async startUserLogin(phone, creds) {
    const client = newClient("", creds);
    try {
      await client.connect();
      const r = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, phone);
      return new GramPendingLogin(client, phone, r.phoneCodeHash, r.isCodeViaApp);
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw err;
    }
  },
};
