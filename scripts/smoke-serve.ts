#!/usr/bin/env node
// Starts `cli.ts serve` exactly as the service does, on a free port with a
// throwaway state directory, and checks what a client and the dashboard see.
// It never touches the owner's state directory or port 8767.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "rig-bridge-smoke-"));
const state = join(directory, "state");
const child = spawn(process.execPath, [join(root, "src/cli.ts"), "serve", "--port", "0", "--state-dir", state], {
  cwd: directory,
  env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "pi-agent") },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));

const step = async (name: string, check: () => Promise<void>) => {
  await check();
  console.log(`ok - ${name}`);
};

try {
  const base = await step("serve announces its address", async () => {
    for (let i = 0; i < 300 && !/listening at /u.test(output) && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(output, /rig-bridge listening at http:\/\/127\.0\.0\.1:\d+\/mcp/u, output);
  }).then(() => /listening at (http:\/\/127\.0\.0\.1:\d+)\/mcp/u.exec(output)![1]!);

  const tokenFile = join(state, "http-authorization");
  const authorization = (await readFile(tokenFile, "utf8")).trim();
  await step("first start creates an owner-only bearer file", async () => {
    assert.equal((await stat(tokenFile)).mode & 0o077, 0);
    assert.match(authorization, /^Bearer [A-Za-z0-9_-]{43,}$/u);
    assert.ok(!output.includes(authorization.slice(7)), "the credential must never be printed");
  });

  await step("health, dashboard, and status respond", async () => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "live");
    for (const path of ["/", "/ui"]) {
      const page = await fetch(base + path);
      assert.equal(page.status, 200, path);
      assert.match(await page.text(), /<title>Rig Bridge/u, path);
    }
    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    assert.ok(Array.isArray((await status.json() as { workspaces?: unknown }).workspaces));
  });

  await step("MCP refuses a missing or wrong bearer", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers, body })).status, 401);
    assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer wrong" }, body })).status, 401);
  });

  await step("an authenticated MCP client lists the tools and opens a workspace", async () => {
    const client = new Client({ name: "smoke", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization } } }));
    try {
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      for (const name of ["workspace_open", "bash", "read", "work_handoff"]) assert.ok(tools.includes(name), name);
      const opened = await client.callTool({ name: "workspace_open", arguments: { cwd: directory } }) as { isError?: boolean; structuredContent?: { cwd?: string } };
      assert.notEqual(opened.isError, true, JSON.stringify(opened));
      assert.equal(opened.structuredContent?.cwd, directory);
    } finally { await client.close(); }
  });

  await step("SIGTERM shuts down cleanly", async () => {
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve("timeout"), 10_000).unref())]);
    assert.equal(code, 0, output);
  });
} catch (error) {
  console.error(`not ok - ${(error as Error).message}\n--- server output ---\n${output}`);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
