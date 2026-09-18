import { Ajv } from "ajv";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError } from "./common.ts";

const string = { type: "string", minLength: 1 };
const workspace = { workspace_id: string };
const keyed = { ...workspace, request_key: { ...string, maxLength: 200, description: "Unique operation key within this workspace. Reuse only for the exact same request; uncertain outcomes must not be blindly retried." } };
const path = { ...string, description: "Absolute path or path relative to the workspace. Home is a starting directory, not a sandbox." };
const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false };
function tool(name: string, description: string, properties: Record<string, object>, required: string[], changes = false): Tool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: changes ? mutating : readonly };
}

export const catalog: Tool[] = [
  tool("workspace_open", "Open a local working directory and return a workspace_id, account, Git state, and instruction paths. Omit cwd for home. This is directory routing, not a sandbox; absolute and parent paths remain usable.", { cwd: string }, [], true),
  { ...tool("workspace_close", "Close this workspace and cancel its active calls. Does not undo changes or stop separately supervised jobs. Repeating close is harmless.", workspace, ["workspace_id"], true), annotations: { ...mutating, idempotentHint: true } },
  tool("read", "Read actual file content using Pi. Returns a file revision for subsequent edit/write preconditions. Use offset/limit for more context.", { ...workspace, path, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["workspace_id", "path"]),
  tool("ls", "List directory contents using Pi.", { ...workspace, path, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["workspace_id"]),
  tool("find", "Find files by glob using Pi. Use a bounded path to avoid scanning unrelated mounts.", { ...workspace, pattern: string, path, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["workspace_id", "pattern"]),
  tool("grep", "Search file content using Pi and return matching lines.", { ...workspace, pattern: string, path, glob: string, ignoreCase: { type: "boolean" }, literal: { type: "boolean" }, context: { type: "integer", minimum: 0, maximum: 20 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, ["workspace_id", "pattern"]),
  tool("write", "Create or replace a file using Pi. expected_revision must be the last read revision, or 'missing' to create a new file. Returns its new revision.", { ...keyed, path, content: { type: "string", maxLength: 2_000_000 }, expected_revision: string }, ["workspace_id", "request_key", "path", "content", "expected_revision"], true),
  tool("edit", "Precisely edit a file using Pi's real edit implementation. All oldText entries match the original file. Read first and provide expected_revision; returns the actual diff.", { ...keyed, path, expected_revision: string, edits: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", properties: { oldText: string, newText: { type: "string" } }, required: ["oldText", "newText"], additionalProperties: false } } }, ["workspace_id", "request_key", "path", "expected_revision", "edits"], true),
  tool("bash", "Run a real command on this workspace's computer using Pi, without another model. Full account access; sudo -n uses existing elevation. cd affects this command only. On timeout, cancellation, or lost connection inspect effects before retrying.", { ...keyed, command: { ...string, maxLength: 200_000 }, timeout: { type: "number", minimum: 1, maximum: 3600 } }, ["workspace_id", "request_key", "command"], true),
];

const ajv = new Ajv({ allErrors: true });
const validators = new Map(catalog.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
export function validate(name: string, args: unknown): asserts args is Record<string, any> {
  const check = validators.get(name);
  if (!check) throw new BridgeError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
  if (!check(args)) throw new BridgeError("INVALID_ARGUMENTS", ajv.errorsText(check.errors));
}
export const receiptTools = new Set(["write", "edit", "bash"]);
