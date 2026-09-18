# Rig Bridge

A small MCP server for working on your computer from an AI assistant. The assistant holds the conversation and decides what to do. The server calls Pi's actual file and shell tools and returns their results, without starting another model session.

One OS account, one computer, one server process. Workspaces select directories so several projects and conversations can share that process.

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

## Ten tools

| Tool | Purpose |
| --- | --- |
| `workspace_open` | Open a directory; omit `cwd` for home. Returns a workspace ID, account, Git state, inlined project instructions (`AGENTS.md`), and available skill definitions. |
| `workspace_close` | Close the workspace and cancel its active calls. Repeating close is harmless. |
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

`cwd` is fixed for the lifetime of a workspace. Relative paths resolve there; absolute paths, `~/`, and `../` can read or modify other locations. Shell commands have the account's normal access, including existing noninteractive elevation. There is no directory allowlist or filesystem sandbox. A shell `cd` affects that command only. The server never changes its process-wide working directory.

Workspaces are in-memory directory records, with at most 64 open at once. The server reclaims the least recently used idle workspace when a new open request needs room, protecting any workspace with active commands. Workspaces survive HTTP reconnection and transport-session closure. They expire on explicit close, LRU reclamation, or server restart. A workspace ID is a routing handle, not a user or conversation identity. All authenticated clients share the same owner's access. Close unused workspaces; restarting the server clears them all.

HTTP protocol sessions are separate from workspaces. The server keeps at most 64, reclaiming the least recently used idle session when a new connection needs room. Active requests remain protected, including commands whose HTTP caller disconnected; an idle notification stream does not reserve a slot. Clients receiving HTTP 404 for an expired session must initialize again and can continue using their workspace IDs. If all sessions are busy, new connections receive HTTP 503 until a request finishes.

## Editing and retries

Read before editing. `write` and `edit` require the returned `revision` as `expected_revision`, or `"missing"` to create a file. Pi 0.85.1's edit input is `edits: [{oldText, newText}]`, with all replacements matched against the original file.

Every `write`, `edit`, and `bash` requires a `request_key`, unique within its workspace. Retry an interrupted request with **exactly the same arguments and key**. The server returns its cached result, waits for the original call, or returns a durable receipt; it does not dispatch that key again. Reusing a key with different arguments returns `REQUEST_KEY_CONFLICT`. This still works with an expired workspace ID after closure or restart.

After a crash, an unfinished receipt reports `OUTCOME_UNCERTAIN`. Inspect the actual files or processes before deciding what to do next. A failed or cancelled command may already have produced effects. Changing the request key authorizes a new operation; it is not a safe automatic retry.

Receipts store metadata in a private SQLite database: tool, workspace, paths, revision, exit status, and output-file reference where available. They do not store command text, file contents, or conversations. The last 64 mutation results are cached in memory; after eviction/restart only the receipt remains. Keep the state directory to retain retry protection. Receipt metadata is retained until you maintain it locally.

File operations share path locks and use atomic replacement with revision checks. They preserve permission bits and follow symlink targets. Replacement creates a new inode, so ownership, ACLs, extended attributes, and hard-link relationships are not preserved. Arbitrary shell commands and external programs do not participate in these locks. The workspace is not protection against two conversations changing the same files. Use worktrees or coordinate changes when needed.

## Commands and lifecycle

Commands default to a 120-second timeout, with a maximum of 3600 seconds. The client/tunnel may impose a shorter deadline. Shell stdin is closed; interactive prompts cannot be answered through `bash`. Pi bounds output and reports a temporary full-output file when truncated. `read` snapshots regular files up to 32 MiB; use a bounded command for larger files or special devices.

MCP cancellation and workspace closure abort the affected active calls. Graceful server shutdown aborts all active calls. None of these undo completed effects. A forced process kill or deliberately detached job can leave work running. For long jobs, use the OS's existing process supervisor and inspect/stop those jobs explicitly.

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

## Development and verification

```sh
npm run check
npm run test:tunnel  # Optional: requires tunnel-client 0.0.14 with dev proxy
```

Tests use real MCP clients and Pi implementations: project routing, unrestricted paths, image reads, edits/revisions, concurrent HTTP calls, cancellation, close/shutdown, authentication, restart receipts, and uncertain outcomes after a forced server crash. The optional test routes two clients through a real tunnel-client development proxy. It uses disposable local control infrastructure, not a deployed remote assistant connection.

Linux is the tested platform. Windows/macOS runtime behavior and an actual remote assistant round trip still require validation before claiming those environments are supported.
