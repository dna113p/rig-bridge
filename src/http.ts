import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { BridgeError } from "./common.ts";
import { Bridge } from "./server.ts";
import { renderDashboardHtml } from "./ui.ts";

interface Session { transport: StreamableHTTPServerTransport; server: Server; lastUsed: number; active: number }
export async function serveHttp(bridge: Bridge, options: { port: number; tokenFile: string }) {
  if ((await stat(options.tokenFile)).mode & 0o077) throw new BridgeError("INVALID_CONFIG", "HTTP authorization file must be readable only by its owner (chmod 600)");
  const authorization = (await readFile(options.tokenFile, "utf8")).trim();
  if (!/^Bearer [A-Za-z0-9_-]{43,}$/.test(authorization)) throw new BridgeError("INVALID_CONFIG", "HTTP authorization file must contain Bearer followed by at least 32 random bytes encoded as base64url");
  const secret = Buffer.from(authorization);
  const sessions = new Map<string, Session>();
  let stopping = false, port = options.port;
  const reject = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
  };
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.host !== `127.0.0.1:${port}`) { reject(res, 403, "Host rejected"); return; }
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) { reject(res, 403, "Browser origin rejected"); return; }

    if (req.url === "/healthz" && req.method === "GET") { res.writeHead(stopping ? 503 : 200); res.end(stopping ? "stopping" : "live"); return; }

    if ((req.url === "/" || req.url === "/ui") && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderDashboardHtml(port));
      return;
    }

    if (req.url === "/api/status" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(bridge.getStatus()));
      return;
    }

    if (req.url === "/api/abort" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const aborted = bridge.abortCommand(payload.workspace_id, payload.command_id);
        res.writeHead(aborted ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ aborted }));
      } catch {
        reject(res, 400, "Invalid JSON");
      }
      return;
    }

    if (req.url !== "/mcp") { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return; }
    if (req.headers.origin) { reject(res, 403, "Browser origin rejected"); return; }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) { reject(res, 401, "Unauthorized"); return; }
    if (stopping) { reject(res, 503, "Bridge stopping"); return; }
    if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) { reject(res, 405, "Method not allowed"); return; }
    let body: unknown;
    if (req.method === "POST") {
      if (!req.headers["content-type"]?.split(";")[0].includes("application/json")) { reject(res, 415, "Expected application/json"); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8_000_000) { reject(res, 413, "Request too large"); return; }
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { reject(res, 400, "Invalid JSON"); return; }
    }
    const id = req.headers["mcp-session-id"];
    let session = typeof id === "string" ? sessions.get(id) : undefined;
    let initializing = false;
    if (!session && !id && req.method === "POST" && isInitializeRequest(body)) {
      // Some callers initialize for each tool call and never send DELETE.
      if (sessions.size >= 64) {
        const idle = [...sessions.entries()].filter(([, value]) => !value.active)
          .sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0];
        if (!idle) { reject(res, 503, "All MCP sessions are busy; retry after an active request completes"); return; }
        sessions.delete(idle[0]);
        void idle[1].server.close();
      }
      const sessionId = randomUUID();
      const server = bridge.createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId, enableJsonResponse: true });
      session = { transport, server, lastUsed: Date.now(), active: 0 };
      server.onclose = () => { sessions.delete(sessionId); };
      // Reserve before yielding so simultaneous initializations respect the limit.
      sessions.set(sessionId, session);
      initializing = true;
    }
    if (!session) { reject(res, id ? 404 : 400, id ? "MCP session expired; initialize again. Workspace handles remain valid while this service runs." : "Initialize an MCP session first"); return; }
    const current = session;
    // A listening GET is idle. A JSON POST remains active until its handler
    // finishes, even if the caller drops the socket while a command is running.
    const active = req.method !== "GET";
    current.lastUsed = Date.now();
    if (active) current.active++;
    try {
      if (initializing) await current.server.connect(current.transport);
      await current.transport.handleRequest(req, res, body);
    } finally {
      if (active) current.active--;
      current.lastUsed = Date.now();
      if (initializing && !current.transport.sessionId) await current.server.close();
    }
  };
  const http = createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) reject(res, 500, "HTTP MCP request failed"); else res.destroy();
  }); });
  http.requestTimeout = 30_000; // Bounds receipt of the request body, not tool execution.
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", () => resolve()); });
  port = (http.address() as { port: number }).port;
  const reap = setInterval(() => {
    for (const session of sessions.values()) {
      if (!session.active && Date.now() - session.lastUsed > 3_600_000) void session.server.close();
    }
  }, 30_000);
  reap.unref();
  return { url: `http://127.0.0.1:${port}/mcp`, close: async () => {
    if (stopping) return;
    stopping = true; clearInterval(reap);
    const closed = new Promise<void>(resolve => http.close(() => resolve()));
    await Promise.allSettled([...sessions.values()].map(session => session.server.close()));
    http.closeAllConnections(); await closed;
  } };
}
