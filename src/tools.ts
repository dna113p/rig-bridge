import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BridgeError, hash, result } from "./common.ts";
import { atomicReplace, canonicalPath, fileAccess, requireRevision, resolveInput, revision, withPathLock } from "./files.ts";

// Arguments have already passed the MCP catalog's JSON Schema validation.
export async function executeTool(name: string, args: Record<string, any>, cwd: string, stateDirectory: string, signal: AbortSignal): Promise<CallToolResult> {
  const { workspace_id, request_key, expected_revision, ...input } = args;
  if (name === "read") {
    const target = resolveInput(input.path, cwd);
    const info = await stat(target);
    if (!info.isFile()) throw new BridgeError("UNSUPPORTED_FILE", "Use bash to inspect devices and special files");
    if (info.size > 32 * 1024 * 1024) throw new BridgeError("FILE_TOO_LARGE", "Read snapshots are limited to 32 MiB. Use a bounded bash command for larger files.");
    const bytes = await readFile(target, { signal });
    const tool = pi.createReadTool(cwd, { operations: {
      readFile: async () => bytes, access: async () => {}, detectImageMimeType: pi.detectSupportedImageMimeTypeFromFile,
    } });
    const value = await tool.execute(request_key ?? "read", { ...input, path: target }, signal);
    return { ...value, structuredContent: { path: target, revision: `sha256:${hash(bytes)}`, details: value.details ?? null } };
  }
  if (name === "write" || name === "edit") {
    const target = await canonicalPath(resolveInput(input.path, cwd));
    return withPathLock(join(stateDirectory, "file-locks"), target, signal, async () => {
      await requireRevision(target, expected_revision);
      signal.throwIfAborted();
      const operations = {
        readFile, access: fileAccess,
        mkdir: async (path: string) => { await mkdir(path, { recursive: true }); },
        writeFile: async (path: string, content: string) => {
          signal.throwIfAborted();
          if (await canonicalPath(resolveInput(input.path, cwd)) !== target) throw new BridgeError("REVISION_CONFLICT", "File target changed during edit");
          await atomicReplace(path, content, expected_revision);
        },
      };
      const value = name === "write"
        ? await pi.createWriteTool(cwd, { operations }).execute(request_key, { path: target, content: input.content }, signal)
        : await pi.createEditTool(cwd, { operations }).execute(request_key, { path: target, edits: input.edits }, signal);
      return { ...value, structuredContent: { path: target, changed_paths: [target], revision: await revision(target), details: value.details ?? null } };
    });
  }
  if (name === "bash") {
    let exitCode: number | null = null;
    let outputDetails: unknown;
    const operations = pi.createLocalBashOperations();
    const tool = pi.createBashTool(cwd, { exposeSessionEnvironment: false, operations: {
      exec: async (command, directory, options) => {
        const outcome = await operations.exec(command, directory, options);
        exitCode = outcome.exitCode;
        return outcome;
      },
    } });
    const started = Date.now();
    try {
      const value = await tool.execute(request_key, { command: input.command, timeout: input.timeout ?? 120 }, signal,
        partial => { outputDetails = partial.details; });
      return { ...value, structuredContent: { exit_code: exitCode, elapsed_ms: Date.now() - started, details: value.details ?? null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /timed out after/.test(message) ? "COMMAND_TIMEOUT" : /Command aborted/.test(message) ? "COMMAND_CANCELLED" : "COMMAND_FAILED";
      return result(message, { code, exit_code: exitCode, elapsed_ms: Date.now() - started, effects_may_have_occurred: true, details: outputDetails ?? null }, true);
    }
  }
  const factories = { ls: pi.createLsTool, find: pi.createFindTool, grep: pi.createGrepTool };
  if (!(name in factories)) throw new BridgeError("UNKNOWN_TOOL", `Unknown tool: ${name}`);
  // These are three different Pi input schemas, validated before dispatch.
  const tool = factories[name as keyof typeof factories](cwd);
  const value = await tool.execute(name, input as Parameters<typeof tool.execute>[1], signal);
  return { ...value, structuredContent: { ...(input.path ? { path: resolveInput(input.path, cwd) } : {}), details: value.details ?? null } };
}
