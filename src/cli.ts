#!/usr/bin/env node
// telemcp command line: login, serve (default), status, logout, limits.

import { existsSync } from "node:fs";
import { apiCredentials, type Config, ensureConfigFile, loadConfig, saveConfig } from "./config.js";
import { Store } from "./db.js";
import { classifyTelegramError, telegramErrorName } from "./errors.js";
import { SendGuard } from "./limits.js";
import { guardStdout, log } from "./log.js";
import { deleteSession, ensureHome, readSession, resolvePaths, saveSession } from "./paths.js";
import type { ApiCreds, TelegramPort } from "./port.js";
import { ask } from "./prompt.js";
import { serveHttp, serveStdio } from "./server.js";
import { TeleService } from "./service.js";
import { VERSION } from "./version.js";

const HELP = `telemcp ${VERSION}: a self-hosted Telegram MCP server

Usage:
  telemcp login [--bot-token TOKEN] [--api-id ID --api-hash HASH] [--phone +31...]
                          Log in with your own Telegram account (or a bot) and save the session.
  telemcp [serve]         Start the MCP server on stdio (what Claude Desktop, Claude Code and Cursor run).
  telemcp serve --http [--port 8788] [--token SECRET]
                          Start the MCP server on http://127.0.0.1:PORT/mcp instead of stdio.
  telemcp status          Show the login state and today's usage.
  telemcp limits          Show the safety limits, where to change them, and today's usage.
  telemcp logout          End the Telegram session and delete it from this machine.
  telemcp --help | --version

Environment:
  TELEGRAM_API_ID, TELEGRAM_API_HASH   your own api credentials from https://my.telegram.org
  TELEMCP_BOT_TOKEN                    run as a bot (token from @BotFather)
  TELEMCP_HOME                         data directory (default ~/.telemcp)
  TELEMCP_HTTP_TOKEN                   bearer token for --http (same as --token)
  TELEMCP_LOG_LEVEL                    debug | info | warn | error (default info), always on stderr
`;

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

export function parseArgs(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") out.help = true;
    else if (a === "-v") out.version = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const key = a.slice(2);
        const next = argv[i + 1];
        const boolean = ["http", "help", "version"].includes(key);
        if (!boolean && next !== undefined && !next.startsWith("--")) {
          out[key] = next;
          i++;
        } else out[key] = true;
      }
    } else out._.push(a);
  }
  return out;
}

function flag(f: Flags, name: string): string | undefined {
  const v = f[name];
  return typeof v === "string" && v ? v : undefined;
}

async function loadConnector() {
  const { gramConnector } = await import("./telegram/gram.js");
  return gramConnector;
}

function say(msg = ""): void {
  process.stderr.write(msg + "\n");
}

async function credsFor(f: Flags, cfg: Config): Promise<ApiCreds> {
  const env = { ...process.env };
  if (flag(f, "api-id")) env.TELEGRAM_API_ID = flag(f, "api-id");
  if (flag(f, "api-hash")) env.TELEGRAM_API_HASH = flag(f, "api-hash");
  const have = apiCredentials(cfg, env);
  if (have) return have;
  say("telemcp uses your own Telegram API credentials. To get them:");
  say("  1. Open https://my.telegram.org and log in with your phone number.");
  say("  2. Click API development tools.");
  say("  3. Create an application (any name and short name will do).");
  say("  4. Copy the api_id and api_hash shown on the page.");
  say();
  const id = Number(await ask("api_id: "));
  if (!Number.isInteger(id) || id <= 0) throw new Error("api_id must be a number");
  const hash = await ask("api_hash: ", { hidden: true });
  if (!/^[0-9a-f]{32}$/i.test(hash)) throw new Error("api_hash should be 32 hexadecimal characters");
  return { apiId: id, apiHash: hash };
}

async function cmdLogin(f: Flags): Promise<void> {
  const paths = resolvePaths();
  ensureHome(paths);
  const cfg = ensureConfigFile(paths);
  const creds = await credsFor(f, cfg);
  const connector = await loadConnector();
  const botToken = flag(f, "bot-token") ?? process.env.TELEMCP_BOT_TOKEN;
  let port: TelegramPort;
  if (botToken) {
    say("Logging in as a bot...");
    port = await connector.loginBot(botToken, creds);
  } else {
    const phone = (flag(f, "phone") ?? (await ask("Phone number (international format, e.g. +31612345678): "))).replace(/[\s()-]/g, "");
    const pending = await connector.startUserLogin(phone, creds);
    say(pending.codeViaApp ? "Telegram sent a login code to your Telegram app." : "Telegram sent a login code by SMS.");
    let result: Awaited<ReturnType<typeof pending.submitCode>> | undefined;
    for (let attempt = 1; !result; attempt++) {
      const code = (await ask("Login code: ")).replace(/\D/g, "");
      try {
        result = await pending.submitCode(code);
      } catch (err) {
        if (classifyTelegramError(err).kind === "invalid_code" && attempt < 3) {
          say(`That code did not work (${telegramErrorName(err)}). Try again.`);
          continue;
        }
        await pending.cancel();
        throw err;
      }
    }
    if (result.status === "password_required") {
      say("This account has two step verification." + (result.hint ? ` Hint: ${result.hint}` : ""));
      for (let attempt = 1; ; attempt++) {
        const pw = await ask("Password: ", { hidden: true });
        try {
          port = await pending.submitPassword(pw);
          break;
        } catch (err) {
          if (classifyTelegramError(err).kind === "invalid_code" && attempt < 3) {
            say("Wrong password. Try again.");
            continue;
          }
          await pending.cancel();
          throw err;
        }
      }
    } else port = result.port;
  }

  const me = await port.me();
  saveSession(paths, port.exportSession());
  saveConfig(paths, { ...loadConfig(paths), mode: port.mode, api_id: creds.apiId, api_hash: creds.apiHash });
  const store = new Store(paths.db);
  new SendGuard(store, () => loadConfig(paths).limits).clearAuthProblem();
  store.setState("account_id", me.id);
  store.setState("identifier", me.username ? "@" + me.username : (me.phone ?? me.name));
  store.setState("connect_kind", port.mode);
  store.setState("connected_at", new Date().toISOString());
  store.close();
  await port.disconnect();
  say();
  say(`Logged in as ${me.name}${me.username ? " (@" + me.username + ")" : ""}, ${port.mode} mode.`);
  say(`Session saved to ${paths.session} (readable only by you).`);
  say();
  say("Next: add telemcp to your AI assistant, for example in Claude Code:");
  say("  claude mcp add telemcp -- npx -y telemcp");
}

async function cmdServe(f: Flags): Promise<void> {
  const http = f.http === true;
  if (!http) guardStdout();
  const paths = resolvePaths();
  ensureHome(paths);
  const store = new Store(paths.db);
  const service = new TeleService({ paths, store, connector: await loadConnector() });
  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await service.stop().catch(() => undefined);
    store.close();
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));
  // Connect in the background so the MCP handshake is never blocked by the network.
  void service.start();
  if (http) {
    const port = Number(flag(f, "port") ?? process.env.TELEMCP_HTTP_PORT ?? 8788);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be a port number");
    const token = flag(f, "token") ?? process.env.TELEMCP_HTTP_TOKEN;
    await serveHttp(service, { port, token, host: process.env.TELEMCP_HTTP_HOST || "127.0.0.1" });
  } else {
    await serveStdio(service);
  }
  await stop(0);
}

async function cmdStatus(): Promise<void> {
  const paths = resolvePaths();
  const cfg = loadConfig(paths);
  const session = readSession(paths);
  const creds = apiCredentials(cfg);
  say(`telemcp ${VERSION}`);
  say(`data directory: ${paths.home}`);
  say(`api credentials: ${creds ? "configured" : "missing (run telemcp login)"}`);
  say(`session: ${session ? "saved" : "none (run telemcp login)"}`);
  if (existsSync(paths.db)) {
    const store = new Store(paths.db);
    const guard = new SendGuard(store, () => cfg.limits);
    const u = guard.usage();
    const c = store.counts();
    say(`mode: ${store.getState("connect_kind") ?? cfg.mode ?? "user"}`);
    say(`account: ${store.getState("identifier") ?? "unknown"}`);
    say(`local database: ${c.chats} chats, ${c.messages} messages`);
    say(`today (${u.day}): ${u.sends}/${u.sendsCap} messages, ${u.newContacts}/${u.newContactsCap} new contacts`);
    if (u.floodUntil) say(`paused by Telegram (${u.floodReason}) until ${new Date(u.floodUntil).toISOString()}`);
    if (u.peerFloodToday) say("PEER_FLOOD today: new contact sends stopped until midnight");
    if (u.authProblem) say(`session problem: ${u.authProblem.reason}. Run telemcp login.`);
    store.close();
  }
  if (session && creds) {
    try {
      const port = await withTimeout((await loadConnector()).fromSession(session, creds), 30000);
      const me = await port.me();
      say(`telegram: connected as ${me.name}${me.username ? " (@" + me.username + ")" : ""}`);
      await port.disconnect();
    } catch (err) {
      say(`telegram: could not connect (${telegramErrorName(err)})`);
      process.exitCode = 1;
    }
  }
}

async function cmdLimits(): Promise<void> {
  const paths = resolvePaths();
  ensureHome(paths);
  const cfg = ensureConfigFile(paths);
  const l = cfg.limits;
  say(`Limits (edit ${paths.config}; the running server picks up changes):`);
  say(`  daily_message_cap          ${l.daily_message_cap} messages per day`);
  say(`  daily_new_contact_cap      ${l.daily_new_contact_cap} new private chats per day`);
  say(`  new_contact_delay_seconds  ${l.new_contact_delay_seconds.min} to ${l.new_contact_delay_seconds.max} seconds between new contacts`);
  say(`  send_delay_seconds         ${l.send_delay_seconds.min} to ${l.send_delay_seconds.max} seconds between any two sends`);
  say(`  typing_indicator           ${l.typing_indicator}`);
  const store = new Store(paths.db);
  const u = new SendGuard(store, () => l).usage();
  say(`Today (${u.day}): ${u.sends}/${u.sendsCap} messages, ${u.newContacts}/${u.newContactsCap} new contacts.`);
  store.close();
}

async function cmdLogout(): Promise<void> {
  const paths = resolvePaths();
  const session = readSession(paths);
  if (!session) {
    say("No saved session. Nothing to do.");
    return;
  }
  const creds = apiCredentials(loadConfig(paths));
  if (creds) {
    try {
      const port = await withTimeout((await loadConnector()).fromSession(session, creds), 30000);
      await port.logOut();
      await port.disconnect();
      say("Telegram session ended.");
    } catch (err) {
      say(`Could not end the session on Telegram (${telegramErrorName(err)}); removing it locally anyway.`);
    }
  }
  deleteSession(paths);
  if (existsSync(paths.db)) {
    const store = new Store(paths.db);
    store.setState("connected_at", undefined);
    store.close();
  }
  say(`Deleted ${paths.session}. Your local message database stays at ${paths.db}; delete it by hand if you want.`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const f = parseArgs(argv);
  if (f.help) return void process.stdout.write(HELP);
  if (f.version) return void process.stdout.write(VERSION + "\n");
  const cmd = f._[0] ?? "serve";
  switch (cmd) {
    case "serve":
      return cmdServe(f);
    case "login":
      return cmdLogin(f);
    case "status":
      return cmdStatus();
    case "limits":
      return cmdLimits();
    case "logout":
      return cmdLogout();
    case "help":
      return void process.stdout.write(HELP);
    default:
      process.stderr.write(`Unknown command ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().then(
  () => {
    const cmd = parseArgs(process.argv.slice(2))._[0] ?? "serve";
    if (cmd !== "serve") process.exit(process.exitCode ?? 0);
  },
  (err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
