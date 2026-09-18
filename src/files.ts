import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { BridgeError, hash } from "./common.ts";

export function resolveInput(path: string, cwd: string): string {
  if (path.includes("\0")) throw new BridgeError("INVALID_PATH", "Paths cannot contain NUL");
  if (path === "~") return homedir();
  return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
}
export async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { if ((await lstat(path)).isSymbolicLink()) throw new BridgeError("INVALID_PATH", "Cannot write through a dangling symbolic link"); }
    catch (inner) { if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner; }
    if (dirname(path) === path) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}
export async function revision(path: string): Promise<string> {
  try { return `sha256:${hash(await readFile(path))}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export async function requireRevision(path: string, expected: string) {
  const current = await revision(path);
  if (current !== expected) throw new BridgeError("REVISION_CONFLICT", `File changed. Read ${path} again before editing. Current revision: ${current}`);
}
export async function atomicReplace(path: string, content: string, expected: string): Promise<void> {
  await requireRevision(path, expected);
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temp = join(dirname(path), `.pi-tools-mcp-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", mode);
  try {
    await file.writeFile(content);
    await file.chmod(mode);
    await file.sync();
    await file.close();
    await requireRevision(path, expected);
    await rename(temp, path);
  } finally { await file.close().catch(() => {}); await rm(temp, { force: true }); }
}
export async function withPathLock<T>(directory: string, path: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, hash(path));
  const deadline = Date.now() + 10_000;
  while (true) {
    signal.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new BridgeError("FILE_BUSY", "Another bridge write holds this file lock. Inspect stale locks locally after a server crash.");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
export const fileAccess = (path: string) => access(path, constants.R_OK | constants.W_OK);
