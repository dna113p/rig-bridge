#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { start: { type: "boolean" }, print: { type: "boolean" } } });
if (values.start && values.print) throw new Error("Choose --start or --print");
if (process.platform !== "linux") throw new Error("This optional installer requires Linux user systemd. Run npm run serve directly on other platforms.");
const home = homedir();
const directory = join(home, ".config/systemd/user");
const path = join(directory, "rig-bridge.service");
const marker = "# Managed by rig-bridge\n";
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
const entry = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const state = join(process.env.XDG_STATE_HOME ?? join(home, ".local/state"), "rig-bridge");
const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
const unit = `${marker}[Unit]
Description=Rig Bridge over MCP
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=${quote(`PATH=${searchPath}`)}
ExecStart=${quote(process.execPath)} ${quote(entry)} serve --state-dir ${quote(state)}
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=12
UMask=0077

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
if (values.start) run("systemctl", ["--user", "enable", "--now", "rig-bridge.service"]);
console.log(`Installed ${path}\nStart: systemctl --user enable --now rig-bridge.service\nStatus: systemctl --user status rig-bridge.service\nStop: systemctl --user stop rig-bridge.service`);
}
