import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, fixture, http, httpClient, open, untilFile } from "./helpers.ts";

interface Endpoint { url: string; authorization: string }
function request(server: Endpoint, session: string | undefined, method: string, params = {}, signal?: AbortSignal) {
  return fetch(server.url, { method: "POST", signal, headers: {
    authorization: server.authorization, "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" } : {}),
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}
async function initialize(server: Endpoint): Promise<string> {
  const response = await request(server, undefined, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "session-churn", version: "1" },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const session = response.headers.get("mcp-session-id");
  assert.ok(session);
  return session;
}

test("HTTP session churn reclaims idle sessions without losing workspaces or retry results", async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  const original = await httpClient(server.url, server.authorization); t.after(() => original.close());
  const workspace_id = await open(original, f.project);
  const oldSession = original.transport?.sessionId;
  assert.ok(oldSession);
  const args = { workspace_id, request_key: "once", command: "printf x >> counter.txt; printf 'original output'" };
  await call(original, "bash", args);
  // Leave the SDK's idle GET/SSE stream open, as a real connected client does.
  for (let i = 0; i < 80; i++) {
    const session = await initialize(server);
    const response = await request(server, session, "tools/list");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.tools.length, 10);
  }
  const expired = await request(server, oldSession, "tools/list");
  assert.equal(expired.status, 404);
  await expired.body?.cancel();
  const next = await httpClient(server.url, server.authorization); t.after(() => next.close());
  const replay = await call(next, "bash", args);
  assert.equal(replay.structuredContent.replayed, true);
  assert.equal(replay.structuredContent.output, "original output");
  assert.equal(await readFile(join(f.project, "counter.txt"), "utf8"), "x");
  assert.equal((await call(next, "read", { workspace_id, path: "counter.txt" })).structuredContent.output, "x");
  await call(next, "workspace_close", { workspace_id });
});

test("session pressure preserves an active command even after its HTTP caller disconnects", { timeout: 15_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const workspace_id = await open(client, f.project);
  const busySession = await initialize(server);
  const args = { workspace_id, request_key: "busy", command: "echo $$ > running.pid; while ! test -e release; do sleep .02; done; printf 'finished safely'" };
  const controller = new AbortController();
  const running = request(server, busySession, "tools/call", { name: "bash", arguments: args }, controller.signal);
  const rejected = assert.rejects(running, { name: "AbortError" });
  const pid = Number(await untilFile(join(f.project, "running.pid")));
  controller.abort(); await rejected;
  for (let i = 0; i < 80; i++) await initialize(server);
  const stillPresent = await request(server, busySession, "tools/list");
  assert.equal(stillPresent.status, 200, "active command's session must not be evicted");
  await stillPresent.body?.cancel();
  process.kill(pid, 0);
  await writeFile(join(f.project, "release"), "");
  const next = await httpClient(server.url, server.authorization); t.after(() => next.close());
  const outcome = await call(next, "bash", args);
  assert.notEqual(outcome.isError, true, JSON.stringify(outcome));
  assert.equal(outcome.structuredContent.output, "finished safely");
  await call(next, "workspace_close", { workspace_id });
});

test("concurrent initializations keep the session pool bounded and failed initialization frees its slot", async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  // An invalid Accept header fails in the SDK after the HTTP wrapper allocates a transport.
  for (let i = 0; i < 70; i++) {
    const invalid = await fetch(server.url, { method: "POST", headers: {
      authorization: server.authorization, "content-type": "application/json", accept: "text/plain",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "invalid", version: "1" },
    } }) });
    assert.equal(invalid.status, 406);
    await invalid.body?.cancel();
  }
  const sessions: string[] = [];
  for (let round = 0; round < 4; round++) sessions.push(...await Promise.all(Array.from({ length: 32 }, () => initialize(server))));
  let retained = 0;
  for (const session of sessions) {
    const response = await request(server, session, "tools/list");
    assert.ok([200, 404].includes(response.status));
    if (response.status === 200) retained++;
    await response.body?.cancel();
  }
  assert.equal(retained, 64);
});
