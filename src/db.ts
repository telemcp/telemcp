import Database from "better-sqlite3";
import { chmodSync, existsSync } from "node:fs";
import type { ChatInfo, ChatType, MessageInfo, StoredMessage, UserInfo } from "./types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  username TEXT,
  access_hash TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  unread_count INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_username ON chats(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  access_hash TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  msg_id INTEGER NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  outgoing INTEGER NOT NULL DEFAULT 0,
  date INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  media TEXT,
  reply_to INTEGER,
  inserted_at INTEGER NOT NULL,
  UNIQUE(chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS messages_chat_date ON messages(chat_id, msg_id DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='seq', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
END;

CREATE TABLE IF NOT EXISTS send_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  day TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  new_contact INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS send_ledger_day ON send_ledger(day, ok);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface ChatRow {
  id: string;
  type: ChatType;
  kind: ChatInfo["kind"];
  title: string;
  username: string | null;
  access_hash: string | null;
  is_bot: number;
  last_message_at: number | null;
  unread_count: number | null;
}

interface MessageRow {
  seq: number;
  chat_id: string;
  msg_id: number;
  sender_id: string | null;
  sender_name: string | null;
  outgoing: number;
  date: number;
  text: string;
  media: string | null;
  reply_to: number | null;
  chat_title?: string | null;
}

export interface LedgerEntry {
  at: number;
  day: string;
  chatId: string;
  kind: "text" | "media";
  newContact: boolean;
  ok: boolean;
  error?: string;
}

/** Local calendar day as YYYY-MM-DD; the daily caps reset at local midnight. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Turn free text into a safe FTS5 query: every word becomes a quoted term, all terms must match. */
export function ftsQuery(input: string): string | undefined {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" ") : undefined;
}

function toChat(r: ChatRow): ChatInfo {
  return {
    id: r.id,
    type: r.type,
    kind: r.kind,
    title: r.title,
    username: r.username ?? undefined,
    accessHash: r.access_hash ?? undefined,
    isBot: !!r.is_bot,
    lastMessageAt: r.last_message_at || undefined,
    unreadCount: r.unread_count ?? undefined,
  };
}

function toMessage(r: MessageRow): StoredMessage {
  return {
    seq: r.seq,
    chatId: r.chat_id,
    id: r.msg_id,
    senderId: r.sender_id ?? undefined,
    senderName: r.sender_name ?? undefined,
    outgoing: !!r.outgoing,
    date: r.date,
    text: r.text,
    media: r.media ?? undefined,
    replyTo: r.reply_to ?? undefined,
    chatTitle: r.chat_title ?? undefined,
  };
}

export class Store {
  readonly db: Database.Database;
  private listeners = new Set<(m: StoredMessage) => void>();

  constructor(file: string, private now: () => number = Date.now) {
    const fresh = file !== ":memory:" && !existsSync(file);
    this.db = new Database(file);
    if (fresh) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // chmod is not supported everywhere
      }
    }
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Called once for every message that is new to the local database. */
  onInsert(fn: (m: StoredMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  upsertChat(c: ChatInfo): void {
    this.db
      .prepare(
        `INSERT INTO chats (id, type, kind, title, username, access_hash, is_bot, last_message_at, unread_count, updated_at)
         VALUES (@id, @type, @kind, @title, @username, @access_hash, @is_bot, @last_message_at, @unread_count, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           kind = excluded.kind,
           title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE chats.title END,
           username = COALESCE(excluded.username, chats.username),
           access_hash = COALESCE(excluded.access_hash, chats.access_hash),
           is_bot = MAX(excluded.is_bot, chats.is_bot),
           last_message_at = MAX(COALESCE(excluded.last_message_at, 0), COALESCE(chats.last_message_at, 0)),
           unread_count = COALESCE(excluded.unread_count, chats.unread_count),
           updated_at = excluded.updated_at`,
      )
      .run({
        id: c.id,
        type: c.type,
        kind: c.kind,
        title: c.title || "",
        username: c.username ?? null,
        access_hash: c.accessHash ?? null,
        is_bot: c.isBot ? 1 : 0,
        last_message_at: c.lastMessageAt ?? null,
        unread_count: c.unreadCount ?? null,
        updated_at: this.now(),
      });
  }

  upsertUser(u: UserInfo): void {
    this.db
      .prepare(
        `INSERT INTO users (id, first_name, last_name, username, is_bot, access_hash, updated_at)
         VALUES (@id, @first_name, @last_name, @username, @is_bot, @access_hash, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           first_name = COALESCE(excluded.first_name, users.first_name),
           last_name = COALESCE(excluded.last_name, users.last_name),
           username = COALESCE(excluded.username, users.username),
           is_bot = excluded.is_bot,
           access_hash = COALESCE(excluded.access_hash, users.access_hash),
           updated_at = excluded.updated_at`,
      )
      .run({
        id: u.id,
        first_name: u.firstName ?? null,
        last_name: u.lastName ?? null,
        username: u.username ?? null,
        is_bot: u.isBot ? 1 : 0,
        access_hash: u.accessHash ?? null,
        updated_at: this.now(),
      });
  }

  /** Stores a message. Returns the stored row when it was new, undefined when it was already known. */
  insertMessage(m: MessageInfo): StoredMessage | undefined {
    const params = {
      chat_id: m.chatId,
      msg_id: m.id,
      sender_id: m.senderId ?? null,
      sender_name: m.senderName ?? null,
      outgoing: m.outgoing ? 1 : 0,
      date: m.date,
      text: m.text ?? "",
      media: m.media ?? null,
      reply_to: m.replyTo ?? null,
      inserted_at: this.now(),
    };
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (chat_id, msg_id, sender_id, sender_name, outgoing, date, text, media, reply_to, inserted_at)
         VALUES (@chat_id, @msg_id, @sender_id, @sender_name, @outgoing, @date, @text, @media, @reply_to, @inserted_at)`,
      )
      .run(params);
    this.db
      .prepare(`UPDATE chats SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE id = ?`)
      .run(m.date, m.chatId);
    if (res.changes === 0) {
      this.db
        .prepare(
          `UPDATE messages SET text = @text, media = COALESCE(@media, media)
           WHERE chat_id = @chat_id AND msg_id = @msg_id AND text <> @text`,
        )
        .run(params);
      return undefined;
    }
    const stored: StoredMessage = { ...m, seq: Number(res.lastInsertRowid) };
    for (const fn of this.listeners) {
      try {
        fn(stored);
      } catch {
        // a listener must never break ingest
      }
    }
    return stored;
  }

  setUnread(chatId: string, n: number): void {
    this.db.prepare(`UPDATE chats SET unread_count = ? WHERE id = ?`).run(n, chatId);
  }

  getUser(id: string): UserInfo | undefined {
    const r = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
      | { id: string; first_name: string | null; last_name: string | null; username: string | null; is_bot: number }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      firstName: r.first_name ?? undefined,
      lastName: r.last_name ?? undefined,
      username: r.username ?? undefined,
      isBot: !!r.is_bot,
    };
  }

  getMessage(chatId: string, msgId: number): StoredMessage | undefined {
    const r = this.db
      .prepare(
        `SELECT m.*, c.title AS chat_title FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
         WHERE m.chat_id = ? AND m.msg_id = ?`,
      )
      .get(chatId, msgId) as MessageRow | undefined;
    return r ? toMessage(r) : undefined;
  }

  getMessageBySeq(seq: number): StoredMessage | undefined {
    const r = this.db.prepare(`SELECT * FROM messages WHERE seq = ?`).get(seq) as MessageRow | undefined;
    return r ? toMessage(r) : undefined;
  }

  /**
   * Newest first by (date, seq). `before` is the (date, seq) of the last message of the previous page.
   */
  listMessages(opts: {
    limit: number;
    chatId?: string;
    direction?: "inbound" | "outbound";
    before?: { date: number; seq: number };
  }): StoredMessage[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.chatId) {
      where.push("m.chat_id = ?");
      args.push(opts.chatId);
    }
    if (opts.direction) {
      where.push("m.outgoing = ?");
      args.push(opts.direction === "outbound" ? 1 : 0);
    }
    if (opts.before) {
      where.push("(m.date < ? OR (m.date = ? AND m.seq < ?))");
      args.push(opts.before.date, opts.before.date, opts.before.seq);
    }
    const rows = this.db
      .prepare(
        `SELECT m.*, c.title AS chat_title FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY m.date DESC, m.seq DESC LIMIT ?`,
      )
      .all(...args, opts.limit) as MessageRow[];
    return rows.map(toMessage);
  }

  getChat(id: string): ChatInfo | undefined {
    const r = this.db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id) as ChatRow | undefined;
    return r ? toChat(r) : undefined;
  }

  findChatByUsername(username: string): ChatInfo | undefined {
    const r = this.db
      .prepare(`SELECT * FROM chats WHERE username = ? COLLATE NOCASE LIMIT 1`)
      .get(username.replace(/^@/, "")) as ChatRow | undefined;
    return r ? toChat(r) : undefined;
  }

  /** Exact title matches first; when there are none, substring matches. */
  findChatsByTitle(title: string, limit = 10): ChatInfo[] {
    const exact = this.db
      .prepare(`SELECT * FROM chats WHERE title = ? COLLATE NOCASE ORDER BY last_message_at DESC LIMIT ?`)
      .all(title, limit) as ChatRow[];
    if (exact.length) return exact.map(toChat);
    const like = this.db
      .prepare(
        `SELECT * FROM chats WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY last_message_at DESC LIMIT ?`,
      )
      .all(`%${title.replace(/[\\%_]/g, (c) => "\\" + c)}%`, limit) as ChatRow[];
    return like.map(toChat);
  }

  listChats(opts: { query?: string; type?: ChatType; limit: number }): ChatInfo[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.type) {
      where.push("type = ?");
      args.push(opts.type);
    }
    if (opts.query) {
      where.push(`(title LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\')`);
      const q = `%${opts.query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      args.push(q, q);
    }
    const sql = `SELECT * FROM chats ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY COALESCE(last_message_at, 0) DESC, updated_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, opts.limit) as ChatRow[]).map(toChat);
  }

  /** Newest first, optionally only messages with an id lower than `before`. */
  readMessages(chatId: string, limit: number, before?: number): StoredMessage[] {
    const rows = (
      before
        ? this.db
            .prepare(`SELECT * FROM messages WHERE chat_id = ? AND msg_id < ? ORDER BY msg_id DESC LIMIT ?`)
            .all(chatId, before, limit)
        : this.db.prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY msg_id DESC LIMIT ?`).all(chatId, limit)
    ) as MessageRow[];
    return rows.map(toMessage);
  }

  searchMessages(query: string, opts: { chatId?: string; limit: number }): StoredMessage[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT m.*, c.title AS chat_title FROM messages_fts f
         JOIN messages m ON m.seq = f.rowid
         LEFT JOIN chats c ON c.id = m.chat_id
         WHERE messages_fts MATCH ? ${opts.chatId ? "AND m.chat_id = ?" : ""}
         ORDER BY m.date DESC LIMIT ?`,
      )
      .all(...(opts.chatId ? [q, opts.chatId, opts.limit] : [q, opts.limit])) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Inbound messages inserted after `seq`, oldest first. */
  inboundAfter(seq: number, chatId?: string, limit = 50): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, c.title AS chat_title FROM messages m LEFT JOIN chats c ON c.id = m.chat_id
         WHERE m.seq > ? AND m.outgoing = 0 ${chatId ? "AND m.chat_id = ?" : ""}
         ORDER BY m.seq ASC LIMIT ?`,
      )
      .all(...(chatId ? [seq, chatId, limit] : [seq, limit])) as MessageRow[];
    return rows.map(toMessage);
  }

  maxSeq(): number {
    const r = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM messages`).get() as { s: number };
    return r.s;
  }

  hasAnyMessage(chatId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1`).get(chatId);
  }

  /** True when an earlier send to this chat succeeded (covers chats whose history we never stored). */
  hasSentTo(chatId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM send_ledger WHERE chat_id = ? AND ok = 1 LIMIT 1`).get(chatId);
  }

  recordSend(e: LedgerEntry): void {
    this.db
      .prepare(
        `INSERT INTO send_ledger (at, day, chat_id, kind, new_contact, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.at, e.day, e.chatId, e.kind, e.newContact ? 1 : 0, e.ok ? 1 : 0, e.error ?? null);
  }

  countSends(day: string): { messages: number; newContacts: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS messages, COALESCE(SUM(new_contact), 0) AS new_contacts
         FROM send_ledger WHERE day = ? AND ok = 1`,
      )
      .get(day) as { messages: number; new_contacts: number };
    return { messages: r.messages, newContacts: r.new_contacts };
  }

  getState(key: string): string | undefined {
    const r = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value;
  }

  setState(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare(`DELETE FROM state WHERE key = ?`).run(key);
    else
      this.db
        .prepare(`INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value);
  }

  counts(): { chats: number; messages: number } {
    const c = this.db.prepare(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number };
    const m = this.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
    return { chats: c.n, messages: m.n };
  }
}
