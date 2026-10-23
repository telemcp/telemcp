import { describe, expect, it } from "vitest";
import { dayKey, ftsQuery, Store } from "../src/db.js";
import { alice, group, msg } from "./fakes.js";

describe("Store ingest and FTS", () => {
  it("stores a message once and indexes it for search", () => {
    const s = new Store(":memory:");
    s.upsertChat(alice);
    expect(s.insertMessage(msg(alice, 1, "Dinner at the harbour on Friday?"))).toBeDefined();
    expect(s.insertMessage(msg(alice, 1, "Dinner at the harbour on Friday?"))).toBeUndefined();
    expect(s.counts().messages).toBe(1);
    const hits = s.searchMessages("harbour friday", { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].chatTitle).toBe("Alice");
  });

  it("keeps the index in step with edits", () => {
    const s = new Store(":memory:");
    s.insertMessage(msg(alice, 1, "old words"));
    s.insertMessage({ ...msg(alice, 1, "fresh text") });
    expect(s.searchMessages("old", { limit: 5 })).toHaveLength(0);
    expect(s.searchMessages("fresh", { limit: 5 })).toHaveLength(1);
  });

  it("treats FTS syntax in queries as plain words", () => {
    const s = new Store(":memory:");
    s.insertMessage(msg(alice, 1, 'he said "NEAR" OR AND (x)'));
    expect(() => s.searchMessages('"NEAR" OR AND (x) *', { limit: 5 })).not.toThrow();
    expect(ftsQuery('a "b')).toBe('"a" "b"');
    expect(ftsQuery("   ")).toBeUndefined();
  });

  it("filters search by chat and returns inbound after a cursor in insertion order", () => {
    const s = new Store(":memory:");
    s.insertMessage(msg(alice, 1, "hello there"));
    const mark = s.maxSeq();
    s.insertMessage(msg(group, 2, "hello group"));
    s.insertMessage(msg(alice, 3, "my reply", true));
    s.insertMessage(msg(alice, 4, "hello again"));
    expect(s.searchMessages("hello", { chatId: group.id, limit: 10 })).toHaveLength(1);
    const after = s.inboundAfter(mark);
    expect(after.map((m) => m.id)).toEqual([2, 4]);
    expect(s.inboundAfter(mark, alice.id).map((m) => m.id)).toEqual([4]);
  });

  it("pages list_messages newest first by date", () => {
    const s = new Store(":memory:");
    for (let i = 1; i <= 5; i++) s.insertMessage(msg(alice, i, `m${i}`));
    const p1 = s.listMessages({ limit: 2 });
    expect(p1.map((m) => m.id)).toEqual([5, 4]);
    const p2 = s.listMessages({ limit: 2, before: { date: p1[1].date, seq: p1[1].seq } });
    expect(p2.map((m) => m.id)).toEqual([3, 2]);
  });

  it("counts ledger sends per day", () => {
    const s = new Store(":memory:");
    const now = new Date(2026, 4, 1, 12).getTime();
    s.recordSend({ at: now, day: dayKey(now), chatId: "1", kind: "text", newContact: true, ok: true });
    s.recordSend({ at: now, day: dayKey(now), chatId: "2", kind: "text", newContact: false, ok: true });
    s.recordSend({ at: now, day: dayKey(now), chatId: "3", kind: "text", newContact: true, ok: false });
    expect(s.countSends("2026-05-01")).toEqual({ messages: 2, newContacts: 1 });
    expect(s.hasSentTo("1")).toBe(true);
    expect(s.hasSentTo("3")).toBe(false);
  });
});
