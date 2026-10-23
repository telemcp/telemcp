/** What the user sees: a private chat, a group (basic or supergroup), or a broadcast channel. */
export type ChatType = "user" | "group" | "channel";
/** What Telegram needs to address the peer. */
export type PeerKind = "user" | "chat" | "channel";

export interface ChatInfo {
  /** Marked peer id as a string: users positive, basic groups negative, channels -100 prefixed. */
  id: string;
  type: ChatType;
  kind: PeerKind;
  title: string;
  username?: string;
  accessHash?: string;
  isBot?: boolean;
  unreadCount?: number;
  lastMessageAt?: number;
}

export interface UserInfo {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  isBot?: boolean;
  accessHash?: string;
}

export interface MessageInfo {
  chatId: string;
  id: number;
  senderId?: string;
  senderName?: string;
  outgoing: boolean;
  /** Unix seconds. */
  date: number;
  text: string;
  media?: string;
  replyTo?: number;
}

export interface StoredMessage extends MessageInfo {
  /** Local insertion order, used as the wait_for_messages cursor. */
  seq: number;
  chatTitle?: string;
}

export interface MeInfo {
  id: string;
  name: string;
  username?: string;
  isBot: boolean;
  phone?: string;
}
