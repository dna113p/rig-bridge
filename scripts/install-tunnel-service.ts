#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { start: { type: "boolean" }, print: { type: "boolean" } } });
if (values.start && values.print) throw new Error("Choose --start or --print");
if (process.platform !== "linux") throw new Error("This optional installer requires Linux user systemd.");

const home = homedir();
const directory = join(home, ".config/systemd/user");
const path = join(directory, "rig-bridge-tunnel.service");
const marker = "# Managed by rig-bridge\n";
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
const entry = fileURLToPath(new URL("./run-tunnel.ts", import.meta.url));
const projectDir = fileURLToPath(new URL("..", import.meta.url));
const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

const unit = `${marker}[Unit]
Description=OpenAI MCP Tunnel for Rig Bridge
After=network-online.target rig-bridge.service
Wants=rig-bridge.service

[Service]
Type=simple
WorkingDirectory=%h
Environment=${quote(`PATH=${searchPath}`)}
EnvironmentFile=-${join(home, ".config/rig-bridge/tunnel.env")}
EnvironmentFile=-${join(home, ".config/pi-tools-mcp/tunnel.env")}
EnvironmentFile=-${join(projectDir, ".env")}
ExecStart=${quote(process.execPath)} ${quote(entry)}
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=12

[Install]
WantedBy=default.target
`;

if (values.print) {
  process.stdout.write(unit);
} else {
  await mkdir(directory, { recursive: true });
  try {
    if (!(await readFile(path, "utf8")).startsWith(marker)) throw new Error(`Refusing to overwrite an unrelated unit: ${path}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(path, unit, { mode: 0o600 });
  await chmod(path, 0o600);
  const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "inherit" });
  run("systemd-analyze", ["--user", "verify", path]);
  run("systemctl", ["--user", "daemon-reload"]);
  if (values.start) run("systemctl", ["--user", "enable", "--now", "rig-bridge-tunnel.service"]);
  console.log(`Installed ${path}\nStart:  systemctl --user enable --now rig-bridge-tunnel.service\nStatus: systemctl --user status rig-bridge-tunnel.service\nStop:   systemctl --user stop rig-bridge-tunnel.service`);
}
