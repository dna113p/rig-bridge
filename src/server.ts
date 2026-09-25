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

export interface CommandRecord {
  id: string;
  workspaceId: string;
  tool: string;
  description: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  success?: boolean;
  error?: string;
}

export function summarizeToolCall(tool: string, args: any): string {
  if (!args || typeof args !== "object") return tool;
  switch (tool) {
    case "bash":
      return typeof args.command === "string" ? args.command : "bash";
    case "edit":
    case "read":
    case "write":
      return typeof args.path === "string" ? `${tool} ${args.path}` : tool;
    case "grep":
      return `grep "${args.pattern ?? ""}" ${args.path ?? ""}`.trim();
    case "find":
      return `find "${args.pattern ?? ""}" in ${args.path ?? "."}`.trim();
    case "ls":
      return `ls ${args.path ?? "."}`.trim();
    case "skill_info":
      return typeof args.name === "string" ? `skill_info ${args.name}` : "skill_info";
    case "workspace_open":
      return `workspace_open ${args.cwd ?? "~"}`;
    case "workspace_close":
      return `workspace_close ${args.workspace_id ?? ""}`;
    default:
      return tool;
  }
}

export interface WorkspaceStatusView {
  id: string;
  cwd: string;
  createdAt: number;
  lastUsed: number;
  activeCommands: {
    id: string;
    tool: string;
    description: string;
    startedAt: number;
    elapsedMs: number;
  }[];
  lastCommand?: {
    tool: string;
    description: string;
    completedAt: number;
    durationMs: number;
    success: boolean;
    error?: string;
  };
  recentCommands: {
    id: string;
    tool: string;
    description: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    success: boolean;
    error?: string;
  }[];
}

export interface BridgeStatusView {
  version: string;
  startedAt: number;
  uptimeSeconds: number;
  workspacesCount: number;
  activeCommandsCount: number;
  workspaces: WorkspaceStatusView[];
}

interface Workspace {
  id: string;
  cwd: string;
  createdAt: number;
  active: Map<AbortController, { command: CommandRecord; promise: Promise<CallToolResult> }>;
  recentCommands: CommandRecord[];
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
  private startedAt = Date.now();

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
    this.journal = new Journal(stateDirectory, "owner");
  }

  createServer() {
    const server = new Server({ name: "rig-bridge", version: "0.1.2" }, {
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

      const commandId = randomUUID();
      const startedAt = Date.now();
      const description = summarizeToolCall(name, args);
      const commandRecord: CommandRecord = {
        id: commandId,
        workspaceId: args.workspace_id,
        tool: name,
        description,
        startedAt,
      };

      const pending = Promise.resolve().then(() => {
        combined.throwIfAborted();
        return executeTool(name, args, workspace.cwd, this.stateDirectory, combined);
      }).catch(error => {
        const value = failure(error);
        if (receiptTools.has(name)) value.structuredContent = { ...value.structuredContent, effects_may_have_occurred: true };
        return value;
      }).then(value => ({ ...value, structuredContent: { ...value.structuredContent, workspace_id: args.workspace_id, cwd: workspace.cwd } }));

      workspace.active.set(controller, { command: commandRecord, promise: pending });
      try {
        const res = await pending;
        commandRecord.completedAt = Date.now();
        commandRecord.durationMs = commandRecord.completedAt - startedAt;
        commandRecord.success = !res.isError;
        const first = res.content?.[0];
        if (res.isError && first && "text" in first && typeof first.text === "string") {
          commandRecord.error = first.text.slice(0, 300);
        }
        return res;
      } catch (error) {
        commandRecord.completedAt = Date.now();
        commandRecord.durationMs = commandRecord.completedAt - startedAt;
        commandRecord.success = false;
        commandRecord.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        workspace.active.delete(controller);
        workspace.lastUsed = Date.now();
        workspace.recentCommands.unshift(commandRecord);
        if (workspace.recentCommands.length > 20) workspace.recentCommands.pop();
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
      const now = Date.now();
      this.workspaces.set(id, { id, cwd, createdAt: now, active: new Map(), recentCommands: [], lastUsed: now });
      const sections = [`Workspace ready: ${cwd}.`];
      if (context.project_context) sections.push(context.project_context);
      if (context.skills_prompt) sections.push(context.skills_prompt);
      const text = sections.join("\n\n");
      return result(text, { workspace_id: id, ...context, pi: "0.85.1", models_for_tools: false });
    } finally { this.opening--; }
  }

  closeWorkspace(id: string): Promise<CallToolResult> {
    const workspace = this.workspaces.get(id);
    if (!workspace) return Promise.resolve(result("Workspace is closed.", { workspace_id: id, closed: true }));
    return workspace.closing ??= (async () => {
      for (const controller of workspace.active.keys()) controller.abort();
      await Promise.allSettled([...workspace.active.values()].map(e => e.promise));
      this.workspaces.delete(id);
      return result("Workspace closed. Active calls stopped; existing effects are not undone.", { workspace_id: id, cwd: workspace.cwd, closed: true });
    })();
  }

  abortCommand(workspaceId: string, commandId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return false;
    for (const [controller, entry] of workspace.active.entries()) {
      if (entry.command.id === commandId) {
        controller.abort();
        return true;
      }
    }
    return false;
  }

  getStatus(): BridgeStatusView {
    const now = Date.now();
    let totalActive = 0;
    const workspaces: WorkspaceStatusView[] = [];

    for (const [id, ws] of this.workspaces.entries()) {
      const activeCommands = [...ws.active.values()].map(({ command }) => ({
        id: command.id,
        tool: command.tool,
        description: command.description,
        startedAt: command.startedAt,
        elapsedMs: now - command.startedAt,
      }));
      totalActive += activeCommands.length;

      const recent = ws.recentCommands.map(c => ({
        id: c.id,
        tool: c.tool,
        description: c.description,
        startedAt: c.startedAt,
        completedAt: c.completedAt ?? now,
        durationMs: c.durationMs ?? 0,
        success: c.success ?? false,
        error: c.error,
      }));

      const last = recent[0] ? {
        tool: recent[0].tool,
        description: recent[0].description,
        completedAt: recent[0].completedAt,
        durationMs: recent[0].durationMs,
        success: recent[0].success,
        error: recent[0].error,
      } : undefined;

      workspaces.push({
        id,
        cwd: ws.cwd,
        createdAt: ws.createdAt,
        lastUsed: ws.lastUsed,
        activeCommands,
        lastCommand: last,
        recentCommands: recent,
      });
    }

    workspaces.sort((a, b) => {
      if (a.activeCommands.length !== b.activeCommands.length) {
        return b.activeCommands.length - a.activeCommands.length;
      }
      return b.lastUsed - a.lastUsed;
    });

    return {
      version: "0.1.2",
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      workspacesCount: this.workspaces.size,
      activeCommandsCount: totalActive,
      workspaces,
    };
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
