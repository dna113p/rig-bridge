#!/usr/bin/env node
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";

// Attempt to load .env files if present (Node 20+)
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const envPaths = [
  join(projectDir, ".env"),
  join(homedir(), ".config/rig-bridge/tunnel.env"),
  join(homedir(), ".config/pi-tools-mcp/tunnel.env"),
];
for (const p of envPaths) {
  if (existsSync(p) && typeof process.loadEnvFile === "function") {
    try { process.loadEnvFile(p); } catch {}
  }
}

function defaultStateDir() {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  const preferred = join(base, "rig-bridge");
  const legacy = join(base, "pi-tools-mcp");
  try { if (!existsSync(preferred) && existsSync(legacy)) return legacy; } catch {}
  return preferred;
}

const { values } = parseArgs({
  options: {
    help: { type: "boolean" },
    "tunnel-id": {
      type: "string",
      default: process.env.CONTROL_PLANE_TUNNEL_ID,
    },
    "api-key": {
      type: "string",
      default: process.env.CONTROL_PLANE_API_KEY ?? process.env.OPENAI_API_KEY,
    },
    port: { type: "string", default: process.env.MCP_PORT ?? "8767" },
    "state-dir": {
      type: "string",
      default: defaultStateDir(),
    },
    "token-file": { type: "string" },
    bin: { type: "string", default: process.env.TUNNEL_CLIENT },
  },
});

if (values.help) {
  console.log(`Usage: npm run tunnel -- [options]

Runs the OpenAI tunnel-client bridge to connect ChatGPT to rig-bridge.

Options:
  --tunnel-id ID    OpenAI Tunnel ID (default: ${values["tunnel-id"]})
  --api-key KEY     OpenAI Control Plane API Key (or CONTROL_PLANE_API_KEY env)
  --port PORT       rig-bridge port (default: 8767)
  --state-dir PATH  Directory storing state and http-authorization
  --token-file PATH Path to http-authorization token file
  --bin PATH        Path to tunnel-client binary
`);
  process.exit(0);
}

const stateDir = resolve(values["state-dir"]!);
const tokenFile = resolve(values["token-file"] ?? join(stateDir, "http-authorization"));
const port = Number(values.port);
const tunnelId = values["tunnel-id"];
if (!tunnelId) {
  console.error("\x1b[31mError: CONTROL_PLANE_TUNNEL_ID is required.\x1b[0m\n");
  process.exit(1);
}
const apiKey = values["api-key"];

if (!apiKey) {
  console.error(`\x1b[31mError: CONTROL_PLANE_API_KEY is required.\x1b[0m

Please set your tunnel's Runtime API key using one of these options:
  1. Add to ${join(projectDir, ".env")}:
     CONTROL_PLANE_API_KEY=your_key_here
  2. Export in shell:
     export CONTROL_PLANE_API_KEY=your_key_here
  3. Pass via flag:
     npm run tunnel -- --api-key your_key_here

Get your key from: https://platform.openai.com/settings/organization/tunnels`);
  process.exit(1);
}

// 1. Ensure bearer token file exists
await mkdir(stateDir, { recursive: true, mode: 0o700 });
if (!existsSync(tokenFile)) {
  console.log(`Creating initial bearer credential at ${tokenFile}...`);
  await writeFile(tokenFile, `Bearer ${randomBytes(32).toString("base64url")}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}
await chmod(tokenFile, 0o600);

// 2. Find or install tunnel-client binary
async function findOrDownloadBinary(customPath?: string): Promise<string> {
  if (customPath && existsSync(customPath)) return customPath;

  // Check PATH
  try {
    const which = execSync("which tunnel-client 2>/dev/null", { encoding: "utf8" }).trim();
    if (which && existsSync(which)) return which;
  } catch {}

  // Check ~/.local/bin/tunnel-client
  const userLocalBin = join(homedir(), ".local/bin/tunnel-client");
  if (existsSync(userLocalBin)) return userLocalBin;

  // Check project bin/tunnel-client
  const projectBin = join(projectDir, "bin/tunnel-client");
  if (existsSync(projectBin)) return projectBin;

  // Auto-download to ~/.local/bin or ./bin
  const targetDir = existsSync(join(homedir(), ".local/bin"))
    ? join(homedir(), ".local/bin")
    : join(projectDir, "bin");
  const targetBin = join(targetDir, "tunnel-client");

  console.log(`\x1b[33mtunnel-client not found. Downloading v0.0.14 to ${targetBin}...\x1b[0m`);
  await mkdir(targetDir, { recursive: true });

  const zipUrl = "https://github.com/openai/tunnel-client/releases/download/v0.0.14/tunnel-client-v0.0.14-linux-amd64.zip";
  const tempZip = join(targetDir, "temp-tc.zip");

  execSync(`curl -fsSL "${zipUrl}" -o "${tempZip}" && unzip -q -o "${tempZip}" -d "${targetDir}" && rm -f "${tempZip}"`, {
    stdio: "inherit",
  });
  await chmod(targetBin, 0o755);
  console.log(`Installed tunnel-client to ${targetBin}`);
  return targetBin;
}

const tunnelBinary = await findOrDownloadBinary(values.bin);

// 3. Quick check if rig-bridge is reachable
try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) console.warn(`\x1b[33mWarning: http://127.0.0.1:${port}/healthz returned status ${res.status}\x1b[0m`);
} catch {
  console.warn(`\x1b[33mNotice: rig-bridge is not currently reachable at http://127.0.0.1:${port}/mcp
Make sure to start it with:
  npm run serve
or as a systemd service:
  systemctl --user start rig-bridge.service\x1b[0m\n`);
}

// 4. Launch tunnel-client
console.log(`Starting tunnel-client for ${tunnelId}...`);
console.log(`Target MCP Server: http://127.0.0.1:${port}/mcp`);
console.log(`Token File: ${tokenFile}`);

const child = spawn(
  tunnelBinary,
  [
    "run",
    "--control-plane.tunnel-id",
    tunnelId,
    "--mcp.server-url",
    `http://127.0.0.1:${port}/mcp`,
    "--mcp.extra-headers",
    `Authorization: file:${tokenFile}`,
    "--mcp.discovery-extra-headers",
    `Authorization: file:${tokenFile}`,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CONTROL_PLANE_API_KEY: apiKey,
    },
  }
);

const shutdown = () => {
  child.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
