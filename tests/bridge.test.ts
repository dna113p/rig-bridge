import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { call, fixture, open, quote, stdio, untilFile } from "./helpers.ts";

test("nine real MCP tools, home/project context, and no automatic extension loading", async t => {
  const f = await fixture(); t.after(f.close);
  const h = await stdio(f.state); t.after(h.close);
  assert.deepEqual((await h.client.listTools()).tools.map(tool => tool.name).sort(), ["workspace_open", "workspace_close", "read", "write", "edit", "bash", "ls", "find", "grep"].sort());
  const home = await call(h.client, "workspace_open");
  assert.equal(home.structuredContent.cwd, homedir());
  assert.equal(home.structuredContent.models_for_tools, false);
  execFileSync("git", ["init", "-q", f.project]);
  await writeFile(join(f.project, "AGENTS.md"), "Read this project's instructions.");
  await mkdir(join(f.project, ".pi/extensions"), { recursive: true });
  await writeFile(join(f.project, ".pi/extensions/sentinel.ts"), `throw new Error('Extension must not be loaded');`);
  const opened = await call(h.client, "workspace_open", { cwd: f.project });
  assert.equal(opened.structuredContent.repository.root, f.project);
  assert.ok(opened.structuredContent.instructions.includes(join(f.project, "AGENTS.md")));
  const workspace_id = opened.structuredContent.workspace_id;
  for (const [name, args] of [
    ["ls", {}], ["find", { pattern: "AGENTS.md" }], ["grep", { pattern: "instructions", path: "AGENTS.md" }],
  ] as const) {
    const output = await call(h.client, name, { workspace_id, ...args });
    assert.notEqual(output.isError, true, JSON.stringify(output));
    assert.match(output.content[0].text, /AGENTS|instructions/);
  }
  assert.equal((await call(h.client, "read", { workspace_id, path: "AGENTS.md", unexpected: true })).structuredContent.code, "INVALID_ARGUMENTS");
  await call(h.client, "workspace_close", { workspace_id });
  assert.equal((await call(h.client, "workspace_close", { workspace_id })).structuredContent.closed, true);
  assert.equal((await call(h.client, "read", { workspace_id, path: "AGENTS.md" })).structuredContent.code, "WORKSPACE_EXPIRED");
});

test("Pi file edits, revisions, image reads, and unrestricted absolute/parent/symlink paths", async t => {
  const f = await fixture(); t.after(f.close);
  const h = await stdio(f.state); t.after(h.close);
  const workspace_id = await open(h.client, f.project);
  const path = join(f.other, "file.txt");
  await writeFile(path, "\ufeffhello\r\nworld\r\n"); await chmod(path, 0o750);
  await symlink(path, join(f.project, "link.txt"));
  const before = await call(h.client, "read", { workspace_id, path: "link.txt" });
  const edited = await call(h.client, "edit", { workspace_id, path: "link.txt", expected_revision: before.structuredContent.revision, edits: [{ oldText: "hello\nworld", newText: "hello\nupdated" }], request_key: "edit" });
  assert.notEqual(edited.isError, true, JSON.stringify(edited));
  assert.match(edited.structuredContent.details.diff, /updated/);
  assert.equal(await readFile(path, "utf8"), "\ufeffhello\r\nupdated\r\n");
  assert.equal((await stat(path)).mode & 0o777, 0o750);
  assert.equal((await lstat(join(f.project, "link.txt"))).isSymbolicLink(), true);
  const stale = await call(h.client, "write", { workspace_id, path, content: "stale", expected_revision: before.structuredContent.revision, request_key: "stale" });
  assert.equal(stale.structuredContent.code, "REVISION_CONFLICT");
  const created = await call(h.client, "write", { workspace_id, path: "../outside.txt", content: "outside\u2028cwd\u2029", expected_revision: "missing", request_key: "outside" });
  assert.notEqual(created.isError, true, JSON.stringify(created));
  assert.equal((await call(h.client, "read", { workspace_id, path: join(f.directory, "outside.txt") })).content[0].text, "outside\u2028cwd\u2029");
  await writeFile(join(f.project, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  const image = await call(h.client, "read", { workspace_id, path: "pixel.png" });
  assert.ok(image.content.some((entry: { type: string }) => entry.type === "image"), JSON.stringify(image));
});

test("shell cwd stays per call, outside writes work, duplicate delivery executes once, errors and output remain inspectable", async t => {
  const f = await fixture(); t.after(f.close);
  const h = await stdio(f.state); t.after(h.close);
  const workspace_id = await open(h.client, f.project);
  const args = { workspace_id, request_key: "once", command: "printf x >> ../counter.txt" };
  const outputs = await Promise.all([call(h.client, "bash", args), call(h.client, "bash", args)]);
  for (const output of outputs) assert.equal(output.structuredContent.exit_code, 0);
  assert.equal(await readFile(join(f.directory, "counter.txt"), "utf8"), "x");
  assert.equal((await call(h.client, "bash", { ...args, command: "printf wrong" })).structuredContent.code, "REQUEST_KEY_CONFLICT");
  await call(h.client, "bash", { workspace_id, request_key: "cd", command: "cd .. && pwd" });
  assert.equal((await call(h.client, "bash", { workspace_id, request_key: "pwd", command: "pwd" })).content[0].text.trim(), f.project);
  const failure = await call(h.client, "bash", { workspace_id, request_key: "failure", command: "printf error >&2; exit 7" });
  assert.equal(failure.structuredContent.exit_code, 7); assert.equal(failure.isError, true); assert.match(failure.content[0].text, /error/);
  const large = await call(h.client, "bash", { workspace_id, request_key: "large", command: "seq 1 10000" });
  assert.equal(large.structuredContent.details.truncation.truncated, true);
  const full = await call(h.client, "read", { workspace_id, path: large.structuredContent.details.fullOutputPath, limit: 2 });
  assert.match(full.content[0].text, /^1\n2/);
  const timeout = await call(h.client, "bash", { workspace_id, request_key: "timeout", command: "sleep 20", timeout: .1 });
  // The public contract rejects sub-second timeouts.
  assert.equal(timeout.structuredContent.code, "INVALID_ARGUMENTS");
  const timed = await call(h.client, "bash", { workspace_id, request_key: "timed", command: "sleep 20", timeout: 1 });
  assert.equal(timed.structuredContent.code, "COMMAND_TIMEOUT");
  await call(h.client, "workspace_close", { workspace_id });
  assert.equal((await call(h.client, "bash", args)).structuredContent.replayed, true);
});

test("MCP cancellation and workspace closure stop only their own commands", async t => {
  const f = await fixture(); t.after(f.close);
  const h = await stdio(f.state); t.after(h.close);
  const wa = await open(h.client, f.project), wb = await open(h.client, f.other);
  const controller = new AbortController();
  const args = { workspace_id: wa, request_key: "cancel", command: "echo $$ > cancel.pid; sleep 30; touch late" };
  const pending = h.client.callTool({ name: "bash", arguments: args }, undefined, { signal: controller.signal });
  const rejection = assert.rejects(pending);
  const pid = Number(await untilFile(join(f.project, "cancel.pid")));
  controller.abort(); await rejection;
  const receipt = await call(h.client, "bash", args);
  assert.equal(receipt.structuredContent.code, "COMMAND_CANCELLED");
  assert.throws(() => process.kill(pid, 0));
  const closingArgs = { workspace_id: wa, request_key: "close-running", command: "echo $$ > closing.pid; sleep 30" };
  const running = call(h.client, "bash", closingArgs);
  const closingPid = Number(await untilFile(join(f.project, "closing.pid")));
  await Promise.all([call(h.client, "workspace_close", { workspace_id: wa }), call(h.client, "workspace_close", { workspace_id: wa })]);
  assert.equal((await running).structuredContent.code, "COMMAND_CANCELLED");
  assert.throws(() => process.kill(closingPid, 0));
  assert.equal((await call(h.client, "bash", { workspace_id: wb, request_key: "still-open", command: "pwd" })).content[0].text.trim(), f.other);
  await assert.rejects(stat(join(f.project, "late")));
});

test("durable retry receipts survive restart and a real server crash without repeating effects", async t => {
  const f = await fixture(); t.after(f.close);
  let h = await stdio(f.state); t.after(() => h.close());
  const workspace_id = await open(h.client, f.project);
  const doneArgs = { workspace_id, request_key: "done", command: "printf x >> done.txt" };
  await call(h.client, "bash", doneArgs);
  await h.close();
  h = await stdio(f.state);
  const previous = await call(h.client, "bash", doneArgs);
  assert.equal(previous.structuredContent.status, "completed"); assert.equal(previous.structuredContent.replayed, true);
  assert.equal(await readFile(join(f.project, "done.txt"), "utf8"), "x");
  assert.equal((await call(h.client, "read", { workspace_id, path: "done.txt" })).structuredContent.code, "WORKSPACE_EXPIRED");
  const fresh = await open(h.client, f.project);
  const crashArgs = { workspace_id: fresh, request_key: "crash", command: "printf x >> uncertain.txt; echo $$ > crash.pid; sleep 30" };
  const crashed = call(h.client, "bash", crashArgs);
  const rejected = assert.rejects(crashed);
  const childPid = Number(await untilFile(join(f.project, "crash.pid")));
  assert.ok(Number.isInteger(childPid) && childPid > 1);
  t.after(() => { try { process.kill(-childPid, "SIGKILL"); } catch {} });
  process.kill(h.transport.pid!, "SIGKILL");
  await rejected; await h.close();
  // A forced server kill can leave a detached shell; stop this test-owned group.
  try { process.kill(-childPid, "SIGKILL"); } catch {}
  h = await stdio(f.state);
  const uncertain = await call(h.client, "bash", crashArgs);
  assert.equal(uncertain.structuredContent.code, "OUTCOME_UNCERTAIN");
  assert.equal(await readFile(join(f.project, "uncertain.txt"), "utf8"), "x");
  const next = await open(h.client, f.other);
  assert.equal((await call(h.client, "bash", { workspace_id: next, request_key: "done", command: `test -f ${quote(join(f.project, "done.txt"))}` })).structuredContent.exit_code, 0);
});
