import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors.js";
import { alice, bob, channel, FakePort, group, makeService, msg } from "./fakes.js";

async function connected(opts: Parameters<typeof makeService>[0] = {}) {
  const ctx = makeService(opts);
  await ctx.service.attach(ctx.port);
  return ctx;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e.code;
    throw e;
  }
  return "ok";
}

describe("new contact detection", () => {
  it("a private chat with no message in either direction is new", async () => {
    const { service, store } = await connected();
    store.upsertChat(alice);
    expect(await service.isNewContact(alice)).toBe(true);
  });

  it("local history in either direction makes it existing", async () => {
    const { service, store } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "I wrote first", true));
    expect(await service.isNewContact(alice)).toBe(false);
  });

  it("checks Telegram history in user mode when the local DB has nothing", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(bob);
    port.history.set(bob.id, [msg(bob, 7, "old chat")]);
    expect(await service.isNewContact(bob)).toBe(false);
    expect(store.hasAnyMessage(bob.id)).toBe(true);
  });

  it("groups, channels and Saved Messages are never new contacts", async () => {
    const { service } = await connected();
    expect(await service.isNewContact(group)).toBe(false);
    expect(await service.isNewContact(channel)).toBe(false);
    expect(await service.isNewContact({ id: "1", type: "user", kind: "user", title: "me" })).toBe(false);
  });
});

describe("one recipient per send", () => {
  it("rejects zero, two or a list of recipients", async () => {
    const { service, port } = await connected();
    expect(await code(service.sendMessage({ to: {}, text: "x" }))).toBe("invalid_recipient");
    expect(await code(service.sendMessage({ to: { telegram_username: "alice", contact_id: "100" }, text: "x" }))).toBe("invalid_recipient");
    expect(await code(service.sendMessage({ to: [{ contact_id: "100" }] as never, text: "x" }))).toBe("invalid_recipient");
    expect(await code(service.sendMessage({ to: { telegram_username: "@alice, @bobby" }, text: "x" }))).toBe("invalid_recipient");
    expect(port.sent).toHaveLength(0);
  });

  it("resolves usernames, ids, phone contacts and chat ids", async () => {
    const { service, store, port } = await connected();
    port.usernames.set("alice", alice);
    port.contacts.set("31612345678", bob);
    store.upsertChat(group);
    expect((await service.resolveRecipient({ telegram_username: "@alice" })).id).toBe(alice.id);
    expect((await service.resolveRecipient({ telegram_username: "https://t.me/alice" })).id).toBe(alice.id);
    expect((await service.resolveRecipient({ telegram_user_id: 100 })).id).toBe(alice.id);
    expect((await service.resolveRecipient({ phone: "+31 6 1234 5678" })).id).toBe(bob.id);
    expect((await service.resolveRecipient({ contact_id: group.id })).id).toBe(group.id);
    expect(await code(service.resolveRecipient({ telegram_username: "@nobody_here" }))).toBe("contact_not_found");
    expect(await code(service.resolveRecipient({ telegram_user_id: "999" }))).toBe("contact_not_found");
  });
});

describe("send_message", () => {
  it("sends text with reply_to and records it", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 5, "question?"));
    const r = await service.sendMessage({ to: { contact_id: alice.id }, text: "answer", reply_to: `${alice.id}:5` });
    expect(r.status).toBe("sent");
    expect(r.message_id).toMatch(/^100:\d+$/);
    expect(port.sent[0]).toMatchObject({ text: "answer", replyTo: 5 });
    const got = await service.getMessage({ id: r.message_id });
    expect(got).toMatchObject({ direction: "outbound", channel: "telegram", chat_id: "100", reply_to: "100:5" });
    expect(service.usage().sends).toBe(1);
  });

  it("rejects reply_to from another chat, http media, missing files", async () => {
    const { service, store } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    expect(await code(service.sendMessage({ to: { contact_id: alice.id }, text: "x", reply_to: "200:1" }))).toBe("invalid_input");
    expect(await code(service.sendMessage({ to: { contact_id: alice.id }, media_url: "http://example.com/a.jpg" }))).toBe("media_unavailable");
    expect(await code(service.sendMessage({ to: { contact_id: alice.id }, media_path: "/no/such/file.png" }))).toBe("media_unavailable");
  });

  it("passes https media URLs to Telegram as is", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    await service.sendMessage({ to: { contact_id: alice.id }, media_url: "https://example.com/a.jpg", text: "look" });
    expect(port.sent[0]).toMatchObject({ file: "https://example.com/a.jpg", text: "look" });
    expect(port.typing).toHaveLength(0);
  });

  it("refuses everything with no_connected_account when nobody is logged in", async () => {
    const { service } = makeService();
    expect(await code(service.sendMessage({ to: { contact_id: "100" }, text: "x" }))).toBe("no_connected_account");
    expect(service.status()).toMatchObject({ status: "disconnected" });
    expect(service.status().detail).toContain("telemcp login");
  });
});

describe("wait_for_messages", () => {
  it("returns at once when messages already arrived after the cursor", async () => {
    const { service, store } = await connected();
    store.upsertChat(alice);
    const start = await service.waitForMessages({ timeout_s: 0 });
    store.insertMessage(msg(alice, 1, "hi"));
    const r = await service.waitForMessages({ cursor: start.cursor, timeout_s: 5 });
    expect(r.messages.map((m) => m.text)).toEqual(["hi"]);
    expect(Number(r.cursor)).toBeGreaterThan(Number(start.cursor));
  });

  it("wakes up when an inbound message arrives during the wait", async () => {
    const { service, port } = await connected();
    const t0 = Date.now();
    const waiting = service.waitForMessages({ timeout_s: 10 });
    setTimeout(() => port.emit({ message: msg(alice, 9, "ping"), chat: alice }), 50);
    const r = await waiting;
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ direction: "inbound", text: "ping", contact: { telegram_username: "alice" } });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("ignores outbound and other chats when filtered, then times out", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(alice);
    store.upsertChat(bob);
    const waiting = service.waitForMessages({ timeout_s: 1, chat_id: alice.id });
    setTimeout(() => {
      port.emit({ message: msg(bob, 1, "not for you"), chat: bob });
      port.emit({ message: msg(alice, 2, "mine", true), chat: alice });
    }, 20);
    const r = await waiting;
    expect(r.messages).toHaveLength(0);
  });
});

describe("bot mode", () => {
  it("answers reads from the local DB and refuses what bots cannot do", async () => {
    const port = new FakePort("bot", { id: "77", name: "Helper", username: "helper_bot", isBot: true });
    const { service, store } = await connected({ port });
    store.upsertChat(alice);
    port.emit({ message: msg(alice, 1, "hello bot"), chat: alice });
    const chats = await service.listChats({});
    expect(chats.chats.map((c) => c.chat_id)).toContain(alice.id);
    expect(port.calls).not.toContain("listDialogs");
    const found = await service.searchMessages({ query: "hello" });
    expect(found.messages).toHaveLength(1);
    expect(port.calls).not.toContain("searchGlobal");
    expect(await code(service.markRead({ chat_id: alice.id }))).toBe("not_available_for_bots");
    expect(await code(service.sendMessage({ to: { phone: "+31612345678" }, text: "x" }))).toBe("not_available_for_bots");
    expect(service.account().connect_kind).toBe("bot");
  });
});

describe("connect flow", () => {
  it("code then password", async () => {
    const ctx = makeService();
    ctx.connector.passwordNeeded = true;
    expect(await ctx.service.connectTelegram({ phone: "+31612345678" })).toMatchObject({ status: "code_required" });
    expect(ctx.service.account().status).toBe("connecting");
    expect(await code(ctx.service.submitCode({ code: "00000" }))).toBe("invalid_code");
    expect(await ctx.service.submitCode({ code: "12345" })).toMatchObject({ status: "password_required", hint: "pet" });
    expect(await code(ctx.service.submitPassword({ password: "nope" }))).toBe("invalid_code");
    expect(await ctx.service.submitPassword({ password: "secret" })).toMatchObject({ status: "connected" });
    expect(ctx.service.account()).toMatchObject({ status: "connected", identifier: "@me_user", id: "tg_1" });
    expect(await ctx.service.disconnectTelegram()).toEqual({ disconnected: true });
    expect(ctx.service.account().status).toBe("disconnected");
  });

  it("submit_telegram_code without connect_telegram says so", async () => {
    const { service } = makeService();
    expect(await code(service.submitCode({ code: "1" }))).toBe("code_required");
  });
});

describe("list and search in user mode", () => {
  it("lists chats by type and searches Telegram plus the local DB", async () => {
    const { service, store, port } = await connected();
    port.dialogs = [
      { ...alice, unreadCount: 2, lastMessageAt: 1_767_000_100 },
      { ...group, unreadCount: 0, lastMessageAt: 1_767_000_050 },
      { ...channel, unreadCount: 5, lastMessageAt: 1_767_000_010 },
    ];
    const groups = await service.listChats({ type: "group" });
    expect(groups.chats.map((c) => c.chat_id)).toEqual([group.id]);
    const all = await service.listChats({});
    expect(all.chats[0]).toMatchObject({ chat_id: alice.id, unread_count: 2, type: "user" });
    port.history.set(alice.id, [msg(alice, 1, "the invoice is attached")]);
    store.insertMessage(msg(group, 3, "invoice question in the group"));
    const r = await service.searchMessages({ query: "invoice" });
    expect(r.messages.map((m) => m.id).sort()).toEqual(["-300:3", "100:1"]);
    await service.markRead({ chat_id: alice.id });
    expect(port.read).toEqual([alice.id]);
  });
});
