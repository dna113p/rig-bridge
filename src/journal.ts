import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BridgeError, canonical, hash, result } from "./common.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface Row { fingerprint: string; status: string; receipt: string | null; updated: string }

/** Records intent before dispatch. An unfinished receipt is uncertain, never retried. */
export class Journal {
  private db: DatabaseSync;
  private active = new Map<string, Promise<CallToolResult>>();
  private completed = new Map<string, CallToolResult>();
  private principal: string;
  constructor(directory: string, principal: string) {
    this.principal = principal;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "receipts.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT, updated TEXT NOT NULL)");
  }
  private id(key: string) { return hash(canonical([this.principal, key])); }
  inspect(key: string) {
    const row = this.db.prepare("SELECT fingerprint,status,receipt,updated FROM receipts WHERE id=?").get(this.id(key)) as Row | undefined;
    if (!row) throw new BridgeError("RECEIPT_NOT_FOUND", "No receipt for this request key");
    return { status: row.status === "started" ? this.active.has(this.id(key)) ? "running" : "uncertain" : row.status, updated: row.updated, ...(row.receipt ? JSON.parse(row.receipt) : {}) };
  }
  async execute(key: string, input: unknown, operation: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const id = this.id(key), fingerprint = hash(canonical(input));
    // Atomic claim also prevents duplicate dispatch across independent MCP processes.
    const claimed = this.db.prepare("INSERT OR IGNORE INTO receipts VALUES (?,?,'started',NULL,?)")
      .run(id, fingerprint, new Date().toISOString()).changes !== 0;
    const previous = this.db.prepare("SELECT fingerprint,status,receipt,updated FROM receipts WHERE id=?").get(id) as Row | undefined;
    if (!claimed && previous) {
      if (previous.fingerprint !== fingerprint) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key was already used with different input");
      const active = this.active.get(id);
      if (active) return active;
      const cached = this.completed.get(id);
      if (cached) return { ...cached, structuredContent: { ...cached.structuredContent, replayed: true } };
      const receipt = this.inspect(key);
      return result("This request was already dispatched. It has not been executed again; inspect the receipt and its references.",
        { ...receipt, replayed: true, code: receipt.status === "uncertain" ? "OUTCOME_UNCERTAIN" : "RECORDED_OUTCOME" }, receipt.status !== "completed");
    }
    const promise = Promise.resolve().then(operation).then(outcome => {
      const data = outcome.structuredContent ?? {};
      const receipt = {
        tool: (input as Record<string, unknown>).tool,
        workspace_id: (input as Record<string, unknown>).workspace_id,
        paths: data.changed_paths,
        revision: data.revision,
        cwd: data.cwd,
        code: data.code,
        exit_code: data.exit_code,
        effects_may_have_occurred: data.effects_may_have_occurred,
        full_output_path: (data.details as { fullOutputPath?: string } | undefined)?.fullOutputPath,
      };
      const uncertain = data.code === "OUTCOME_UNCERTAIN";
      this.db.prepare("UPDATE receipts SET status=?,receipt=?,updated=? WHERE id=?")
        .run(uncertain ? "uncertain" : outcome.isError ? "failed" : "completed", JSON.stringify(receipt), new Date().toISOString(), id);
      this.completed.set(id, outcome);
      if (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
      return outcome;
    }).finally(() => this.active.delete(id));
    this.active.set(id, promise);
    return promise;
  }
  close() { this.db.close(); }
}
