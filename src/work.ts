import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, canonical } from "./common.ts";

const exec = promisify(execFile);
export type HandoffReason = "completed" | "needs_input" | "blocked" | "failed" | "cancelled";
export interface Run {
  id: string; threadId: string; title: string; status: "working" | "interrupted" | HandoffReason;
  startedAt: number; completedAt: number | null; summary: string | null;
}
export interface Thread {
  id: string; projectId: string; title: string; cwd: string; createdAt: number; lastUsed: number;
}
export interface Project {
  id: string; identity: string; name: string; root: string; createdAt: number; lastUsed: number; desktopNotifications: boolean;
}
export interface Handoff {
  id: string; projectId: string; threadId: string; runId: string; reason: HandoffReason; summary: string;
  createdAt: number; readAt: number | null;
  desktopDelivery: "pending" | "sending" | "sent" | "failed" | "disabled" | "unknown";
  deliveryError: string | null;
}
export interface ProjectIdentity { identity: string; root: string; name: string }

/** Worktrees share the common Git directory. Independent clones have independent identities. */
export async function discoverProject(cwd: string, projectRoot?: string): Promise<ProjectIdentity> {
  if (projectRoot) {
    const root = await realpath(projectRoot);
    const rel = relative(root, cwd);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new BridgeError("INVALID_PROJECT_ROOT", "cwd must be inside project_root");
    return { identity: `directory:${root}`, root, name: basename(root) || root };
  }
  try {
    const options = { timeout: 5000, maxBuffer: 64_000 };
    const [common, top] = await Promise.all([
      exec("git", ["--no-optional-locks", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], options),
      exec("git", ["--no-optional-locks", "-C", cwd, "rev-parse", "--show-toplevel"], options),
    ]);
    const gitDir = await realpath(common.stdout.trim());
    const root = basename(gitDir) === ".git" ? dirname(gitDir) : await realpath(top.stdout.trim());
    return { identity: `git:${gitDir}`, root, name: basename(root) || root };
  } catch {
    return { identity: `directory:${cwd}`, root: cwd, name: basename(cwd) || cwd };
  }
}

/** Persistent project/thread/run state. Control requests and handoffs commit atomically. */
export class WorkStore {
  private db: DatabaseSync;
  constructor(directory: string) {
    const path = join(directory, "work.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, name TEXT NOT NULL, root TEXT NOT NULL, createdAt INTEGER NOT NULL, lastUsed INTEGER NOT NULL, desktopNotifications INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL, createdAt INTEGER NOT NULL, lastUsed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS handles (id TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, completedAt INTEGER, summary TEXT);
      CREATE INDEX IF NOT EXISTS runs_thread ON runs(threadId, startedAt);
      CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, threadId TEXT NOT NULL, runId TEXT UNIQUE NOT NULL, reason TEXT NOT NULL, summary TEXT NOT NULL, createdAt INTEGER NOT NULL, readAt INTEGER, desktopDelivery TEXT NOT NULL, deliveryError TEXT);
      CREATE TABLE IF NOT EXISTS control_requests (handleId TEXT NOT NULL, requestKey TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(handleId, requestKey));
      UPDATE runs SET status='interrupted' WHERE status='working';
      UPDATE handoffs SET desktopDelivery='unknown', deliveryError='Bridge stopped during delivery; delivery outcome is unknown' WHERE desktopDelivery='sending';`);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  project(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as unknown as Project | undefined;
    if (!row) throw new BridgeError("PROJECT_NOT_FOUND", "Choose an existing project_id from workspace_list");
    return { ...row, desktopNotifications: !!row.desktopNotifications };
  }

  openProject(identity: ProjectIdentity, projectId?: string): Project {
    if (projectId) return this.project(projectId);
    const now = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO projects(id,identity,name,root,createdAt,lastUsed) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), identity.identity, identity.name, identity.root, now, now);
    const row = this.db.prepare("SELECT id FROM projects WHERE identity=?").get(identity.identity) as { id: string };
    return this.project(row.id);
  }

  thread(id: string): Thread {
    const row = this.db.prepare("SELECT * FROM threads WHERE id=?").get(id) as unknown as Thread | undefined;
    if (!row) throw new BridgeError("THREAD_NOT_FOUND", "Choose an existing thread_id from workspace_list");
    return row;
  }

  openThread(project: Project, cwd: string, title?: string, threadId?: string): Thread {
    if (threadId) {
      const thread = this.thread(threadId);
      if (thread.projectId !== project.id || thread.cwd !== cwd) throw new BridgeError("THREAD_CONFLICT", "A resumed thread must use its saved project and cwd");
      if (title) this.db.prepare("UPDATE threads SET title=? WHERE id=?").run(title, thread.id);
      this.touch(thread.id);
      return this.thread(thread.id);
    }
    const id = randomUUID(), now = Date.now();
    this.db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)").run(id, project.id, title ?? "Untitled thread", cwd, now, now);
    this.touch(id);
    return this.thread(id);
  }

  attach(handleId: string, threadId: string) { this.db.prepare("INSERT INTO handles VALUES(?,?)").run(handleId, threadId); }

  private threadForHandle(handleId: string): Thread {
    const row = this.db.prepare("SELECT threadId FROM handles WHERE id=?").get(handleId) as { threadId: string } | undefined;
    if (!row) throw new BridgeError("WORKSPACE_EXPIRED", "Open a workspace first");
    return this.thread(row.threadId);
  }

  private touch(threadId: string) {
    const thread = this.thread(threadId), now = Date.now();
    this.db.prepare("UPDATE threads SET lastUsed=? WHERE id=?").run(now, threadId);
    this.db.prepare("UPDATE projects SET lastUsed=? WHERE id=?").run(now, thread.projectId);
  }

  latestRun(threadId: string): Run | undefined {
    return this.db.prepare("SELECT * FROM runs WHERE threadId=? ORDER BY rowid DESC LIMIT 1").get(threadId) as unknown as Run | undefined;
  }

  private newRun(thread: Thread, title?: string): Run {
    const id = randomUUID();
    this.db.prepare("INSERT INTO runs(id,threadId,title,status,startedAt) VALUES(?,?,?,'working',?)").run(id, thread.id, title ?? thread.title, Date.now());
    this.touch(thread.id);
    return this.latestRun(thread.id)!;
  }

  activity(threadId: string): Run {
    const run = this.latestRun(threadId);
    this.touch(threadId);
    return run?.status === "working" ? run : this.newRun(this.thread(threadId));
  }

  interrupt(threadId: string) {
    this.db.prepare("UPDATE runs SET status='interrupted' WHERE threadId=? AND status='working'").run(threadId);
  }

  replay(handleId: string, key: string, input: unknown): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT fingerprint,response FROM control_requests WHERE handleId=? AND requestKey=?").get(handleId, key) as { fingerprint: string; response: string } | undefined;
    if (!row) return;
    if (row.fingerprint !== canonical(input)) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key was already used with different input");
    return { ...JSON.parse(row.response), replayed: true };
  }

  private keyed(handleId: string, key: string, input: unknown, operation: () => Record<string, unknown>): Record<string, unknown> {
    return this.transaction(() => {
      const replay = this.replay(handleId, key, input);
      if (replay) return replay;
      const response = operation();
      this.db.prepare("INSERT INTO control_requests VALUES(?,?,?,?)").run(handleId, key, canonical(input), JSON.stringify(response));
      return response;
    });
  }

  start(handleId: string, key: string, input: { title?: string }): Record<string, unknown> {
    return this.keyed(handleId, key, { tool: "run_start", ...input }, () => {
      const thread = this.threadForHandle(handleId);
      const current = this.latestRun(thread.id);
      if (current?.status === "working") throw new BridgeError("RUN_ACTIVE", "Hand off the current run before starting another");
      const run = this.newRun(thread, input.title);
      return { workspace_id: handleId, project_id: thread.projectId, thread_id: thread.id, run_id: run.id, run };
    });
  }

  handoff(handleId: string, key: string, input: { reason: HandoffReason; summary: string; run_id?: string }): Record<string, unknown> {
    return this.keyed(handleId, key, { tool: "work_handoff", ...input }, () => {
      const thread = this.threadForHandle(handleId);
      let run = this.latestRun(thread.id);
      if (input.run_id && run?.id !== input.run_id) throw new BridgeError("RUN_CONFLICT", "run_id must be the thread's current run");
      if (run && run.status !== "working" && run.status !== "interrupted") {
        throw new BridgeError("RUN_FINISHED", "This run already has a handoff. Reuse its original request_key, or start a new run for new work.");
      }
      run ??= this.newRun(thread);
      const project = this.project(thread.projectId), id = randomUUID(), now = Date.now();
      this.db.prepare("UPDATE runs SET status=?,completedAt=?,summary=? WHERE id=?").run(input.reason, now, input.summary, run.id);
      this.db.prepare("INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,?,NULL)").run(id, project.id, thread.id, run.id, input.reason, input.summary, now, null, project.desktopNotifications ? "pending" : "disabled");
      this.touch(thread.id);
      const handoff = this.db.prepare("SELECT * FROM handoffs WHERE id=?").get(id) as unknown as Handoff;
      return { workspace_id: handleId, project_id: project.id, thread_id: thread.id, run_id: run.id, handoff_id: id, handoff };
    });
  }

  list() {
    const projects = (this.db.prepare("SELECT * FROM projects ORDER BY lastUsed DESC").all() as unknown as Project[])
      .map(p => ({ ...p, desktopNotifications: !!p.desktopNotifications }));
    const threads = this.db.prepare("SELECT * FROM threads ORDER BY lastUsed DESC").all() as unknown as Thread[];
    return projects.map(project => ({ ...project, threads: threads.filter(t => t.projectId === project.id)
      .map(thread => ({ ...thread, run: this.latestRun(thread.id), runs: this.db.prepare("SELECT * FROM runs WHERE threadId=? ORDER BY rowid DESC LIMIT 20").all(thread.id) as unknown as Run[] })) }));
  }

  inbox() {
    // Include all unread events even when the recent read history exceeds the display window.
    return this.db.prepare("SELECT * FROM handoffs WHERE readAt IS NULL OR id IN (SELECT id FROM handoffs ORDER BY rowid DESC LIMIT 100) ORDER BY rowid DESC").all() as unknown as Handoff[];
  }

  acknowledge(id: string) {
    if (!this.db.prepare("UPDATE handoffs SET readAt=COALESCE(readAt,?) WHERE id=?").run(Date.now(), id).changes) throw new BridgeError("HANDOFF_NOT_FOUND", "Handoff not found");
  }

  preferences(id: string, desktopNotifications: boolean) {
    this.project(id);
    this.db.prepare("UPDATE projects SET desktopNotifications=? WHERE id=?").run(Number(desktopNotifications), id);
  }

  claimDelivery(): Handoff | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM handoffs WHERE desktopDelivery='pending' ORDER BY rowid LIMIT 1").get() as unknown as Handoff | undefined;
      if (row) this.db.prepare("UPDATE handoffs SET desktopDelivery='sending' WHERE id=?").run(row.id);
      return row;
    });
  }

  hasPendingDelivery(): boolean { return !!this.db.prepare("SELECT 1 FROM handoffs WHERE desktopDelivery='pending' LIMIT 1").get(); }

  hasControlRequest(handleId: string, key: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM control_requests WHERE handleId=? AND requestKey=?").get(handleId, key);
  }

  delivered(id: string, error?: string) {
    this.db.prepare("UPDATE handoffs SET desktopDelivery=?,deliveryError=? WHERE id=?").run(error ? "failed" : "sent", error ?? null, id);
  }

  close() { this.db.close(); }
}
