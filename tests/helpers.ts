import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Bridge } from "../src/server.ts";
import { serveHttp } from "../src/http.ts";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const call = (client: Client, name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
export async function open(client: Client, cwd?: string): Promise<string> {
  const value = await call(client, "workspace_open", cwd ? { cwd } : {});
  assert.notEqual(value.isError, true, JSON.stringify(value));
  return value.structuredContent.workspace_id;
}
export async function untilFile(path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    try { const value = await readFile(path, "utf8"); if (value.trim()) return value; } catch {}
    await delay(25);
  }
  throw new Error(`File did not appear: ${path}`);
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-tools-mcp-test-"));
  const project = join(directory, "project"), other = join(directory, "other");
  await Promise.all([mkdir(project), mkdir(other)]);
  return { directory, project, other, state: join(directory, "state"), close: () => rm(directory, { recursive: true, force: true }) };
}
export async function stdio(state: string) {
  const client = new Client({ name: "test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "src/cli.ts"), "--state-dir", state], stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", data => { diagnostics = (diagnostics + data).slice(-4000); });
  await client.connect(transport);
  return { client, transport, diagnostics: () => diagnostics, close: () => client.close() };
}
export async function httpClient(url: string, authorization?: string) {
  const client = new Client({ name: "http-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: authorization ? { authorization } : {} } }));
  return client;
}
export async function http(state: string) {
  await mkdir(state, { recursive: true });
  const tokenFile = join(state, "http-authorization"), authorization = `Bearer ${randomBytes(32).toString("base64url")}`;
  await writeFile(tokenFile, authorization, { mode: 0o600 });
  const bridge = new Bridge(state);
  const server = await serveHttp(bridge, { port: 0, tokenFile });
  return { ...server, tokenFile, authorization, close: async () => { await bridge.close(); await server.close(); } };
}

export async function concurrentProjects(a: Client, b: Client, project: string, other: string) {
  const [wa, wb] = await Promise.all([open(a, project), open(b, other)]);
  const barrierA = join(project, "ready-a"), barrierB = join(other, "ready-b");
  const command = (mine: string, theirs: string) => `touch ${quote(mine)}; for i in $(seq 1 100); do if test -e ${quote(theirs)}; then pwd; exit 0; fi; sleep .02; done; exit 9`;
  const outputs = await Promise.all([
    call(a, "bash", { workspace_id: wa, request_key: "barrier", command: command(barrierA, barrierB) }),
    call(b, "bash", { workspace_id: wb, request_key: "barrier", command: command(barrierB, barrierA) }),
  ]);
  for (const output of outputs) assert.equal(output.structuredContent.exit_code, 0, JSON.stringify(output));
  assert.equal(outputs[0].content[0].text.trim(), project);
  assert.equal(outputs[1].content[0].text.trim(), other);
  assert.equal(outputs[0].structuredContent.output.trim(), project);
  assert.equal(outputs[1].structuredContent.output.trim(), other);
  await call(a, "workspace_close", { workspace_id: wa });
  assert.equal((await call(b, "bash", { workspace_id: wb, request_key: "still-open", command: "pwd" })).content[0].text.trim(), other);
  return wb;
}
