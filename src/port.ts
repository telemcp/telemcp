// The narrow surface telemcp needs from Telegram. The GramJS implementation lives in telegram/gram.ts,
// tests use a fake. Keeping it small keeps the tool logic testable without a network.

import type { ChatInfo, MeInfo, MessageInfo, UserInfo } from "./types.js";

export interface IncomingEvent {
  message: MessageInfo;
  chat: ChatInfo;
  sender?: UserInfo;
}

export interface FetchResult {
  messages: MessageInfo[];
  chats: ChatInfo[];
  users: UserInfo[];
}

export interface DialogResult {
  chats: (ChatInfo & { unreadCount: number })[];
  messages: MessageInfo[];
}

export interface TelegramPort {
  readonly mode: "user" | "bot";
  me(): Promise<MeInfo>;
  /** User mode only. */
  listDialogs(limit: number): Promise<DialogResult>;
  resolveUsername(username: string): Promise<ChatInfo | undefined>;
  /** User mode only: look the phone number up in the account's own contact list. */
  findContactByPhone(phone: string): Promise<ChatInfo | undefined>;
  /** User mode only. Newest first. */
  getHistory(chat: ChatInfo, opts: { limit: number; offsetId?: number }): Promise<FetchResult>;
  /** User mode only. */
  searchGlobal(query: string, limit: number): Promise<FetchResult>;
  /** User mode only. */
  searchChat(chat: ChatInfo, query: string, limit: number): Promise<FetchResult>;
  sendText(chat: ChatInfo, text: string, replyTo?: number): Promise<MessageInfo>;
  /** `file` is a local path or an https URL that Telegram fetches itself. */
  sendFile(chat: ChatInfo, file: string, opts: { caption?: string; replyTo?: number }): Promise<MessageInfo>;
  setTyping(chat: ChatInfo): Promise<void>;
  /** User mode only. */
  markRead(chat: ChatInfo): Promise<void>;
  onMessage(cb: (e: IncomingEvent) => void): void;
  exportSession(): string;
  logOut(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ApiCreds {
  apiId: number;
  apiHash: string;
}

export type CodeResult = { status: "connected"; port: TelegramPort } | { status: "password_required"; hint?: string };

/** An in-progress user login: code sent, waiting for the code and maybe the 2FA password. */
export interface PendingLogin {
  readonly phone: string;
  readonly codeViaApp: boolean;
  submitCode(code: string): Promise<CodeResult>;
  submitPassword(password: string): Promise<TelegramPort>;
  cancel(): Promise<void>;
}

export interface Connector {
  /** Reconnect with a saved session. Throws a Telegram error when the session is no longer valid. */
  fromSession(session: string, creds: ApiCreds): Promise<TelegramPort>;
  loginBot(token: string, creds: ApiCreds): Promise<TelegramPort>;
  startUserLogin(phone: string, creds: ApiCreds): Promise<PendingLogin>;
}
