# Pi Tools MCP

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

HTTP listens at `http://127.0.0.1:8767/mcp`. On first start, it generates an owner-only bearer file at `~/.local/state/pi-tools-mcp/http-authorization` (or under `XDG_STATE_HOME`). The credential is never printed. The file contains the complete value to send in the `Authorization` header, including `Bearer`.

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
    "pi-tools": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/pi-tools-mcp/src/cli.ts"]
    }
  }
}
```

Stdio uses the local client's process access. Use HTTP when multiple clients should share one server. This checkout runs TypeScript directly under Node 24; global npm installation is not an advertised installation path.

## Nine tools

| Tool | Purpose |
| --- | --- |
| `workspace_open` | Open a directory; omit `cwd` for home. Returns a workspace ID, account, Git state, and instruction/skill paths. |
| `workspace_close` | Close the workspace and cancel its active calls. Repeating close is harmless. |
| `read` | Read text or supported images through Pi. Returns a file revision. |
| `ls` | List directory contents. |
| `find` | Find files by glob. |
| `grep` | Search file contents. |
| `write` | Create or replace a file. |
| `edit` | Apply Pi's targeted text replacements and return its diff. |
| `bash` | Run a command and return output, exit status, and truncation details. |

Text results are available in both MCP `content` and `structuredContent.output`, alongside structured metadata such as revisions and exit codes. Clients consuming only structured results can read file contents, search matches, command output, and error messages from `output`. Pi's truncation notices and output-file references are preserved. Images remain native MCP image blocks in `content`; their base64 data is not duplicated into structured results.

Try: “Open my home directory, read the applicable instructions, and show me my projects.” Then open a project's directory and retain its `workspace_id` for subsequent calls. Context paths are references for the assistant to read; opening a workspace does not execute project instructions or load installed Pi extensions.

`cwd` is fixed for the lifetime of a workspace. Relative paths resolve there; absolute paths, `~/`, and `../` can read or modify other locations. Shell commands have the account's normal access, including existing noninteractive elevation. There is no directory allowlist or filesystem sandbox. A shell `cd` affects that command only. The server never changes its process-wide working directory.

Workspaces are in-memory directory records, with at most 64 open at once. They survive HTTP reconnection and transport-session closure. They expire on explicit close or server restart. A workspace ID is a routing handle, not a user or conversation identity. All authenticated clients share the same owner's access. Close unused workspaces; restarting the server clears them all.

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
systemctl --user status pi-tools-mcp.service
journalctl --user -u pi-tools-mcp.service -n 50
systemctl --user stop pi-tools-mcp.service
```

Without `--start`, the installer writes and validates the unit without enabling or starting it. `--print` prints the unit without installing it. It captures this checkout's absolute path, Node executable, and current PATH; rerun after moving the checkout or changing Node. The installer does not configure a tunnel or enable user lingering. Boot/login behavior follows the user's existing systemd configuration. Other platforms can launch the Node command with their preferred supervisor.

## Development and verification

```sh
npm run check
npm run test:tunnel  # Optional: requires tunnel-client 0.0.14 with dev proxy
```

Tests use real MCP clients and Pi implementations: project routing, unrestricted paths, image reads, edits/revisions, concurrent HTTP calls, cancellation, close/shutdown, authentication, restart receipts, and uncertain outcomes after a forced server crash. The optional test routes two clients through a real tunnel-client development proxy. It uses disposable local control infrastructure, not a deployed remote assistant connection.

Linux is the tested platform. Windows/macOS runtime behavior and an actual remote assistant round trip still require validation before claiming those environments are supported.
