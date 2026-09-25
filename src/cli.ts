#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { existsSync } from "node:fs";

function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const preferred = join(base, "rig-bridge");
  const legacy = join(base, "pi-tools-mcp");
  try { if (!existsSync(preferred) && existsSync(legacy)) return legacy; } catch {}
  return preferred;
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: "boolean" }, port: { type: "string", default: process.env.MCP_PORT ?? "8767" },
  "state-dir": { type: "string", default: defaultStateDir() },
  "token-file": { type: "string" },
  watch: { type: "boolean" },
  json: { type: "boolean" },
} });

if (values.help) {
  console.log(`Usage:
  npm run serve -- [--port 8767] [--state-dir PATH] [--token-file PATH]
  npm run status -- [--port 8767] [--watch] [--json]
  npm start -- [options] (default: MCP stdio)

Commands:
  serve   Run authenticated HTTP bridge and dashboard viewer (default port: 8767)
  status  Display active workspaces, running commands, and recent activity
`);
} else if (positionals[0] === "status") {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");

  const formatTimeAgo = (ts?: number) => {
    if (!ts) return "never";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ago`;
  };

  const formatDuration = (ms?: number) => {
    if (!ms && ms !== 0) return "";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as import("./server.ts").BridgeStatusView;
    } catch {
      return null;
    }
  };

  const render = (data: import("./server.ts").BridgeStatusView | null) => {
    if (!data) {
      console.log(`\x1b[31m● Rig Bridge is not responding at http://127.0.0.1:${port}\x1b[0m`);
      console.log(`Start the server with: npm run serve or systemctl --user start rig-bridge.service\n`);
      return;
    }
    if (values.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const runningHighlight = data.activeCommandsCount > 0 ? "\x1b[1;33m" : "\x1b[1;32m";
    console.log(`\x1b[1m⚡ Rig Bridge v${data.version}\x1b[0m • Uptime: ${Math.floor(data.uptimeSeconds / 60)}m ${data.uptimeSeconds % 60}s • ${runningHighlight}${data.activeCommandsCount} Running Command(s)\x1b[0m • ${data.workspacesCount} Workspace(s)`);
    console.log(`\x1b[90mWeb Dashboard: http://127.0.0.1:${port}/\x1b[0m\n`);

    if (data.workspaces.length === 0) {
      console.log(`\x1b[90mNo active workspaces. When an assistant calls workspace_open, it will appear here.\x1b[0m\n`);
      return;
    }

    for (const ws of data.workspaces) {
      const isRunning = ws.activeCommands.length > 0;
      const dot = isRunning ? "\x1b[1;33m●\x1b[0m" : "\x1b[90m○\x1b[0m";
      const statusText = isRunning ? "\x1b[1;33mRUNNING\x1b[0m" : "\x1b[90mIDLE\x1b[0m";
      console.log(`${dot} \x1b[1;36m${ws.cwd}\x1b[0m \x1b[90m[${ws.id.slice(0, 8)}]\x1b[0m - ${statusText} (last active ${formatTimeAgo(ws.lastUsed)})`);

      if (isRunning) {
        for (const cmd of ws.activeCommands) {
          const sec = (cmd.elapsedMs / 1000).toFixed(1);
          console.log(`    \x1b[1;33m▶ [${cmd.tool}]\x1b[0m ${cmd.description} \x1b[33m(running for ${sec}s)\x1b[0m`);
        }
      }

      if (ws.lastCommand) {
        const mark = ws.lastCommand.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
        const dur = formatDuration(ws.lastCommand.durationMs);
        const when = formatTimeAgo(ws.lastCommand.completedAt);
        console.log(`    Last: ${mark} \x1b[90m[${ws.lastCommand.tool}]\x1b[0m ${ws.lastCommand.description} \x1b[90m(${when}, took ${dur})\x1b[0m`);
        if (ws.lastCommand.error) {
          console.log(`          \x1b[31mError: ${ws.lastCommand.error}\x1b[0m`);
        }
      }
      console.log("");
    }
  };

  if (values.watch) {
    process.stdout.write("\x1b[2J\x1b[H");
    render(await fetchStatus());
    const interval = setInterval(async () => {
      process.stdout.write("\x1b[2J\x1b[H");
      render(await fetchStatus());
    }, 1000);
    process.on("SIGINT", () => {
      clearInterval(interval);
      process.exit(0);
    });
  } else {
    render(await fetchStatus());
  }
} else {
  if (positionals.length > 1 || (positionals.length && positionals[0] !== "serve")) throw new Error("Use --help for usage");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const stateDirectory = resolve(values["state-dir"]!);
  const httpMode = positionals[0] === "serve";
  const tokenFile = resolve(values["token-file"] ?? join(stateDirectory, "http-authorization"));
  if (httpMode) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    // An explicitly supplied token file must already exist.
    if (!values["token-file"]) {
      try { await writeFile(tokenFile, `Bearer ${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }
  const { Bridge } = await import("./server.ts");
  const bridge = new Bridge(stateDirectory);
  const server = httpMode ? undefined : bridge.createServer();
  let http: Awaited<ReturnType<typeof import("./http.ts").serveHttp>> | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 8000);
    try {
      await bridge.close();
      await http?.close();
      await server?.close();
    } finally { clearTimeout(timer); }
  };
  process.on("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
  process.on("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
  try {
    if (httpMode) {
      http = await (await import("./http.ts")).serveHttp(bridge, { port, tokenFile });
      console.error(`rig-bridge listening at ${http.url}\nAuthorization file: ${tokenFile}`);
    } else {
      server!.onclose = () => { void shutdown(); };
      process.stdin.on("end", () => { void shutdown(); });
      await server!.connect(new StdioServerTransport());
    }
  } catch (error) { await shutdown(); throw error; }
}
