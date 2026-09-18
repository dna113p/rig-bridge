import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { call, concurrentProjects, fixture, http, httpClient, open, untilFile } from "./helpers.ts";

test("authenticated HTTP: concurrent projects, shared file conflicts, reconnects, and request rejection", async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  const originalCwd = process.cwd();
  const a = await httpClient(server.url, server.authorization), b = await httpClient(server.url, server.authorization);
  t.after(() => a.close()); t.after(() => b.close());
  const survivor = await concurrentProjects(a, b, f.project, f.other);
  assert.equal(process.cwd(), originalCwd);
  await a.close();
  const reconnect = await httpClient(server.url, server.authorization); t.after(() => reconnect.close());
  assert.equal((await call(reconnect, "bash", { workspace_id: survivor, request_key: "reconnected", command: "pwd" })).content[0].text.trim(), f.other);
  const shared = join(f.directory, "shared.txt"); await writeFile(shared, "original");
  const wa = await open(reconnect, f.project), wb = await open(b, f.other);
  const revision = (await call(reconnect, "read", { workspace_id: wa, path: shared })).structuredContent.revision;
  const results = await Promise.all([
    call(reconnect, "write", { workspace_id: wa, path: shared, expected_revision: revision, content: "A", request_key: "write" }),
    call(b, "write", { workspace_id: wb, path: shared, expected_revision: revision, content: "B", request_key: "write" }),
  ]);
  assert.equal(results.filter(value => value.isError).length, 1);
  assert.equal(results.find(value => value.isError).structuredContent.code, "REVISION_CONFLICT");
  assert.ok(["A", "B"].includes(await readFile(shared, "utf8")));
  const controller = new AbortController();
  const command = { workspace_id: wb, request_key: "http-cancel", command: "echo $$ > http.pid; sleep 30" };
  const running = b.callTool({ name: "bash", arguments: command }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(running);
  const pid = Number(await untilFile(join(f.other, "http.pid")));
  controller.abort(); await rejected;
  assert.equal((await call(reconnect, "bash", command)).structuredContent.code, "COMMAND_CANCELLED");
  assert.throws(() => process.kill(pid, 0));
  assert.equal((await fetch(server.url, { method: "POST" })).status, 401);
  assert.equal((await fetch(server.url, { method: "POST", headers: { authorization: server.authorization, origin: "https://untrusted.invalid" } })).status, 403);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(server.url, { method: "POST", headers: { authorization: server.authorization, host: "untrusted.invalid" } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject); req.end();
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(server.url, { method: "POST", headers: { authorization: server.authorization, "content-type": "application/json" }, body: "invalid" })).status, 400);
  assert.equal((await fetch(server.url, { method: "POST", headers: { authorization: server.authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status, 400);
});
