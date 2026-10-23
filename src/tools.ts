// MCP server wiring: tool list straight from the door contract, calls routed to TeleService.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { advertisedSchema, channelTools, type ContractTool, loadContract, validate } from "./contract.js";
import { lifecycleStatus, ToolError } from "./errors.js";
import { log } from "./log.js";
import type { TeleService } from "./service.js";
import { VERSION } from "./version.js";

type Args = Record<string, any>;
type Handler = (s: TeleService, a: Args, signal: AbortSignal) => Promise<unknown> | unknown;

export const HANDLERS: Record<string, Handler> = {
  list_accounts: (s) => s.listAccounts(),
  send_message: (s, a) => s.sendMessage(a as Parameters<TeleService["sendMessage"]>[0]),
  get_message: (s, a) => s.getMessage(a as { id: string }),
  list_messages: (s, a) => s.listMessages(a),
  wait_for_messages: (s, a, signal) => s.waitForMessages(a, signal),
  get_usage: (s) => s.usage(),
  list_chats: (s, a) => s.listChats(a),
  search_messages: (s, a) => s.searchMessages(a as { query: string }),
  mark_read: (s, a) => s.markRead(a as { chat_id: string }),
  connect_telegram: (s, a) => s.connectTelegram(a as Parameters<TeleService["connectTelegram"]>[0]),
  submit_telegram_code: (s, a) => s.submitCode(a as { phoneNumber: string; code: string }),
  submit_telegram_password: (s, a) => s.submitPassword(a as { phoneNumber: string; password: string }),
  get_telegram_status: (s, a) => s.status(a as { phoneNumber: string }),
  disconnect_telegram: (s, a) => s.disconnectTelegram(a as { phoneNumber: string }),
  list_groups: (s, a) => s.listChats({ ...a, type: "group" }),
  list_channels: (s, a) => s.listChats({ ...a, type: "channel" }),
};

const LOGIN_TOOLS = new Set(["connect_telegram", "submit_telegram_code", "submit_telegram_password", "disconnect_telegram"]);
/** Tools that keep the connection API shape: {success: true, phone_number, ...} or {success: false, error_code: <HTTP status>, error}. */
export const LIFECYCLE_TOOLS = new Set([...LOGIN_TOOLS, "get_telegram_status"]);

export const INSTRUCTIONS = [
  "telemcp: a self-hosted Telegram MCP server (door-contract 1.0, channel telegram).",
  "It reads, searches and sends messages for one Telegram account (a user account or a bot) on this machine.",
  "send_message takes exactly one recipient per call; there is no bulk send. Daily caps and pacing apply, and a refusal sends nothing.",
  "A refusal is JSON {error_code, error, retry_after_s?}; on the connection tools (connect_telegram, submit_telegram_code, submit_telegram_password, get_telegram_status, disconnect_telegram) it is {success: false, error_code: <HTTP status>, error}. When retry_after_s is present, wait at least that long; do not retry sooner.",
  "Use list_chats to find chat ids, wait_for_messages with the returned cursor to follow new messages, get_usage for today's limits.",
  "If no account is connected, ask the user to run `telemcp login` in a terminal, or use connect_telegram, submit_telegram_code and submit_telegram_password.",
].join(" ");

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(e: ToolError): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(e.toJSON()) }] };
}

export function lifecycleErrorResult(e: ToolError): CallToolResult {
  const out: { success: false; error_code: number; error: string; retry_after_s?: number } = {
    success: false,
    error_code: lifecycleStatus(e.code),
    error: e.message,
  };
  const retry = e.toJSON().retry_after_s;
  if (retry !== undefined) out.retry_after_s = retry;
  return { isError: true, content: [{ type: "text", text: JSON.stringify(out) }] };
}

export function contractTools(): ContractTool[] {
  return channelTools(loadContract(), "telegram");
}

export function createMcpServer(service: TeleService): Server {
  const tools = contractTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const t of tools) if (!HANDLERS[t.name]) throw new Error(`no handler for contract tool ${t.name}`);

  const server = new Server({ name: "telemcp", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: advertisedSchema(t.inputSchema) as any })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const name = req.params.name;
    const tool = byName.get(name);
    if (!tool) return errorResult(new ToolError("invalid_input", `Unknown tool ${name}.`));
    const args = (req.params.arguments ?? {}) as Args;
    const refuse = LIFECYCLE_TOOLS.has(name) ? lifecycleErrorResult : errorResult;
    try {
      validate(tool.inputSchema, args);
      if (!LOGIN_TOOLS.has(name)) await service.connectIfSessionAppeared();
      return ok(await HANDLERS[name](service, args, extra.signal));
    } catch (err) {
      if (err instanceof ToolError) return refuse(err);
      log.error(`tool ${name} failed`, err);
      return refuse(service.guard.handleError(err, { bot: service.mode === "bot" }));
    }
  });

  return server;
}
