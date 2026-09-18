import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function result(text: string, data: Record<string, unknown> = {}, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

export function failure(error: unknown): CallToolResult {
  const code = error instanceof BridgeError ? error.code : "EXECUTION_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return result(message, { code, message }, true);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
