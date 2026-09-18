import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call, fixture, http, httpClient } from "./helpers.ts";

function output(value: CallToolResult): string {
  // Some callers consume structuredContent alone. It must contain the actual text.
  const text = value.structuredContent?.output;
  assert.ok(typeof text === "string", "structured result is missing tool output");
  assert.equal(text, value.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
  return text;
}

test("HTTP structured results include file, search, command, error, and replay output", async t => {
  const f = await fixture(); t.after(f.close);
  await writeFile(join(f.project, "example.txt"), "first line\nsecond line\n");
  const server = await http(f.state); t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const opened = await call(client, "workspace_open", { cwd: f.project });
  assert.match(output(opened), /Workspace ready/);
  const workspace_id = opened.structuredContent.workspace_id;
  const read = await call(client, "read", { workspace_id, path: "example.txt", limit: 1 });
  assert.match(output(read), /^first line\n/);
  assert.match(output(read), /offset=2/);
  assert.match(read.structuredContent.revision, /^sha256:/);
  assert.equal(output(await call(client, "ls", { workspace_id })), "example.txt");
  assert.equal(output(await call(client, "find", { workspace_id, pattern: "*.txt" })), "example.txt");
  assert.match(output(await call(client, "grep", { workspace_id, path: "example.txt", pattern: "second" })), /second line/);
  const args = { workspace_id, request_key: "output", command: "printf 'command output\\n'" };
  const bash = await call(client, "bash", args);
  assert.equal(output(bash), "command output\n");
  assert.equal(bash.structuredContent.exit_code, 0);
  const failed = await call(client, "bash", { workspace_id, request_key: "failure", command: "printf 'command error\\n' >&2; exit 7" });
  assert.match(output(failed), /command error/);
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.exit_code, 7);
  const large = await call(client, "bash", { workspace_id, request_key: "large", command: "seq 1 10000" });
  assert.equal(large.structuredContent.details.truncation.truncated, true);
  assert.match(output(large), /10000/);
  assert.ok(output(large).includes(large.structuredContent.details.fullOutputPath));
  const edited = await call(client, "edit", { workspace_id, request_key: "edit", path: "example.txt", expected_revision: read.structuredContent.revision, edits: [{ oldText: "first", newText: "updated" }] });
  assert.match(output(edited), /Successfully replaced/);
  assert.match(edited.structuredContent.details.diff, /updated/);
  const written = await call(client, "write", { workspace_id, request_key: "write", path: "new.txt", expected_revision: "missing", content: "new file" });
  assert.match(output(written), /Successfully wrote/);
  const invalid = await call(client, "read", { workspace_id, path: "example.txt", unexpected: true });
  assert.ok(output(invalid).length);
  assert.equal(invalid.structuredContent.code, "INVALID_ARGUMENTS");
  await writeFile(join(f.project, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  const image = await call(client, "read", { workspace_id, path: "pixel.png" });
  output(image);
  assert.ok(image.content.some((block: { type: string }) => block.type === "image"));
  assert.match(output(await call(client, "workspace_close", { workspace_id })), /Workspace closed/);
  const replay = await call(client, "bash", args);
  assert.equal(output(replay), "command output\n");
  assert.equal(replay.structuredContent.replayed, true);
  await client.close(); await server.close();
  const restarted = await http(f.state); t.after(restarted.close);
  const next = await httpClient(restarted.url, restarted.authorization); t.after(() => next.close());
  const receipt = await call(next, "bash", args);
  assert.match(output(receipt), /already dispatched/);
  assert.equal(receipt.structuredContent.code, "RECORDED_OUTCOME");
  assert.doesNotMatch(output(receipt), /command output/);
});
