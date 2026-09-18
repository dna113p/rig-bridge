import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { catalog, receiptTools, validate } from "./catalog.ts";
import { BridgeError, canonical, failure, result, withOutput } from "./common.ts";
import { orientation } from "./context.ts";
import { resolveInput } from "./files.ts";
import { Journal } from "./journal.ts";
import { executeTool } from "./tools.ts";

interface Workspace {
  cwd: string;
  active: Map<AbortController, Promise<CallToolResult>>;
  closing?: Promise<CallToolResult>;
  lastUsed: number;
}

/** One owner, one computer. Workspaces are directory records, not agent sessions. */
export class Bridge {
  private workspaces = new Map<string, Workspace>();
  private journal: Journal;
  private pending = new Set<Promise<CallToolResult>>();
  private opening = 0;
  private shutdown?: Promise<void>;
  private stopping = false;
  private stateDirectory: string;

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
    this.journal = new Journal(stateDirectory, "owner");
  }

  createServer() {
    const server = new Server({ name: "pi-tools-mcp", version: "0.1.2" }, {
      capabilities: { tools: {} },
      instructions: "Keep reasoning and context in the calling assistant. Open a workspace for each project, omitting cwd for the account home. Save its workspace_id and read returned instruction/skill files before working. All seven execution tools use Pi directly without an agent/model session. Workspaces only select a working directory: absolute paths and ../ are allowed for reads, writes, and commands under normal account permissions. Multiple conversations can use separate workspaces concurrently; files are shared. read returns the revision required by write/edit; use 'missing' when creating a file. Every write/edit/bash needs a request_key unique within its workspace. Reuse it only with identical arguments to retrieve a previous result or durable receipt, even after restart/closure. Never blindly rerun an uncertain operation with a new key. Close unused workspaces to cancel their active calls. HTTP reconnection preserves workspace handles, but a server restart requires opening new ones. Shell stdin is closed; cd affects only that command. Authentication and elevation use existing local mechanisms.",
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: catalog }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.call(request.params.name, request.params.arguments ?? {}, extra.signal));
    return server;
  }

  call(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    const pending = this.dispatch(name, args, signal).catch(failure).then(withOutput);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
    return pending;
  }

  private async dispatch(name: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    validate(name, args);
    if (this.stopping) throw new BridgeError("BRIDGE_STOPPED", "Server is stopping");
    signal?.throwIfAborted();
    if (name === "workspace_open") return this.open(args.cwd, signal);
    if (name === "workspace_close") return this.closeWorkspace(args.workspace_id);
    const operation = async () => {
      const workspace = this.workspaces.get(args.workspace_id);
      if (!workspace || workspace.closing) return failure(new BridgeError("WORKSPACE_EXPIRED", "Open a workspace and use its new workspace_id"));
      workspace.lastUsed = Date.now();
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const pending = Promise.resolve().then(() => {
        combined.throwIfAborted();
        return executeTool(name, args, workspace.cwd, this.stateDirectory, combined);
      }).catch(error => {
        const value = failure(error);
        if (receiptTools.has(name)) value.structuredContent = { ...value.structuredContent, effects_may_have_occurred: true };
        return value;
      }).then(value => ({ ...value, structuredContent: { ...value.structuredContent, workspace_id: args.workspace_id, cwd: workspace.cwd } }));
      workspace.active.set(controller, pending);
      try { return await pending; } finally {
        workspace.active.delete(controller);
        workspace.lastUsed = Date.now();
      }
    };
    // Consult receipts before workspace lookup so retries survive closed/expired handles.
    return receiptTools.has(name)
      ? this.journal.execute(canonical([args.workspace_id, args.request_key]), { tool: name, ...args }, operation)
      : operation();
  }

  private async open(input?: string, signal?: AbortSignal): Promise<CallToolResult> {
    signal?.throwIfAborted();
    this.opening++;
    try {
      const cwd = await realpath(resolveInput(input ?? homedir(), homedir()));
      if (!(await stat(cwd)).isDirectory()) throw new BridgeError("INVALID_WORKSPACE", "cwd must be a directory");
      while (this.workspaces.size + this.opening > 64) {
        const idle = [...this.workspaces.entries()]
          .filter(([, ws]) => !ws.active.size && !ws.closing)
          .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new BridgeError("WORKSPACE_LIMIT", "Close unused workspaces; at most 64 can be open");
        await this.closeWorkspace(idle[0]);
        signal?.throwIfAborted();
      }
      const context = await orientation(cwd);
      signal?.throwIfAborted();
      if (this.stopping) throw new BridgeError("BRIDGE_STOPPED", "Server is stopping");
      const id = randomUUID();
      this.workspaces.set(id, { cwd, active: new Map(), lastUsed: Date.now() });
      return result(`Workspace ready: ${cwd}. Read the applicable instruction files.`, { workspace_id: id, ...context, pi: "0.85.1", models_for_tools: false });
    } finally { this.opening--; }
  }

  private closeWorkspace(id: string): Promise<CallToolResult> {
    const workspace = this.workspaces.get(id);
    if (!workspace) return Promise.resolve(result("Workspace is closed.", { workspace_id: id, closed: true }));
    return workspace.closing ??= (async () => {
      for (const controller of workspace.active.keys()) controller.abort();
      await Promise.allSettled(workspace.active.values());
      this.workspaces.delete(id);
      return result("Workspace closed. Active calls stopped; existing effects are not undone.", { workspace_id: id, cwd: workspace.cwd, closed: true });
    })();
  }

  close(): Promise<void> {
    return this.shutdown ??= (async () => {
      this.stopping = true;
      await Promise.all([...this.workspaces.keys()].map(id => this.closeWorkspace(id)));
      await Promise.allSettled(this.pending);
      this.journal.close();
    })();
  }
}
