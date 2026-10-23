// All logging goes to stderr. stdout belongs to the MCP stdio transport.

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.TELEMCP_LOG_LEVEL || "info").toLowerCase() as Level;
  return order[env] ?? order.info;
}

function write(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold()) return;
  const line = `[telemcp] ${level}: ${msg}`;
  if (extra === undefined) process.stderr.write(line + "\n");
  else process.stderr.write(line + " " + safe(extra) + "\n");
}

function safe(v: unknown): string {
  if (v instanceof Error) return v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, e?: unknown) => write("debug", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  error: (m: string, e?: unknown) => write("error", m, e),
};

/** Route console.log / console.info to stderr so no library can corrupt the stdio protocol. */
export function guardStdout(): void {
  const toErr = (...args: unknown[]) => {
    process.stderr.write(args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ") + "\n");
  };
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}
