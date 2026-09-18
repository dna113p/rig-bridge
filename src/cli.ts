#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: "boolean" }, port: { type: "string", default: "8767" },
  "state-dir": { type: "string", default: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-tools-mcp") },
  "token-file": { type: "string" },
} });
if (values.help) {
  console.log("Usage: npm start -- [serve] [--port 8767] [--state-dir PATH] [--token-file PATH]\nDefault: MCP stdio. serve: authenticated loopback HTTP.\nHTTP creates an owner-only bearer file in the state directory when missing.\nRequires Node 24+. Workspaces use normal account permissions.");
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
      console.error(`pi-tools-mcp listening at ${http.url}\nAuthorization file: ${tokenFile}`);
    } else {
      server!.onclose = () => { void shutdown(); };
      process.stdin.on("end", () => { void shutdown(); });
      await server!.connect(new StdioServerTransport());
    }
  } catch (error) { await shutdown(); throw error; }
}
