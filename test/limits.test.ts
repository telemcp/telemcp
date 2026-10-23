import { describe, expect, it } from "vitest";
import { classifyTelegramError, ToolError } from "../src/errors.js";
import { msUntilMidnight, typingMs } from "../src/limits.js";
import { alice, bob, makeService, msg, rpcError } from "./fakes.js";

async function connected(opts: Parameters<typeof makeService>[0] = {}) {
  const ctx = makeService(opts);
  await ctx.service.attach(ctx.port);
  return ctx;
}

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ToolError);
    return e as ToolError;
  }
  throw new Error("expected a refusal");
}

describe("daily caps", () => {
  it("refuses once daily_message_cap is reached, with retry_after_s to local midnight", async () => {
    const { service, store, port, clock } = await connected({ config: { daily_message_cap: 2 } });
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    await service.sendMessage({ to: { contact_id: alice.id }, text: "one" });
    await service.sendMessage({ to: { contact_id: alice.id }, text: "two" });
    const e = await refusal(service.sendMessage({ to: { contact_id: alice.id }, text: "three" }));
    expect(e.code).toBe("daily_send_cap");
    expect(e.toJSON().retry_after_s).toBe(Math.ceil(msUntilMidnight(clock.now()) / 1000));
    expect(port.sent).toHaveLength(2);
  });

  it("caps new contacts per day and spaces them out", async () => {
    const { service, store, port, clock } = await connected({ config: { daily_new_contact_cap: 1 } });
    store.upsertChat(alice);
    store.upsertChat(bob);
    await service.sendMessage({ to: { contact_id: alice.id }, text: "hello" });
    const e = await refusal(service.sendMessage({ to: { contact_id: bob.id }, text: "hello" }));
    expect(e.code).toBe("new_contact_cap");
    expect(port.sent).toHaveLength(1);
    // existing chats are not new contacts
    await service.sendMessage({ to: { contact_id: alice.id }, text: "follow up" });
    expect(port.sent).toHaveLength(2);
    clock.t += 1000;
    expect(service.usage().new_contacts).toBe(1);
  });

  it("enforces the jittered delay between new contacts", async () => {
    const { service, store, clock } = await connected();
    store.upsertChat(alice);
    store.upsertChat(bob);
    await service.sendMessage({ to: { contact_id: alice.id }, text: "hello" });
    const e = await refusal(service.sendMessage({ to: { contact_id: bob.id }, text: "hello" }));
    expect(e.code).toBe("rate_limited");
    // random() = 0.5 -> 45 + 0.5 * 75 = 82.5 s
    expect(e.retryAfterS).toBeGreaterThan(80);
    expect(e.retryAfterS).toBeLessThanOrEqual(83);
    clock.t += 83_000;
    await expect(service.sendMessage({ to: { contact_id: bob.id }, text: "hello" })).resolves.toMatchObject({ status: "sent" });
  });

  it("waits the short jittered gap between any two sends and shows typing first", async () => {
    const { service, store, port, clock } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    await service.sendMessage({ to: { contact_id: alice.id }, text: "a".repeat(50) });
    clock.slept = [];
    await service.sendMessage({ to: { contact_id: alice.id }, text: "b" });
    // 2 s gap (1 + 0.5 * 2) minus the typing time already spent, then typing for the second message
    expect(clock.slept.length).toBeGreaterThanOrEqual(1);
    expect(port.typing).toEqual([alice.id, alice.id]);
    expect(typingMs("x")).toBe(800);
    expect(typingMs("x".repeat(1000))).toBe(6000);
  });
});

describe("Telegram errors", () => {
  it("FLOOD_WAIT: no retry, returns the wait, pauses sends until it passes", async () => {
    const { service, store, port, clock } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    port.nextError = rpcError("FLOOD", { seconds: 120 });
    const e = await refusal(service.sendMessage({ to: { contact_id: alice.id }, text: "x" }));
    expect(e.code).toBe("rate_limited");
    expect(e.toJSON().retry_after_s).toBe(120);
    expect(port.calls.filter((c) => c === "sendText")).toHaveLength(1);
    const again = await refusal(service.sendMessage({ to: { contact_id: alice.id }, text: "x" }));
    expect(again.code).toBe("rate_limited");
    expect(port.calls.filter((c) => c === "sendText")).toHaveLength(1);
    clock.t += 121_000;
    await expect(service.sendMessage({ to: { contact_id: alice.id }, text: "x" })).resolves.toMatchObject({ status: "sent" });
  });

  it("PEER_FLOOD: stops new contacts for the day, existing chats still work", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(alice);
    store.upsertChat(bob);
    store.insertMessage(msg(alice, 1, "hi"));
    port.nextError = rpcError("PEER_FLOOD");
    const e = await refusal(service.sendMessage({ to: { contact_id: bob.id }, text: "hey" }));
    expect(e.code).toBe("rate_limited");
    expect(e.message).toContain("PEER_FLOOD");
    expect(e.retryAfterS).toBeGreaterThan(0);
    const again = await refusal(service.sendMessage({ to: { contact_id: bob.id }, text: "hey" }));
    expect(again.message).toContain("PEER_FLOOD");
    await expect(service.sendMessage({ to: { contact_id: alice.id }, text: "ok" })).resolves.toMatchObject({ status: "sent" });
    expect(service.account().status).toBe("restricted");
  });

  it("revoked session: stops, persists, tells the user to log in again", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    port.nextError = rpcError("AUTH_KEY_UNREGISTERED");
    const e = await refusal(service.sendMessage({ to: { contact_id: alice.id }, text: "x" }));
    expect(e.code).toBe("no_connected_account");
    expect(e.message).toContain("telemcp login");
    const again = await refusal(service.listMessages({}));
    expect(again.code).toBe("no_connected_account");
    expect(service.account().status).toBe("disconnected");
  });

  it("banned account maps to account_suspended", async () => {
    const { service, store, port } = await connected();
    store.upsertChat(alice);
    store.insertMessage(msg(alice, 1, "hi"));
    port.nextError = rpcError("USER_DEACTIVATED_BAN");
    const e = await refusal(service.sendMessage({ to: { contact_id: alice.id }, text: "x" }));
    expect(e.code).toBe("account_suspended");
    expect(service.account().status).toBe("restricted");
  });

  it("classifies raw error names", () => {
    expect(classifyTelegramError(rpcError("FLOOD_WAIT_42"))).toMatchObject({ kind: "flood_wait", seconds: 42 });
    expect(classifyTelegramError(rpcError("SLOWMODE_WAIT_10"))).toMatchObject({ kind: "flood_wait", seconds: 10 });
    expect(classifyTelegramError(rpcError("SESSION_REVOKED")).kind).toBe("auth_revoked");
    expect(classifyTelegramError(rpcError("USER_DEACTIVATED")).kind).toBe("banned");
    expect(classifyTelegramError(rpcError("WEBPAGE_CURL_FAILED")).kind).toBe("media");
    expect(classifyTelegramError(rpcError("SOMETHING_ELSE")).kind).toBe("other");
  });
});
