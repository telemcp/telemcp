// Door contract v1 output shapes (WireMessage, WireAccount) for the Telegram channel.

import type { ChatInfo, StoredMessage, UserInfo } from "./types.js";

export const CONTRACT_VERSION = "1.0";
export const CHANNEL = "telegram";

export interface WireContact {
  id: string;
  name?: string;
  phone?: string;
  telegram_user_id?: string;
  telegram_username?: string;
}

export interface WireMessage {
  id: string;
  account_id: string;
  channel: "telegram";
  direction: "inbound" | "outbound";
  text: string;
  media?: { url?: string; content_type: string };
  status: string;
  timestamp: string;
  contact: WireContact;
  chat_id: string;
  chat_name?: string;
  reply_to?: string;
}

export interface WireAccount {
  id: string;
  channel: "telegram";
  connect_kind: "user" | "bot";
  identifier: string | null;
  status: "connected" | "connecting" | "disconnected" | "restricted";
  connected_at: string | null;
  limits: {
    sends_today: number;
    sends_cap: number;
    new_contacts_today: number;
    new_contacts_cap: number;
    ramp_day: number | null;
  };
}

/** Message ids are `<chat_id>:<telegram message id>`, because Telegram message ids are only unique per chat. */
export function messageId(chatId: string, msgId: number): string {
  return `${chatId}:${msgId}`;
}

export function parseMessageId(id: string): { chatId: string; msgId: number } | undefined {
  const m = /^(-?\d+):(\d+)$/.exec(id.trim());
  if (!m) return undefined;
  return { chatId: m[1], msgId: Number(m[2]) };
}

export function userName(u: Pick<UserInfo, "firstName" | "lastName" | "username">): string | undefined {
  const n = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return n || (u.username ? "@" + u.username : undefined);
}

export function toWireMessage(
  m: StoredMessage,
  ctx: {
    accountId: string;
    chat?: ChatInfo;
    sender?: UserInfo;
  },
): WireMessage {
  const chat = ctx.chat;
  const isPrivate = !chat || chat.type === "user";
  let contact: WireContact;
  if (isPrivate) {
    contact = {
      id: m.chatId,
      name: chat?.title || m.chatTitle || undefined,
      telegram_user_id: m.chatId,
      telegram_username: chat?.username,
    };
  } else if (m.senderId) {
    contact = {
      id: m.senderId,
      name: (ctx.sender && userName(ctx.sender)) || m.senderName,
      telegram_user_id: m.senderId.startsWith("-") ? undefined : m.senderId,
      telegram_username: ctx.sender?.username,
    };
  } else {
    contact = { id: m.chatId, name: chat?.title || m.chatTitle || undefined };
  }
  for (const k of Object.keys(contact) as (keyof WireContact)[]) if (contact[k] === undefined) delete contact[k];
  const out: WireMessage = {
    id: messageId(m.chatId, m.id),
    account_id: ctx.accountId,
    channel: CHANNEL,
    direction: m.outgoing ? "outbound" : "inbound",
    text: m.text,
    status: m.outgoing ? "sent" : "received",
    timestamp: new Date(m.date * 1000).toISOString(),
    contact,
    chat_id: m.chatId,
  };
  const chatName = chat?.title || m.chatTitle;
  if (chatName) out.chat_name = chatName;
  if (m.media) out.media = { content_type: m.media };
  if (m.replyTo) out.reply_to = messageId(m.chatId, m.replyTo);
  return out;
}
