import { readFileSync } from "node:fs";

const dashboardScript = readFileSync(new URL("./dashboard.js", import.meta.url), "utf8");

export function renderDashboardHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rig Bridge — Workspace & Command Monitor</title>
  <style>
    :root {
      --bg: #090d16;
      --sidebar-bg: #0b1120;
      --sidebar-header: #0f172a;
      --card-bg: #131c2e;
      --card-hover: #17233a;
      --card-selected: #1a2942;
      --card-border: #1e293b;
      --card-border-active: #38bdf8;
      --card-border-running: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent: #38bdf8;
      --accent-dim: rgba(56, 189, 248, 0.15);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --code-bg: #070c18;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
      overflow: hidden;
    }
    .app-layout {
      display: flex;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }
    /* SIDEBAR */
    .sidebar {
      width: 360px;
      min-width: 320px;
      max-width: 400px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      flex-shrink: 0;
    }
    .sidebar-top {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--card-border);
      background: var(--sidebar-header);
      display: flex;
      flex-direction: column;
      gap: 14px;
      flex-shrink: 0;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 16px;
      color: #fff;
      box-shadow: 0 0 14px rgba(56, 189, 248, 0.35);
      flex-shrink: 0;
    }
    .brand h1 {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.2;
    }
    .brand-meta {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.85); }
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .btn:hover {
      background: #1e293b;
      border-color: #334155;
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: rgba(239, 68, 68, 0.5);
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .stat-card.alert-running {
      border-color: var(--warning);
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.2);
    }
    .stat-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 2px;
    }
    .stat-val {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .stat-val.running-val {
      color: var(--warning);
    }
    .sidebar-section-header {
      padding: 12px 18px 8px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .workspaces-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px 18px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ws-item {
      padding: 12px 14px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 6px;
      position: relative;
    }
    .ws-item:hover {
      background: var(--card-hover);
      border-color: #334155;
    }
    .ws-item.selected {
      background: var(--card-selected);
      border-color: var(--card-border-active);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .ws-item.running {
      border-color: var(--card-border-running);
    }
    .ws-item.running.selected {
      border-color: var(--card-border-running);
      box-shadow: inset 3px 0 0 var(--warning);
    }
    .ws-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .ws-item-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ws-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-dim);
      flex-shrink: 0;
    }
    .ws-dot.running {
      background: var(--warning);
      box-shadow: 0 0 8px var(--warning);
      animation: pulse 1.2s infinite ease-in-out;
    }
    .ws-item-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 11px;
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }
    .ws-item-meta {
      font-size: 11px;
      color: var(--text-dim);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge-running {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.4);
    }
    .badge-idle {
      background: rgba(148, 163, 184, 0.1);
      color: #94a3b8;
      border: 1px solid rgba(148, 163, 184, 0.2);
    }
    .badge-id {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-dim);
      font-family: monospace;
      font-weight: 400;
      text-transform: none;
    }

    /* MAIN CONTENT */
    .main-content {
      flex: 1;
      height: 100vh;
      overflow-y: auto;
      padding: 24px 28px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .main-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .main-title-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .main-ws-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
      word-break: break-all;
    }
    .main-ws-meta {
      font-size: 12px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .running-box {
      background: rgba(245, 158, 11, 0.08);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 10px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.08);
      margin-bottom: 16px;
    }
    .running-box-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--warning);
    }
    .running-command-desc {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: #fef08a;
      background: var(--code-bg);
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid rgba(245, 158, 11, 0.2);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .running-timer {
      font-family: monospace;
      font-weight: 700;
      color: #fbbf24;
    }
    .last-command-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .last-cmd-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .last-cmd-content {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      font-family: monospace;
      font-size: 13px;
      word-break: break-all;
    }
    .status-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .pill-success {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .pill-fail {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .recent-table-wrap {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      overflow: hidden;
    }
    .recent-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-family: monospace;
    }
    .recent-table th {
      text-align: left;
      padding: 10px 14px;
      background: #0f172a;
      color: var(--text-dim);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--card-border);
    }
    .recent-table td {
      padding: 10px 14px;
      border-bottom: 1px solid #1a2538;
      vertical-align: middle;
    }
    .recent-table tr:last-child td {
      border-bottom: none;
    }
    .recent-table tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .empty-state {
      background: var(--card-bg);
      border: 1px dashed var(--card-border);
      border-radius: 12px;
      padding: 50px 24px;
      text-align: center;
      color: var(--text-muted);
      margin: auto 0;
    }
    .empty-icon {
      font-size: 36px;
      margin-bottom: 12px;
    }
    .empty-title {
      font-size: 17px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
    }

    /* RESPONSIVE */
    @media (max-width: 860px) {
      body, html { overflow: auto; }
      .app-layout {
        flex-direction: column;
        height: auto;
        overflow: visible;
      }
      .sidebar {
        width: 100%;
        max-width: 100%;
        height: auto;
        border-right: none;
        border-bottom: 1px solid var(--card-border);
      }
      .main-content {
        height: auto;
        overflow: visible;
        padding: 20px;
      }
    }
    .project-select, .thread-select, .handoff-card { display: block; width: 100%; text-align: left; background: transparent; border: 0; color: var(--text); cursor: pointer; font: inherit; }
    .project-select { padding: 0; }
    .thread-select { padding: 10px 12px; margin-top: 8px; border-left: 2px solid var(--card-border); border-radius: 4px; }
    .thread-select.selected, .thread-select:hover { background: rgba(56,189,248,.08); border-color: var(--accent); }
    .thread-select strong, .thread-select span { display: block; overflow-wrap: anywhere; }
    .thread-select span { font-size: 11px; color: var(--text-muted); margin-top: 5px; }
    .notification-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 24px; }
    .thread-detail { padding: 20px; border: 1px solid var(--card-border); border-radius: 8px; margin-bottom: 24px; }
    .handoff-card { padding: 18px; border: 1px solid var(--card-border); border-radius: 8px; margin-bottom: 12px; }
    .handoff-card.unread { border-left: 3px solid var(--accent); background: rgba(56,189,248,.04); }
    .handoff-card:hover { border-color: var(--accent); }
    .handoff-outcome { color: var(--accent); font-size: 13px; font-weight: 600; margin: 8px 0; }
    .handoff-summary { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.6; }
    .delivery-error { color: #fca5a5; font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
    .main-ws-meta { overflow-wrap: anywhere; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    @media (max-width: 700px) { html, body { overflow: auto; } .app-layout { flex-direction: column; height: auto; min-height: 100vh; overflow: visible; } .sidebar { width: 100%; max-width: none; min-width: 0; height: auto; max-height: 45vh; } .sidebar-top { padding: 16px; } .main-content { padding: 20px; overflow: visible; } .last-cmd-header { flex-wrap: wrap; gap: 8px; } }
  </style>
</head>
<body>
  <div class="app-layout">
    <!-- SIDEBAR -->
    <aside class="sidebar">
      <div class="sidebar-top">
        <div class="brand">
          <div class="brand-icon">⚡</div>
          <div>
            <h1>Rig Bridge Monitor</h1>
            <div class="brand-meta">
              <span class="pulse-dot"></span>
              <span>Port ${port}</span>
              <span>•</span>
              <span id="uptime-label">Uptime: ...</span>
            </div>
          </div>
        </div>

        <div class="controls">
          <button id="toggle-refresh-btn" class="btn" style="flex: 1; justify-content: center;" onclick="toggleAutoRefresh()">Auto-refresh: ON</button>
          <button class="btn" onclick="fetchStatus()">Refresh</button>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Workspaces</div>
            <div id="stat-workspaces" class="stat-val">0</div>
          </div>
          <div id="stat-running-card" class="stat-card">
            <div class="stat-label">Running</div>
            <div id="stat-running" class="stat-val">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Version</div>
            <div id="stat-version" class="stat-val" style="font-size: 15px; padding-top: 3px;">...</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Updated</div>
            <div id="stat-updated" class="stat-val" style="font-size: 12px; color: var(--text-muted); padding-top: 4px;">just now</div>
          </div>
        </div>
      </div>

      <div style="padding: 12px 20px;"><button id="inbox-btn" class="btn" style="width: 100%; justify-content: center;" onclick="showInbox()">Your turn · Inbox (0)</button></div>
      <div class="sidebar-section-header">
        <span>Workspaces</span>
        <span id="ws-count-badge" style="color: var(--accent);">0</span>
      </div>

      <div id="workspaces-list" class="workspaces-scroll">
        <div style="padding: 20px 10px; text-align: center; color: var(--text-dim); font-size: 12px;">
          Loading workspaces...
        </div>
      </div>
    </aside>

    <!-- MAIN CONTENT (Commands & Workspace Details) -->
    <main class="main-content" id="main-content">
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <div class="empty-title">Select a Workspace</div>
        <div>Choose a project workspace to view its threads and handoffs.</div>
      </div>
    </main>
  </div>

  <script>${dashboardScript}</script>
</body>
</html>`;
}
