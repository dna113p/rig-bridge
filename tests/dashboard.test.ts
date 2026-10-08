import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { fixture, http, httpClient, call, delay } from "./helpers.ts";

test("dashboard renders grouped threads safely, opens handoffs, and deduplicates browser alerts across reloads", async t => {
  const f = await fixture(); t.after(f.close);
  const server = await http(f.state); t.after(server.close);
  const client = await httpClient(server.url, server.authorization); t.after(() => client.close());
  const a = (await call(client, "workspace_open", { cwd: f.project, title: '<img src=x onerror="attack()">' })).structuredContent;
  const b = (await call(client, "workspace_open", { cwd: f.project, title: "Second conversation" })).structuredContent;
  await call(client, "work_handoff", { workspace_id: a.workspace_id, request_key: "done", reason: "completed", summary: '<script>attack()</script> & ready' });
  const root = server.url.replace("/mcp", "/");
  const html = await (await fetch(root)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const storage = new Map<string, string>();
  storage.set("rig-bridge-browser-projects", JSON.stringify([a.project_id]));
  const alerts: { title: string; onclick?: () => void }[] = [];
  const errors: unknown[] = [];
  function dashboard() {
    const elements = new Map<string, { textContent: string; innerHTML: string; classList: { toggle(): void } }>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", classList: { toggle() {} } });
      return elements.get(id)!;
    };
    class Notification {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      title: string;
      onclick?: () => void;
      constructor(title: string) { this.title = title; alerts.push(this); }
      close() {}
    }
    const location = { hash: "#thread=" + a.thread_id };
    const context = createContext({
      document: { getElementById: element }, window: { Notification, addEventListener() {}, focus() {} },
      Notification, location, history: { replaceState(_state: unknown, _title: string, hash: string) { location.hash = hash; } },
      navigator: { locks: { request: async (_key: string, fn: () => void) => fn() } },
      localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
      fetch: (url: string, options?: RequestInit) => fetch(new URL(url, root), options),
      setInterval() { return 1; }, clearInterval() {}, console: { error: (...args: unknown[]) => errors.push(args) },
      alert: (message: string) => errors.push(message), confirm: () => true
    });
    runInContext(script, context);
    return { context, element, location };
  }
  const first = dashboard();
  for (let i = 0; i < 100 && !first.element("main-content").innerHTML; i++) await delay(10);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(first.element("stat-workspaces").textContent, 1);
  assert.equal(first.element("inbox-btn").textContent, "Your turn · Inbox (1)");
  assert.match(first.element("workspaces-list").innerHTML, /2 threads/);
  assert.match(first.element("workspaces-list").innerHTML, /Second conversation/);
  assert.match(first.element("main-content").innerHTML, /Your turn · completed/);
  assert.match(first.element("main-content").innerHTML, /&lt;script&gt;attack\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(first.element("main-content").innerHTML, /<script>attack/);
  for (let i = 0; i < 100 && alerts.length !== 1; i++) await delay(10);
  assert.equal(alerts.length, 1);
  const second = dashboard();
  for (let i = 0; i < 100 && !second.element("main-content").innerHTML; i++) await delay(10);
  assert.equal(alerts.length, 1);
  runInContext("showInbox()", first.context);
  assert.match(first.element("main-content").innerHTML, /Your turn · Inbox/);
  const data = await (await fetch(root + "api/status")).json();
  await runInContext("openHandoff(" + JSON.stringify(data.notifications[0].id) + ")", first.context);
  assert.equal(first.element("inbox-btn").textContent, "Your turn · Inbox (0)");
  assert.equal(first.location.hash, "#thread=" + a.thread_id);
  // Clicking another saved thread changes the selected checkout rather than merging handles.
  runInContext("selectThread(" + JSON.stringify(b.thread_id) + ")", first.context);
  assert.match(first.element("main-content").innerHTML, /Second conversation/);
  assert.equal(errors.length, 0, JSON.stringify(errors));
});
