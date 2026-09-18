import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, delay, fixture, httpClient, open, root, untilFile } from "./helpers.ts";

test("HTTP CLI creates private credentials, preserves them, and shuts down active commands", async t => {
  const f = await fixture(); t.after(f.close);
  async function start() {
    const child = spawn(process.execPath, [join(root, "src/cli.ts"), "serve", "--state-dir", f.state, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.on("data", data => { output += data; });
    child.stdout.on("data", data => { output += data; });
    const exited = new Promise<number | null>(resolve => child.on("exit", resolve));
    t.after(async () => { child.kill("SIGTERM"); await exited; });
    let url: string | undefined;
    for (let i = 0; i < 200; i++) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0];
      if (url) break;
      if (child.exitCode !== null) throw new Error(output);
      await delay(25);
    }
    assert.ok(url, output);
    return { child, url, exited, output: () => output };
  }
  const first = await start();
  const tokenFile = join(f.state, "http-authorization");
  const token = (await readFile(tokenFile, "utf8")).trim();
  assert.match(token, /^Bearer [A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal((await stat(f.state)).mode & 0o777, 0o700);
  assert.equal(first.output().includes(token), false);
  assert.equal((await fetch(first.url.replace("/mcp", "/healthz"))).status, 200);
  const client = await httpClient(first.url, token); t.after(() => client.close());
  const workspace_id = await open(client, f.project);
  const args = { workspace_id, request_key: "shutdown", command: "echo $$ > shutdown.pid; sleep 30" };
  const pending = call(client, "bash", args).catch(() => undefined);
  const pid = Number(await untilFile(join(f.project, "shutdown.pid")));
  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0); await pending;
  assert.throws(() => process.kill(pid, 0));
  const second = await start();
  assert.equal((await readFile(tokenFile, "utf8")).trim(), token);
  const next = await httpClient(second.url, token); t.after(() => next.close());
  const receipt = await call(next, "bash", args);
  assert.equal(receipt.structuredContent.status, "failed");
  assert.equal(receipt.structuredContent.replayed, true);
});

test("optional Linux startup unit validates without installing or starting it", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(); t.after(f.close);
  const unit = execFileSync(process.execPath, [join(root, "scripts/install-service.ts"), "--print"], { encoding: "utf8" });
  const path = join(f.directory, "rig-bridge.service");
  await writeFile(path, unit);
  assert.match(unit, /KillMode=mixed/);
  assert.match(unit, /TimeoutStopSec=12/);
  execFileSync("systemd-analyze", ["--user", "verify", path], { stdio: "pipe" });
});
