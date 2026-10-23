import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { channelErrorCodes, channelTools, loadContract } from "../src/contract.js";
import { createMcpServer, HANDLERS } from "../src/tools.js";
import { alice, makeService, msg } from "./fakes.js";

async function connect(service: ReturnType<typeof makeService>["service"]) {
  const server = createMcpServer(service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

function text(r: { content: unknown }): any {
  const c = (r.content as { type: string; text: string }[])[0];
  return JSON.parse(c.text);
}

describe("door contract", () => {
  const contract = loadContract();
  const expected = channelTools(contract, "telegram");

  it("is the shared door-contract 1.0 file with a telegram channel", () => {
    expect(contract.contract).toBe("door-contract");
    expect(contract.version).toBe("1.0");
    expect(contract.shared_tools.map((t) => t.name)).toEqual([
      "list_accounts",
      "send_message",
      "get_message",
      "list_messages",
      "wait_for_messages",
      "get_usage",
      "list_chats",
      "search_messages",
      "mark_read",
    ]);
    expect(contract.channels.telegram.server).toBe("telemcp");
    expect(contract.channels.telegram.tools.map((t) => t.name)).toEqual([
      "connect_telegram",
      "submit_telegram_code",
      "submit_telegram_password",
      "get_telegram_status",
      "disconnect_telegram",
      "list_groups",
      "list_channels",
    ]);
  });

  it("every error code the server can return is in the contract", () => {
    const allowed = channelErrorCodes(contract, "telegram");
    const src = ["errors.ts", "service.ts", "limits.ts", "contract.ts", "tools.ts"]
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"))
      .join("\n");
    const union = /export type ErrorCode =([^;]+);/.exec(src)![1];
    const declared = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const used = [...src.matchAll(/ToolError\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const code of new Set([...declared, ...used])) expect(allowed, code).toContain(code);
    expect(contract.error_codes).not.toHaveProperty("telegram_error");
    expect(contract.channels.telegram.error_codes).toHaveProperty("telegram_error");
  });

  it("unknown top-level fields are refused with invalid_input", async () => {
    const { service } = makeService();
    const client = await connect(service);
    const r = (await client.callTool({ name: "list_chats", arguments: { limt: 5 } })) as any;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({ error_code: "invalid_input" });
    const int = (await client.callTool({ name: "send_message", arguments: { to: { telegram_user_id: 100 }, text: "hi" } })) as any;
    expect(text(int).error_code).toBe("invalid_recipient");
    const str = (await client.callTool({ name: "send_message", arguments: { to: { telegram_user_id: "100" }, text: "hi" } })) as any;
    expect(text(str).error_code).toBe("no_connected_account");
    const noText = (await client.callTool({ name: "send_message", arguments: { to: { contact_id: "100" } } })) as any;
    expect(text(noText).error_code).toBe("invalid_input");
  });

  it("registered tools match the contract exactly (names, fields, required)", async () => {
    const { service } = makeService();
    const client = await connect(service);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
    expect(Object.keys(HANDLERS).sort()).toEqual(expected.map((t) => t.name).sort());
    for (const t of tools) {
      const c = expected.find((x) => x.name === t.name)!;
      expect(t.description).toBe(c.description);
      expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(c.inputSchema.properties ?? {}).sort());
      expect([...((t.inputSchema.required as string[]) ?? [])].sort()).toEqual([...(c.inputSchema.required ?? [])].sort());
    }
    const send = tools.find((t) => t.name === "send_message")!;
    const to = (send.inputSchema.properties as any).to;
    expect(Object.keys(to.properties).sort()).toEqual(["contact_id", "phone", "telegram_user_id", "telegram_username"]);
    expect(to.maxProperties).toBe(1);
    expect(JSON.stringify(tools)).not.toContain("local_only");
    expect(JSON.stringify(tools)).not.toContain("hosted_only");
    expect(send.inputSchema.required).toContain("text");
    expect(Object.keys((send.inputSchema.properties as any) ?? {})).toContain("media_path");
  });

  it("states door-contract 1.0 in the server instructions and get_usage", async () => {
    const { service } = makeService();
    const client = await connect(service);
    expect(client.getInstructions()).toContain("door-contract 1.0");
    const r = await client.callTool({ name: "get_usage", arguments: {} });
    expect(text(r as any)).toMatchObject({
      plan: "self-hosted",
      contract_version: "1.0",
      sends: 0,
      sends_cap: 200,
      new_contacts_cap: 20,
      status: "active",
      accounts_total: 1,
      accounts_connected: 0,
      accounts_cap: 1,
    });
  });

  it("old names are gone", () => {
    const names = expected.map((t) => t.name);
    for (const old of ["status", "read_messages", "send_media"]) expect(names).not.toContain(old);
  });
});

describe("tool calls over MCP", () => {
  it("not logged in: get_telegram_status explains how to log in, sends refuse with a contract error", async () => {
    const { service } = makeService();
    const client = await connect(service);
    const st = text((await client.callTool({ name: "get_telegram_status", arguments: { phoneNumber: "+31612345678" } })) as any);
    expect(st).toMatchObject({ success: true, phone_number: "+31612345678", status: "not_initialized", live: false });
    expect(st.detail).toContain("telemcp login");
    const r = (await client.callTool({ name: "send_message", arguments: { to: { contact_id: "100" }, text: "hi" } })) as any;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatchObject({ error_code: "no_connected_account" });
    const accounts = text((await client.callTool({ name: "list_accounts", arguments: {} })) as any);
    expect(accounts.accounts).toHaveLength(1);
    expect(accounts.channels).toEqual([{ channel: "telegram", label: "Telegram", connect_kind: "code", max_accounts: 1 }]);
  });

  it("connection tools refuse with {success: false, error_code: <HTTP status>, error}", async () => {
    const { service } = makeService();
    const client = await connect(service);
    const qr = (await client.callTool({ name: "connect_telegram", arguments: { phone_number: "+31612345678", mode: "qr" } })) as any;
    expect(qr.isError).toBe(true);
    expect(text(qr)).toMatchObject({ success: false, error_code: 400 });
    expect(text(qr).error).toContain("QR login is not supported");
    const missing = (await client.callTool({ name: "get_telegram_status", arguments: {} })) as any;
    expect(text(missing)).toMatchObject({ success: false, error_code: 400 });
    const ok = text((await client.callTool({ name: "connect_telegram", arguments: { phone_number: "+31612345678" } })) as any);
    expect(ok).toMatchObject({ success: true, phone_number: "+31612345678", status: "code_required" });
    const other = (await client.callTool({ name: "get_telegram_status", arguments: { phoneNumber: "+31699999999" } })) as any;
    expect(text(other)).toEqual({ success: false, error_code: 404, error: "No connection for that number." });
    const early = (await client.callTool({ name: "submit_telegram_password", arguments: { phoneNumber: "+31612345678", password: "x" } })) as any;
    expect(text(early)).toMatchObject({ success: false, error_code: 409 });
    const bad = (await client.callTool({ name: "submit_telegram_code", arguments: { phoneNumber: "+31612345678", code: "00000" } })) as any;
    expect(text(bad)).toMatchObject({ success: false, error_code: 400 });
  });

  it("malformed input is a contract error, not a protocol error", async () => {
    const { service } = makeService();
    await service.attach((service as any).connector.port);
    const client = await connect(service);
    const two = (await client.callTool({
      name: "send_message",
      arguments: { to: { contact_id: "100", telegram_username: "x" }, text: "hi" },
    })) as any;
    expect(two.isError).toBe(true);
    expect(text(two).error_code).toBe("invalid_recipient");
    const long = (await client.callTool({ name: "send_message", arguments: { to: { contact_id: "100" }, text: "x".repeat(4097) } })) as any;
    expect(text(long).error_code).toBe("invalid_input");
    const wait = (await client.callTool({ name: "wait_for_messages", arguments: { timeout_s: 99 } })) as any;
    expect(text(wait).error_code).toBe("invalid_input");
  });

  it("list_messages returns WireMessages newest first with a cursor", async () => {
    const { service, store, port } = makeService();
    await service.attach(port);
    store.upsertChat(alice);
    for (let i = 1; i <= 3; i++) store.insertMessage(msg(alice, i, `m${i}`));
    const client = await connect(service);
    const r = text((await client.callTool({ name: "list_messages", arguments: { limit: 2 } })) as any);
    expect(r.messages.map((m: any) => m.text)).toEqual(["m3", "m2"]);
    expect(r.messages[0]).toMatchObject({ id: "100:3", account_id: "tg_1", channel: "telegram", direction: "inbound", chat_id: "100", status: "received" });
    expect(r.messages[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.next_cursor).toBeTruthy();
    const r2 = text((await client.callTool({ name: "list_messages", arguments: { limit: 2, before: r.next_cursor } })) as any);
    expect(r2.messages.map((m: any) => m.text)).toEqual(["m1"]);
    expect(r2.next_cursor).toBeNull();
  });
});
