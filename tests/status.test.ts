import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, http, httpClient, open, call } from "./helpers.ts";

test("HTTP status and dashboard endpoints expose active workspaces, running commands, and recent activity", async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);

  // 1. Test GET / and GET /ui HTML dashboard
  const baseUrl = server.url.replace("/mcp", "");
  const resUi = await fetch(`${baseUrl}/ui`);
  assert.equal(resUi.status, 200);
  assert.match(await resUi.text(), /Rig Bridge Monitor/);

  const resRoot = await fetch(`${baseUrl}/`);
  assert.equal(resRoot.status, 200);
  assert.match(await resRoot.text(), /Rig Bridge Monitor/);

  // 2. Test GET /api/status when empty
  const resStatus = await fetch(`${baseUrl}/api/status`);
  assert.equal(resStatus.status, 200);
  const initialStatus = await resStatus.json();
  assert.equal(initialStatus.workspacesCount, 0);
  assert.equal(initialStatus.activeCommandsCount, 0);
  assert.equal(initialStatus.workspaces.length, 0);

  // 3. Open a workspace and verify status tracks it
  const client = await httpClient(server.url, server.authorization);
  t.after(() => client.close());
  const workspace_id = await open(client, f.project);

  const statusAfterOpen = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusAfterOpen.workspacesCount, 1);
  assert.equal(statusAfterOpen.workspaces[0].cwd, f.project);
  assert.equal(statusAfterOpen.workspaces[0].id, workspace_id);
  assert.equal(statusAfterOpen.workspaces[0].activeCommands.length, 0);

  // 4. Run a command and verify active command tracking
  const commandPromise = call(client, "bash", {
    workspace_id,
    request_key: "long-task",
    command: "sleep 0.5; echo done",
  });

  // Brief delay to let the command start
  await new Promise(r => setTimeout(r, 100));

  const statusWhileRunning = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusWhileRunning.activeCommandsCount, 1);
  assert.equal(statusWhileRunning.workspaces[0].activeCommands.length, 1);
  assert.equal(statusWhileRunning.workspaces[0].activeCommands[0].tool, "bash");
  assert.match(statusWhileRunning.workspaces[0].activeCommands[0].description, /sleep 0.5/);

  await commandPromise;

  // 5. Verify completed command in lastCommand and recentCommands
  const statusAfterDone = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusAfterDone.activeCommandsCount, 0);
  assert.ok(statusAfterDone.workspaces[0].lastCommand);
  assert.equal(statusAfterDone.workspaces[0].lastCommand.tool, "bash");
  assert.equal(statusAfterDone.workspaces[0].lastCommand.success, true);
  assert.equal(statusAfterDone.workspaces[0].recentCommands.length, 1);

  // 6. Test aborting a running command via /api/abort
  const abortController = new AbortController();
  const hangingPromise = call(client, "bash", {
    workspace_id,
    request_key: "to-abort",
    command: "sleep 10",
  }).catch(() => undefined);

  await new Promise(r => setTimeout(r, 100));
  const statusToAbort = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusToAbort.activeCommandsCount, 1);
  const cmdId = statusToAbort.workspaces[0].activeCommands[0].id;

  const abortRes = await fetch(`${baseUrl}/api/abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_id, command_id: cmdId }),
  });
  assert.equal(abortRes.status, 200);
  const abortJson = await abortRes.json();
  assert.equal(abortJson.aborted, true);

  await hangingPromise;

  const statusAfterAbort = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(statusAfterAbort.activeCommandsCount, 0);
  assert.equal(statusAfterAbort.workspaces[0].lastCommand.tool, "bash");
  assert.equal(statusAfterAbort.workspaces[0].lastCommand.success, false);
});
