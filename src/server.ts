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
import { WorkStore, discoverProject } from "./work.ts";
import { notifyDesktop, type DesktopNotification } from "./notifications.ts";

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
  projectId: string;
  threadId: string;
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
  projects: ReturnType<WorkStore["list"]>;
  projectsCount: number;
  notifications: ReturnType<WorkStore["inbox"]>;
  unreadCount: number;
}

interface Workspace {
  id: string;
  projectId: string;
  threadId: string;
  cwd: string;
  createdAt: number;
  active: Map<AbortController, { command: CommandRecord; promise: Promise<CallToolResult> }>;
  recentCommands: CommandRecord[];
  closing?: Promise<CallToolResult>;
  lastUsed: number;
}

/** Persistent project workspaces contain threads; legacy workspace IDs are execution handles. */
export class Bridge {
  private workspaces = new Map<string, Workspace>();
  private queuedByHandle = new Map<string, number>();
  private journal: Journal;
  private work: WorkStore;
  private desktopNotify: (notification: DesktopNotification) => Promise<void>;
  private delivery?: Promise<void>;
  private dashboardUrl = "http://127.0.0.1:8767/";
  private pending = new Set<Promise<CallToolResult>>();
  private opening = 0;
  private shutdown?: Promise<void>;
  private stopping = false;
  private stateDirectory: string;
  private startedAt = Date.now();

  constructor(stateDirectory: string, options: { notifyDesktop?: (notification: DesktopNotification) => Promise<void> } = {}) {
    this.stateDirectory = stateDirectory;
    this.journal = new Journal(stateDirectory, "owner");
    this.work = new WorkStore(stateDirectory);
    this.desktopNotify = options.notifyDesktop ?? notifyDesktop;
  }

  createServer() {
    const server = new Server({ name: "rig-bridge", version: "0.1.2" }, {
      capabilities: { tools: {} },
      instructions: "Keep reasoning and conversation in the calling assistant. workspace_open opens a checkout in a persistent project workspace and returns workspace_id (temporary execution handle), project_id and thread_id. Save these and read returned project instructions/skills. Give each conversation its own named thread using title; resume with thread_id, including after restart. workspace_list finds saved threads. Git worktrees group into the same project; files may still be shared. REQUIRED: immediately before each final reply returning control to the user, call work_handoff with workspace_id, a fresh request_key, reason (completed, needs_input, blocked, failed or cancelled), and a short summary. Wait for this thread's tool calls to finish. This signals an imminent handoff, not confirmation of a displayed final reply. Keep the thread open for follow-up. A new run starts on the next execution call, or use run_start to name it. All execution tools use Pi directly without another model session. Absolute paths and ../ are allowed under normal account permissions; checkout directories are not sandboxes. read returns the revision required by write/edit; use 'missing' when creating a file. Every write/edit/bash/run_start/work_handoff needs a request_key unique within its workspace handle; retry only with identical arguments and key. Never blindly rerun uncertain operations with a new key. workspace_close cancels only that handle's active calls and preserves its saved thread. HTTP reconnection preserves handles; restart requires opening new handles. Shell stdin is closed; cd affects only that command. Authentication and elevation use existing local mechanisms.",
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
    if (name === "workspace_open") return this.open(args, signal);
    if (name === "workspace_list") return result("Saved project workspaces and threads.", { projects: this.work.list(), handles: this.getStatus().workspaces });
    if (name === "workspace_close") return this.closeWorkspace(args.workspace_id);
    if (name === "run_start" || name === "work_handoff") {
      const { workspace_id, request_key, ...input } = args;
      const replay = this.work.replay(workspace_id, request_key, { tool: name, ...input });
      if (replay) return result("Previously recorded; no duplicate notification was sent.", replay);
      try {
        this.journal.inspect(canonical([workspace_id, request_key]));
        throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key was already used by an execution tool");
      } catch (error) { if (!(error instanceof BridgeError) || error.code !== "RECEIPT_NOT_FOUND") throw error; }
      const workspace = this.workspaces.get(workspace_id);
      if (!workspace || workspace.closing) throw new BridgeError("WORKSPACE_EXPIRED", "Open a workspace and use its new workspace_id");
      if (workspace.active.size || this.queuedByHandle.get(workspace_id)) throw new BridgeError("WORK_ACTIVE", "Wait for this thread's active tool calls before starting or handing off a run");
      const data = name === "run_start" ? this.work.start(workspace_id, request_key, input) : this.work.handoff(workspace_id, request_key, input as any);
      workspace.lastUsed = Date.now();
      if (name === "work_handoff") this.deliverNotifications();
      return result(name === "run_start" ? "Run started." : "Handoff recorded. Return control to the user now; keep this thread for follow-up.", data);
    }
    if (receiptTools.has(name) && this.work.hasControlRequest(args.workspace_id, args.request_key)) throw new BridgeError("REQUEST_KEY_CONFLICT", "Request key was already used by a run or handoff tool");
    const operation = async () => {
      const workspace = this.workspaces.get(args.workspace_id);
      if (!workspace || workspace.closing) return failure(new BridgeError("WORKSPACE_EXPIRED", "Open a workspace and use its new workspace_id"));
      workspace.lastUsed = Date.now();
      const run = this.work.activity(workspace.threadId);
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
      }).then(value => ({ ...value, structuredContent: { ...value.structuredContent, workspace_id: args.workspace_id, project_id: workspace.projectId, thread_id: workspace.threadId, run_id: run.id, cwd: workspace.cwd } }));

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
    // Receipt dispatch is deferred to a microtask. Protect that queued call as well as running calls.
    const handleId = args.workspace_id;
    this.queuedByHandle.set(handleId, (this.queuedByHandle.get(handleId) ?? 0) + 1);
    const execution = receiptTools.has(name)
      ? this.journal.execute(canonical([args.workspace_id, args.request_key]), { tool: name, ...args }, operation)
      : operation();
    return execution.finally(() => {
      const count = (this.queuedByHandle.get(handleId) ?? 1) - 1;
      if (count) this.queuedByHandle.set(handleId, count); else this.queuedByHandle.delete(handleId);
    });
  }

  private async open(args: Record<string, any>, signal?: AbortSignal): Promise<CallToolResult> {
    signal?.throwIfAborted();
    this.opening++;
    try {
      const savedThread = args.thread_id ? this.work.thread(args.thread_id) : undefined;
      const closing = savedThread ? [...this.workspaces.values()].find(ws => ws.threadId === savedThread.id && ws.closing) : undefined;
      if (closing) await closing.closing;
      signal?.throwIfAborted();
      const cwd = await realpath(resolveInput(args.cwd ?? savedThread?.cwd ?? homedir(), homedir()));
      if (!(await stat(cwd)).isDirectory()) throw new BridgeError("INVALID_WORKSPACE", "cwd must be a directory");
      const identity = await discoverProject(cwd, args.project_root ? resolveInput(args.project_root, cwd) : undefined);
      const project = this.work.openProject(identity, args.project_id ?? savedThread?.projectId);
      if (savedThread && (savedThread.cwd !== cwd || savedThread.projectId !== project.id)) throw new BridgeError("THREAD_CONFLICT", "A resumed thread must use its saved project and cwd");
      // Resuming intentionally reuses this thread's live handle, never another conversation's handle.
      const existing = savedThread ? [...this.workspaces.values()].find(ws => ws.threadId === savedThread.id && !ws.closing) : undefined;
      let context: Awaited<ReturnType<typeof orientation>> | undefined;
      if (existing) {
        context = await orientation(cwd);
        signal?.throwIfAborted();
        if (this.stopping) throw new BridgeError("BRIDGE_STOPPED", "Server is stopping");
        if (this.workspaces.get(existing.id) === existing && !existing.closing) {
          this.work.openThread(project, cwd, args.title, savedThread!.id);
          existing.lastUsed = Date.now();
          return this.openResult(existing, context);
        }
      }
      while (this.workspaces.size + this.opening > 64) {
        const idle = [...this.workspaces.entries()]
          .filter(([, ws]) => !ws.active.size && !ws.closing && !this.queuedByHandle.get(ws.id))
          .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new BridgeError("WORKSPACE_LIMIT", "Close unused workspaces; at most 64 can be open");
        await this.closeWorkspace(idle[0]);
        signal?.throwIfAborted();
      }
      context ??= await orientation(cwd);
      signal?.throwIfAborted();
      if (this.stopping) throw new BridgeError("BRIDGE_STOPPED", "Server is stopping");
      const id = randomUUID();
      const now = Date.now();
      // Recheck after asynchronous context discovery: simultaneous resumes must share one handle.
      const resumed = savedThread ? [...this.workspaces.values()].find(ws => ws.threadId === savedThread.id && !ws.closing) : undefined;
      if (resumed) {
        this.work.openThread(project, cwd, args.title, savedThread!.id);
        resumed.lastUsed = now;
        return this.openResult(resumed, context);
      }
      const closingAfterContext = savedThread ? [...this.workspaces.values()].find(ws => ws.threadId === savedThread.id && ws.closing) : undefined;
      if (closingAfterContext) await closingAfterContext.closing;
      signal?.throwIfAborted();
      if (this.stopping) throw new BridgeError("BRIDGE_STOPPED", "Server is stopping");
      const reopened = savedThread ? [...this.workspaces.values()].find(ws => ws.threadId === savedThread.id && !ws.closing) : undefined;
      if (reopened) {
        this.work.openThread(project, cwd, args.title, savedThread!.id);
        reopened.lastUsed = Date.now();
        return this.openResult(reopened, context);
      }
      const thread = this.work.openThread(project, cwd, args.title, savedThread?.id);
      const workspace: Workspace = { id, projectId: project.id, threadId: thread.id, cwd, createdAt: now, active: new Map(), recentCommands: [], lastUsed: now };
      this.work.attach(id, thread.id);
      this.workspaces.set(id, workspace);
      return this.openResult(workspace, context);
    } finally { this.opening--; }
  }

  private openResult(workspace: Workspace, context: Awaited<ReturnType<typeof orientation>>) {
    const project = this.work.project(workspace.projectId), thread = this.work.thread(workspace.threadId);
    const sections = [`Workspace ready: ${project.name}. Thread: ${thread.title}. Checkout: ${workspace.cwd}.`,
      "Before your final reply returning control to the user, call work_handoff with this workspace_id, a fresh request_key, reason and summary. Keep the thread open for follow-up. For later work with no execution tools, start a new run with run_start before handing off again."];
    if (context.project_context) sections.push(context.project_context);
    if (context.skills_prompt) sections.push(context.skills_prompt);
    return result(sections.join("\n\n"), { workspace_id: workspace.id, project_id: project.id, thread_id: thread.id, project, thread, ...context, pi: "0.85.1", models_for_tools: false });
  }

  setDashboardUrl(url: string) { this.dashboardUrl = url; this.deliverNotifications(); }

  acknowledgeHandoff(id: string) { this.work.acknowledge(id); }
  setProjectPreferences(id: string, desktopNotifications: boolean) { this.work.preferences(id, desktopNotifications); }

  private deliverNotifications() {
    if (this.delivery || this.stopping) return;
    this.delivery = (async () => {
      for (let event = this.work.claimDelivery(); event; event = this.work.claimDelivery()) {
        const project = this.work.project(event.projectId), thread = this.work.thread(event.threadId);
        try {
          await this.desktopNotify({ title: `${project.name} · Your turn`, body: `${thread.title}: ${event.summary}`, url: `${this.dashboardUrl}#thread=${event.threadId}` });
          this.work.delivered(event.id);
        } catch (error) { this.work.delivered(event.id, error instanceof Error ? error.message : String(error)); }
      }
    })().finally(() => {
      this.delivery = undefined;
      if (!this.stopping && this.work.hasPendingDelivery()) this.deliverNotifications();
    });
  }

  closeWorkspace(id: string): Promise<CallToolResult> {
    const workspace = this.workspaces.get(id);
    if (!workspace) return Promise.resolve(result("Workspace is closed.", { workspace_id: id, closed: true }));
    return workspace.closing ??= (async () => {
      for (const controller of workspace.active.keys()) controller.abort();
      await Promise.allSettled([...workspace.active.values()].map(e => e.promise));
      this.work.interrupt(workspace.threadId);
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
        projectId: ws.projectId,
        threadId: ws.threadId,
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

    const projects = this.work.list(), notifications = this.work.inbox();
    return {
      version: "0.1.2",
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      workspacesCount: this.workspaces.size,
      activeCommandsCount: totalActive,
      workspaces,
      projects,
      projectsCount: projects.length,
      notifications,
      unreadCount: notifications.filter(n => !n.readAt).length,
    };
  }

  close(): Promise<void> {
    return this.shutdown ??= (async () => {
      this.stopping = true;
      await Promise.all([...this.workspaces.keys()].map(id => this.closeWorkspace(id)));
      await Promise.allSettled(this.pending);
      await this.delivery;
      this.work.close();
      this.journal.close();
    })();
  }
}
