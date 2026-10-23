import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  session: string;
  db: string;
  config: string;
}

export function resolvePaths(home = process.env.TELEMCP_HOME): Paths {
  const dir = home && home.trim() ? home : join(homedir(), ".telemcp");
  return {
    home: dir,
    session: join(dir, "session"),
    db: join(dir, "telemcp.db"),
    config: join(dir, "config.json"),
  };
}

export function ensureHome(p: Paths): void {
  if (!existsSync(p.home)) mkdirSync(p.home, { recursive: true, mode: 0o700 });
}

/** Write a file readable only by the current user (mode 600). */
export function writePrivate(file: string, data: string): void {
  writeFileSync(file, data, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Some filesystems (Windows, some mounts) do not support chmod.
  }
}

export function readSession(p: Paths): string | undefined {
  if (!existsSync(p.session)) return undefined;
  const s = readFileSync(p.session, "utf8").trim();
  return s || undefined;
}

export function saveSession(p: Paths, session: string): void {
  ensureHome(p);
  writePrivate(p.session, session);
}

export function deleteSession(p: Paths): boolean {
  if (!existsSync(p.session)) return false;
  rmSync(p.session, { force: true });
  return true;
}
