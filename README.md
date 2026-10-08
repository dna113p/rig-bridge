# Rig Bridge

A small MCP server for working on your computer from an AI assistant. The assistant holds the conversation and decides what to do. The server calls Pi's actual file and shell tools and returns their results, without starting another model session.

One OS account, one computer, one server process. Persistent workspaces group projects and their conversation threads. Temporary execution handles select directories so several threads can share that process.

## Install and run

Requires Node.js 24+, npm, Git, and a working bash installation. Install the checkout's pinned dependencies:

```sh
git clone https://github.com/dna113p/rig-bridge.git
cd rig-bridge
npm ci --ignore-scripts
npm run check
npm run serve
```

Pi is installed as a dependency. A separate Pi CLI installation or model API key is unnecessary for the server's own tool execution.

HTTP listens at `http://127.0.0.1:8767/mcp`. On first start, it generates an owner-only bearer file at `~/.local/state/rig-bridge/http-authorization` (or under `XDG_STATE_HOME`). The credential is never printed. The file contains the complete value to send in the `Authorization` header, including `Bearer`.

Connect your MCP client or authenticated tunnel/proxy to that HTTP endpoint and supply the header. The proxy must preserve the local target's `Host` and omit browser `Origin`. A remote assistant needs a connection that can reach this local endpoint. Tunnel provisioning is separate from this package.

Optional flags:

```sh
npm run serve -- --port 9000 --state-dir /absolute/private/state
npm run serve -- --token-file /absolute/existing/bearer-file
```

An explicitly supplied bearer file must already exist, have owner-only permissions, and contain `Bearer ` followed by at least 43 base64url characters. Keep it outside the checkout.

For a client that launches a local stdio MCP server, use the **absolute Node executable and `src/cli.ts` paths** in its configuration:

```json
{
  "mcpServers": {
    "rig-bridge": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/rig-bridge/src/cli.ts"]
    }
  }
}
```

Stdio uses the local client's process access. Use HTTP when multiple clients should share one server. This checkout runs TypeScript directly under Node 24; global npm installation is not an advertised installation path.

## Live Status & Workspace Viewer

When using Rig Bridge with remote assistants like ChatGPT web, it can be difficult to see which workspace the assistant is operating in or whether a command is actively running.

Rig Bridge includes both a real-time web dashboard and a terminal monitor.

### Web Dashboard

Open in your browser:
- **`http://127.0.0.1:8767/`** (or `http://127.0.0.1:8767/ui`)

Features:
- **Project Workspaces & Threads**: Groups repeated opens, repository subdirectories, and Git worktrees under one project. Named threads retain their checkout and run history across restarts.
- **Your Turn Inbox**: Shows explicit assistant handoffs, outcome summaries, and unread badges. Opening a handoff selects its thread and marks it read.
- **Notifications**: Per-project desktop alerts and browser alerts with click-to-open thread navigation.
- **Running Commands**: Shows commands actively executing with a live ticking timer.
- **Last Command & Recent Activity**: Shows tool name, command or target path, duration, relative time, and success/error status.
- **Abort Action**: Stop hanging or runaway commands directly from the dashboard.
- **Live Updates**: Automatically refreshes every second with connection health monitoring.

### CLI Monitor

Inspect status from your shell:

```sh
npm run status
```

Options:
- `npm run status -- --watch` : Live updating terminal monitor.
- `npm run status -- --json`  : Dump raw JSON status.
- `npm run status -- --port 8767` : Connect to a non-standard port.

## Thirteen tools

| Tool | Purpose |
| --- | --- |
| `workspace_open` | Open a checkout in a persistent project workspace. Returns an execution handle (`workspace_id`), `project_id`, `thread_id`, account, Git state, project instructions, and skills. Give a new thread a `title`; supply `thread_id` to resume. |
| `workspace_list` | List saved projects, threads, runs, and live execution handles. |
| `run_start` | Start and name a stretch of work, including a follow-up that needs no execution tools. |
| `work_handoff` | Report that the assistant is about to return control to the user, with an outcome and summary. Records a durable notification without closing the thread. |
| `workspace_close` | Close an execution handle and cancel its active calls. The saved project and thread remain. Repeating close is harmless. |
| `read` | Read text or supported images through Pi. Returns a file revision. |
| `ls` | List directory contents. |
| `find` | Find files by glob. |
| `grep` | Search file contents. |
| `write` | Create or replace a file. |
| `edit` | Apply Pi's targeted text replacements and return its diff. |
| `bash` | Run a command and return output, exit status, and truncation details. |
| `skill_info` | Inspect available Pi skills or get the full instructions and metadata for a specific skill. |

Text results are available in both MCP `content` and `structuredContent.output`, alongside structured metadata such as revisions and exit codes. Clients consuming only structured results can read file contents, search matches, command output, and error messages from `output`. Pi's truncation notices and output-file references are preserved. Images remain native MCP image blocks in `content`; their base64 data is not duplicated into structured results.

When an assistant opens a workspace via `workspace_open`, the bridge automatically discovers and inlines relevant project context (`AGENTS.md`, `CLAUDE.md`, etc.) and formats an `<available_skills>` catalog into the initial response. Assistants can query `skill_info` with a skill's name to view its complete prompt instructions, parameters, and frontmatter. Opening a workspace does not automatically execute project instructions or run arbitrary extensions.

`cwd` is fixed for the lifetime of a thread's execution handle. Relative paths resolve there; absolute paths, `~/`, and `../` can read or modify other locations. Shell commands have the account's normal access, including existing noninteractive elevation. There is no directory allowlist or filesystem sandbox. A shell `cd` affects that command only. The server never changes its process-wide working directory.

Project workspaces, threads, runs, notification preferences, and handoff summaries persist in the private `work.sqlite` database under the state directory. Conversation transcripts and tool output are not stored there. Opening a repository or its subdirectories finds the same project; Git worktrees share the common Git directory identity. Independent clones stay separate unless `project_id` explicitly groups them. For non-Git projects, pass `project_root` to group directories under a chosen root. Project grouping does not isolate files or create worktrees.

Each new `workspace_open` creates a separate thread and temporary execution handle, even for the same directory. Passing a saved `thread_id` resumes that thread at its fixed checkout path; an existing live handle is reused only for that explicit resume. `title` names or renames the thread. `workspace_list` finds saved threads after restart. Do not give two independent conversations the same thread ID.

The compatibility parameter `workspace_id` is an execution handle, not the persistent project ID. At most 64 handles can be open. The server reclaims the least recently used idle handle when a new open needs room, protecting active tool calls. Handles survive HTTP reconnection and transport-session closure, but expire on explicit close, LRU reclamation, or restart. Cancellation and mutation retry scopes remain independent between threads. Closing a handle preserves the project/thread history and marks unfinished work interrupted; it does not report a successful handoff. All authenticated clients share the same owner's access.

HTTP protocol sessions are separate from workspaces. The server keeps at most 64, reclaiming the least recently used idle session when a new connection needs room. Active requests remain protected, including commands whose HTTP caller disconnected; an idle notification stream does not reserve a slot. Clients receiving HTTP 404 for an expired session must initialize again and can continue using their workspace IDs. If all sessions are busy, new connections receive HTTP 503 until a request finishes.

## Agent handoffs and notifications

The bridge's MCP instructions, `workspace_open` response, and `work_handoff` description tell the assistant to call `work_handoff` **immediately before a final reply that returns control to the user**. This is an explicit report that the assistant is about to hand back the conversation; it does not confirm that the final chat message appeared. Empty command queues and inactivity never imply completion.

Example tool arguments:

```json
{
  "workspace_id": "<execution handle from workspace_open>",
  "request_key": "handoff-unique-for-this-line-of-work",
  "reason": "completed",
  "summary": "Implemented project grouping and notifications. Checks passed."
}
```

Supported reasons are `completed`, `needs_input`, `blocked`, `failed`, and `cancelled`. Wait for this thread's active calls before handing off. Other threads can continue working. A run starts automatically on the first execution tool; use `run_start` to give it a title or start a follow-up that requires no file/shell tools. A handoff finishes that run and keeps the thread available. Optional `run_id` verifies that the handoff belongs to the current run.

Retry a control request with the identical arguments and `request_key`: the saved response is returned without another handoff or notification, even after the old handle closes or the service restarts. A new key cannot hand off an already finished run; start new work first. Retries of old mutation results do not start a new run. Unfinished runs show interrupted status after restart.

The dashboard inbox always records handoffs, including while it is closed. Browser alerts are enabled per project and browser using **Browser alerts**; grant the browser's notification permission when prompted. Clicking a browser alert opens its thread. Browser alerts require an open dashboard tab; preferences and delivered event IDs are retained locally to avoid repeats on refresh or reload. Enabling browser alerts starts with future handoffs; existing events remain in the inbox.

**Desktop alerts** are enabled per project and saved by the bridge. On Linux, the bridge sends through the desktop session's notification service using `busctl`, with `notify-send` as a fallback. These alerts work with the dashboard closed and include the thread's dashboard URL. The bridge must run in a user session with access to the notification service. Delivery errors stay visible in the inbox. Events interrupted during desktop delivery are marked unknown and are not automatically resent, avoiding duplicates. Desktop delivery on Windows/macOS is not implemented.

Assistant compliance is required: the bridge cannot infer a conversation handoff when the calling assistant omits the MCP signal. It also cannot observe detached jobs that were launched outside its tracked tool calls.

## Editing and retries

Read before editing. `write` and `edit` require the returned `revision` as `expected_revision`, or `"missing"` to create a file. Pi 0.85.1's edit input is `edits: [{oldText, newText}]`, with all replacements matched against the original file.

Every `write`, `edit`, and `bash` requires a `request_key`, unique within its execution handle. The control tools `run_start` and `work_handoff` also require unique keys. Retry an interrupted request with **exactly the same arguments and key**. The server returns its cached result, waits for the original call, or returns a durable receipt; it does not dispatch that key again. Reusing a key with different arguments returns `REQUEST_KEY_CONFLICT`. This still works with an expired workspace ID after closure or restart.

After a crash, an unfinished receipt reports `OUTCOME_UNCERTAIN`. Inspect the actual files or processes before deciding what to do next. A failed or cancelled command may already have produced effects. Changing the request key authorizes a new operation; it is not a safe automatic retry.

Receipts store metadata in a private SQLite database: tool, workspace, paths, revision, exit status, and output-file reference where available. They do not store command text, file contents, or conversations. The last 64 mutation results are cached in memory; after eviction/restart only the receipt remains. Keep the state directory to retain retry protection. Receipt metadata is retained until you maintain it locally.

File operations share path locks and use atomic replacement with revision checks. They preserve permission bits and follow symlink targets. Replacement creates a new inode, so ownership, ACLs, extended attributes, and hard-link relationships are not preserved. Arbitrary shell commands and external programs do not participate in these locks. The workspace is not protection against two conversations changing the same files. Use worktrees or coordinate changes when needed.

## Commands and lifecycle

Commands default to a 120-second timeout, with a maximum of 3600 seconds. The client/tunnel may impose a shorter deadline. Shell stdin is closed; interactive prompts cannot be answered through `bash`. Pi bounds output and reports a temporary full-output file when truncated. `read` snapshots regular files up to 32 MiB; use a bounded command for larger files or special devices.

MCP cancellation and execution-handle closure abort the affected active calls. Graceful server shutdown aborts all active calls. None of these undo completed effects. A forced process kill or deliberately detached job can leave work running. For long jobs, use the OS's existing process supervisor and inspect/stop those jobs explicitly.

File locks live under the state directory. A forced crash during a write can leave a stale lock; inspect it and verify no writer remains before removing it. Locks never expire automatically while a writer may still be active.

## Optional Linux startup service

```sh
npm run install:service -- --start
systemctl --user status rig-bridge.service
journalctl --user -u rig-bridge.service -n 50
systemctl --user stop rig-bridge.service
```

Without `--start`, the installer writes and validates the unit without enabling or starting it. `--print` prints the unit without installing it. It captures this checkout's absolute path, Node executable, and current PATH; rerun after moving the checkout or changing Node. The installer does not configure a tunnel or enable user lingering. Boot/login behavior follows the user's existing systemd configuration. Other platforms can launch the Node command with their preferred supervisor.

## ChatGPT / OpenAI Secure MCP Tunnel

To connect ChatGPT to your local MCP tools using OpenAI's Secure MCP Tunnel (e.g. `tunnel_your_id_here`):

1. Set your tunnel runtime key (from OpenAI Platform > Tunnels) in `.env` or your shell:
   ```sh
   cp .env.example .env
   # Edit .env and set CONTROL_PLANE_API_KEY=...
   ```
2. Run the tunnel (auto-downloads `tunnel-client` if not found):
   ```sh
   npm run tunnel
   ```
   Or specify options:
   ```sh
   npm run tunnel -- --tunnel-id tunnel_your_id_here --api-key <key>
   ```
3. To run as a background service alongside `rig-bridge.service` in Linux / WSL systemd:
   ```sh
   npm run install:tunnel-service -- --start
   systemctl --user status rig-bridge-tunnel.service
   ```

### Network roaming and auto-recovery

When switching between Wi-Fi networks, tethering to a mobile hotspot, or resuming after system sleep, long-polling tunnel sockets can hang on stale network routes.

`npm run tunnel` and `rig-bridge-tunnel.service` include an automatic supervisor by default:
- **Route Monitoring**: Tracks default IP route and gateway changes (`ip route show default`). If a network switch occurs and internet is reachable, the tunnel is automatically restarted with fresh sockets.
- **Stall Detection**: Monitors health metrics on `127.0.0.1:8081/metrics`. If a long-poll request stalls (>65s without a successful poll) while internet is up, it triggers a clean restart.
- Pass `--no-watchdog` to disable the supervisor if desired.
- For external or existing tunnel services (e.g. `pi-mcp-bridge-tunnel.service`), a standalone watchdog script is provided at `scripts/tunnel-watchdog.sh`.

## Development and verification

```sh
npm run check
npm run test:tunnel  # Optional: requires tunnel-client 0.0.14 with dev proxy
```

Tests use real MCP clients and Pi implementations: project routing, unrestricted paths, image reads, edits/revisions, concurrent HTTP calls, cancellation, close/shutdown, authentication, restart receipts, and uncertain outcomes after a forced server crash. The optional test routes two clients through a real tunnel-client development proxy. It uses disposable local control infrastructure, not a deployed remote assistant connection.

Linux is the tested platform. Windows/macOS runtime behavior and an actual remote assistant round trip still require validation before claiming those environments are supported.
