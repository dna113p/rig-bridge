import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fixture, http, httpClient, call, delay, open, root } from "./helpers.ts";
import { Bridge } from "../src/server.ts";
import type { BridgeStatusView } from "../src/server.ts";
import type { DesktopNotification } from "../src/notifications.ts";

async function opened(client: Awaited<ReturnType<typeof httpClient>>, args: Record<string, unknown>) {
  const value = await call(client, "workspace_open", args);
  assert.notEqual(value.isError, true, JSON.stringify(value));
  return value.structuredContent;
}
async function status(server: Awaited<ReturnType<typeof http>>): Promise<BridgeStatusView> {
  return await (await fetch(server.url.replace("/mcp", "/api/status"))).json();
}
async function post(server: Awaited<ReturnType<typeof http>>, route: string, payload: unknown) {
  return fetch(server.url.replace("/mcp", route), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
}

test("projects group Git subdirectories and worktrees while keeping handles, retries and cancellation isolated", async t => {
  const f = await fixture(); t.after(f.close);
  const git = (...args: string[]) => execFileSync("git", ["-C", f.project, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "initial");
  const sub = join(f.project, "src"), worktree = join(f.directory, "worktree"), clone = join(f.directory, "clone");
  await mkdir(sub);
  git("worktree", "add", "-qb", "other", worktree);
  execFileSync("git", ["clone", "-q", f.project, clone]);
  const server = await http(f.state); t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const a = await opened(client, { cwd: f.project, title: "First conversation" });
  const b = await opened(client, { cwd: sub, title: "Second conversation" });
  const c = await opened(client, { cwd: worktree, title: "Isolated checkout" });
  const d = await opened(client, { cwd: clone });
  assert.equal(a.project_id, b.project_id);
  assert.equal(a.project_id, c.project_id);
  assert.notEqual(a.project_id, d.project_id);
  assert.notEqual(a.workspace_id, b.workspace_id);
  assert.notEqual(a.thread_id, b.thread_id);
  const groupedClone = await opened(client, { cwd: clone, project_id: a.project_id });
  assert.equal(groupedClone.project_id, a.project_id);
  const listed = await call(client, "workspace_list");
  assert.equal(listed.structuredContent.projects.length, 2);
  assert.equal(listed.structuredContent.projects.find((p: any) => p.id === a.project_id).threads.length, 4);
  await call(client, "bash", { workspace_id: a.workspace_id, request_key: "same", command: "pwd" });
  await call(client, "workspace_close", { workspace_id: a.workspace_id });
  const output = await call(client, "bash", { workspace_id: b.workspace_id, request_key: "same", command: "pwd" });
  assert.equal(output.structuredContent.output.trim(), sub);
  const resumed = await opened(client, { thread_id: a.thread_id });
  assert.notEqual(resumed.workspace_id, a.workspace_id);
  assert.equal(resumed.project_id, a.project_id);
  const simultaneous = await Promise.all([opened(client, { thread_id: a.thread_id }), opened(client, { thread_id: a.thread_id })]);
  assert.equal(simultaneous[0].workspace_id, resumed.workspace_id);
  assert.equal(simultaneous[1].workspace_id, resumed.workspace_id);
  assert.equal((await status(server)).projectsCount, 2);
  const port = new URL(server.url).port;
  const cli = await promisify(execFile)(process.execPath, [join(root, "src/cli.ts"), "status", "--port", port]);
  assert.match(cli.stdout, /Workspace\(s\)/);
  assert.match(cli.stdout, /First conversation/);
  assert.match(cli.stdout, /Second conversation/);
});

test("non-Git project roots group directories explicitly and reject inconsistent thread resumes", async t => {
  const f = await fixture(); t.after(f.close);
  const sub = join(f.project, "nested"); await mkdir(sub);
  const server = await http(f.state); t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const a = await opened(client, { cwd: f.project });
  const b = await opened(client, { cwd: sub, project_root: f.project });
  assert.equal(a.project_id, b.project_id);
  const bad = await call(client, "workspace_open", { cwd: f.other, thread_id: a.thread_id });
  assert.equal(bad.structuredContent.code, "THREAD_CONFLICT");
  const outside = await call(client, "workspace_open", { cwd: f.other, project_root: f.project });
  assert.equal(outside.structuredContent.code, "INVALID_PROJECT_ROOT");
  const resumed = await opened(client, { thread_id: b.thread_id, title: "Renamed conversation" });
  assert.equal(resumed.thread.title, "Renamed conversation");
});

test("explicit handoffs create one unread event, survive restart, and allow later runs in the same thread", async t => {
  const f = await fixture(); t.after(f.close);
  const first = await http(f.state);
  const client = await httpClient(first.url, first.authorization);
  const a = await opened(client, { cwd: f.project, title: "Notification work" });
  const run = await call(client, "run_start", { workspace_id: a.workspace_id, request_key: "start", title: "Implement notifications" });
  assert.ok(run.structuredContent.run_id);
  const args = { workspace_id: a.workspace_id, request_key: "handoff", run_id: run.structuredContent.run_id, reason: "completed", summary: "Implemented; checks pass." };
  const [done, replay] = await Promise.all([call(client, "work_handoff", args), call(client, "work_handoff", args)]);
  assert.equal(done.structuredContent.handoff_id, replay.structuredContent.handoff_id);
  assert.equal((await status(first)).unreadCount, 1);
  assert.equal((await status(first)).projects[0].threads[0].run?.status, "completed");
  assert.equal((await call(client, "work_handoff", { ...args, summary: "Changed" })).structuredContent.code, "REQUEST_KEY_CONFLICT");
  assert.equal((await call(client, "work_handoff", { ...args, request_key: "different" })).structuredContent.code, "RUN_FINISHED");
  assert.equal((await call(client, "bash", { workspace_id: a.workspace_id, request_key: "handoff", command: "true" })).structuredContent.code, "REQUEST_KEY_CONFLICT");
  await call(client, "bash", { workspace_id: a.workspace_id, request_key: "follow-up", command: "pwd" });
  const afterFollowup = await status(first);
  assert.equal(afterFollowup.projects[0].threads[0].run?.status, "working");
  assert.notEqual(afterFollowup.projects[0].threads[0].run?.id, run.structuredContent.run_id);
  // Tool completion alone leaves the run awaiting a handoff.
  assert.equal(afterFollowup.unreadCount, 1);
  assert.equal((await call(client, "work_handoff", { workspace_id: a.workspace_id, request_key: "follow-up", reason: "completed", summary: "Key collision" })).structuredContent.code, "REQUEST_KEY_CONFLICT");
  await client.close(); await first.close();
  const second = await http(f.state); t.after(second.close);
  const next = await httpClient(second.url, second.authorization); t.after(() => next.close());
  const restored = await status(second);
  assert.equal(restored.projects[0].threads[0].run?.status, "interrupted");
  assert.equal(restored.unreadCount, 1);
  const retried = await call(next, "work_handoff", args);
  assert.equal(retried.structuredContent.replayed, true);
  assert.equal(retried.structuredContent.handoff_id, done.structuredContent.handoff_id);
  assert.equal((await status(second)).notifications.length, 1);
  const resumed = await opened(next, { thread_id: a.thread_id });
  assert.notEqual(resumed.workspace_id, a.workspace_id);
  const needsInput = await call(next, "work_handoff", { workspace_id: resumed.workspace_id, request_key: "question", reason: "needs_input", summary: "Which notification channel?" });
  assert.equal(needsInput.structuredContent.handoff.reason, "needs_input");
  assert.equal((await post(second, "/api/handoffs/read", { handoff_id: done.structuredContent.handoff_id })).status, 200);
  assert.equal((await status(second)).unreadCount, 1);
  assert.equal((await stat(join(f.state, "work.sqlite"))).mode & 0o777, 0o600);
});

test("handoff waits for its thread's active calls while other threads can continue working", async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const a = await open(client, f.project), b = await open(client, f.project);
  const pending = call(client, "bash", { workspace_id: a, request_key: "running", command: "sleep .5" });
  for (let i = 0; i < 40 && !(await status(server)).activeCommandsCount; i++) await delay(10);
  const args = { workspace_id: a, request_key: "handoff", reason: "blocked", summary: "Needs investigation" };
  assert.equal((await call(client, "work_handoff", args)).structuredContent.code, "WORK_ACTIVE");
  assert.notEqual((await call(client, "work_handoff", { ...args, workspace_id: b })).isError, true);
  await pending;
  assert.notEqual((await call(client, "work_handoff", args)).isError, true);
  assert.equal((await status(server)).unreadCount, 2);
});

test("desktop alerts respect project preferences, deduplicate deliveries, and retain failures in the inbox", async t => {
  const f = await fixture(); t.after(f.close);
  const delivered: DesktopNotification[] = [];
  const server = await http(f.state, { notifyDesktop: async event => { delivered.push(event); if (event.body.includes("Fail")) throw new Error("Desktop session unavailable"); } });
  t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const a = await opened(client, { cwd: f.project, title: "Alerts" });
  const handoff = async (key: string, summary: string) => call(client, "work_handoff", { workspace_id: a.workspace_id, request_key: key, reason: "completed", summary });
  await handoff("disabled", "No desktop preference yet");
  assert.equal(delivered.length, 0);
  assert.equal((await post(server, "/api/projects/preferences", { project_id: a.project_id, desktop_notifications: "true" })).status, 400);
  assert.equal((await post(server, "/api/projects/preferences", { project_id: a.project_id, desktop_notifications: true })).status, 200);
  await call(client, "run_start", { workspace_id: a.workspace_id, request_key: "run2" });
  await handoff("enabled", "Ready");
  await handoff("enabled", "Ready");
  for (let i = 0; i < 30 && (await status(server)).notifications[0].desktopDelivery !== "sent"; i++) await delay(10);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].title, "project · Your turn");
  assert.match(delivered[0].url, /#thread=/);
  await call(client, "run_start", { workspace_id: a.workspace_id, request_key: "run3" });
  await handoff("failed-delivery", "Fail delivery");
  for (let i = 0; i < 30 && (await status(server)).notifications[0].desktopDelivery !== "failed"; i++) await delay(10);
  const data = await status(server);
  assert.equal(data.notifications[0].deliveryError, "Desktop session unavailable");
  assert.equal(data.unreadCount, 3);
});

test("handoff cannot overtake an execution request queued for receipt dispatch", async t => {
  const f = await fixture(); t.after(f.close);
  const bridge = new Bridge(f.state); t.after(() => bridge.close());
  const opened = await bridge.call("workspace_open", { cwd: f.project });
  const workspace_id = opened.structuredContent!.workspace_id;
  const pending = bridge.call("bash", { workspace_id, request_key: "queued", command: "printf done" });
  const handoff = await bridge.call("work_handoff", { workspace_id, request_key: "finish", reason: "completed", summary: "Finished" });
  assert.equal(handoff.structuredContent!.code, "WORK_ACTIVE");
  await pending;
  const finished = await bridge.call("work_handoff", { workspace_id, request_key: "finish", reason: "completed", summary: "Finished" });
  assert.notEqual(finished.isError, true);
  assert.equal(bridge.getStatus().unreadCount, 1);
});
