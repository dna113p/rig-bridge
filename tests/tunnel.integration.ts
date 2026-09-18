import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, concurrentProjects, delay, fixture, http, httpClient } from "./helpers.ts";

test("two clients through tunnel-client HTTP proxy keep independent project directories", { timeout: 35_000 }, async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  const urlFile = join(f.directory, "tunnel.json");
  const proxy = spawn(process.env.TUNNEL_CLIENT ?? "tunnel-client", ["dev", "proxy", "--mcp-server-url", server.url, "--url-file", urlFile, "--duration", "30s"], {
    env: { ...process.env, MCP_EXTRA_HEADERS: `Authorization: file:${server.tokenFile}`, MCP_DISCOVERY_EXTRA_HEADERS: `Authorization: file:${server.tokenFile}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "", spawnError: Error | undefined;
  proxy.stdout.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  proxy.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  proxy.on("error", error => { spawnError = error; });
  const exited = new Promise(resolve => proxy.on("close", resolve));
  t.after(async () => { proxy.kill("SIGTERM"); await exited; });
  let url: string | undefined;
  for (let i = 0; i < 200; i++) {
    if (spawnError) throw spawnError;
    try { url = JSON.parse(await readFile(urlFile, "utf8")).mcp_url; break; } catch {}
    await delay(50);
  }
  assert.ok(url, diagnostics);
  const a = await httpClient(url), b = await httpClient(url);
  t.after(() => a.close()); t.after(() => b.close());
  const workspace_id = await concurrentProjects(a, b, f.project, f.other);
  await writeFile(join(f.other, "output.txt"), "tunnel file output\n");
  const file = await call(b, "read", { workspace_id, path: "output.txt" });
  assert.equal(file.structuredContent.output, "tunnel file output\n");
  assert.equal(file.content[0].text, file.structuredContent.output);
  assert.match((await call(b, "ls", { workspace_id })).structuredContent.output, /output.txt/);
  await a.close(); await b.close();
  // Match remote callers that create a session for each tool invocation and
  // disconnect without DELETE. This must not exhaust the 64-session pool.
  for (let i = 0; i < 80; i++) {
    const client = await httpClient(url);
    try { assert.match((await call(client, "ls", { workspace_id })).structuredContent.output, /output.txt/); }
    finally { await client.close(); }
  }
  proxy.kill("SIGTERM"); await exited;
  const direct = await httpClient(server.url, server.authorization); t.after(() => direct.close());
  assert.equal((await call(direct, "read", { workspace_id, path: "ready-b" })).structuredContent.cwd, f.other);
  await call(direct, "workspace_close", { workspace_id });
});
