// Starts the MCP server on stdio (default) or on local Streamable HTTP.

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./log.js";
import type { TeleService } from "./service.js";
import { createMcpServer } from "./tools.js";

export async function serveStdio(service: TeleService): Promise<void> {
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server ready on stdio");
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
}

function tokenOk(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Streamable HTTP on 127.0.0.1 only, path /mcp, optional bearer token. */
export async function serveHttp(service: TeleService, opts: { port: number; host?: string; token?: string }): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const allowedHosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`];

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (url.pathname !== "/mcp") return send(res, 404, { error: "not found; the MCP endpoint is /mcp" });
      if (!tokenOk(req, opts.token)) return send(res, 401, { error: "missing or wrong bearer token" });
      const sid = req.headers["mcp-session-id"] as string | undefined;
      const body = req.method === "POST" ? await readJson(req) : undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          return send(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "No valid session; send initialize first" }, id: null });
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection: true,
          allowedHosts,
          onsessioninitialized: (id) => {
            sessions.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        await createMcpServer(service).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error("http request failed", err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, host, () => resolve());
  });
  log.info(`MCP server ready on http://${host}:${opts.port}/mcp${opts.token ? " (bearer token required)" : ""}`);
  await new Promise<void>((resolve) => http.once("close", () => resolve()));
}
