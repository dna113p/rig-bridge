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
      --card-bg: #131c2e;
      --card-border: #1e293b;
      --card-border-active: #3b82f6;
      --card-border-running: #f59e0b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --accent: #38bdf8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --code-bg: #0b1120;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 20px;
      line-height: 1.5;
    }
    .container {
      max-width: 1040px;
      margin: 0 auto;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: linear-gradient(135deg, #0284c7, #38bdf8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 18px;
      color: #fff;
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.3);
    }
    .brand h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand-meta {
      font-size: 13px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
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
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px;
    }
    .stat-card.alert-running {
      border-color: var(--warning);
      box-shadow: 0 0 16px rgba(245, 158, 11, 0.15);
    }
    .stat-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }
    .stat-val {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.03em;
    }
    .stat-val.running-val {
      color: var(--warning);
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 14px;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .workspaces-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .workspace-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      transition: border-color 0.2s;
    }
    .workspace-card.running {
      border-color: var(--card-border-running);
      box-shadow: 0 0 20px rgba(245, 158, 11, 0.1);
    }
    .ws-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 12px;
    }
    .ws-path-wrapper {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 260px;
    }
    .ws-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--text-dim);
      flex-shrink: 0;
    }
    .ws-dot.running {
      background: var(--warning);
      box-shadow: 0 0 8px var(--warning);
      animation: pulse 1.2s infinite ease-in-out;
    }
    .ws-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 15px;
      font-weight: 600;
      color: var(--accent);
      word-break: break-all;
    }
    .ws-badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 6px;
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
    .ws-meta {
      font-size: 12px;
      color: var(--text-dim);
      margin-bottom: 14px;
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .running-box {
      background: rgba(245, 158, 11, 0.08);
      border: 1px solid rgba(245, 158, 11, 0.3);
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .running-box-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: var(--warning);
    }
    .running-command-desc {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      color: #fef08a;
      background: var(--code-bg);
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(245, 158, 11, 0.2);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .running-timer {
      font-family: monospace;
      font-weight: 700;
    }
    .last-command {
      background: var(--code-bg);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .last-cmd-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .last-cmd-content {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 220px;
      font-family: monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .status-pill {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .pill-success {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
    }
    .pill-fail {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
    }
    .details-toggle {
      background: transparent;
      border: none;
      color: var(--accent);
      font-size: 12px;
      cursor: pointer;
      margin-top: 10px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .details-toggle:hover {
      text-decoration: underline;
    }
    .recent-list {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-family: monospace;
      font-size: 12px;
    }
    .recent-item {
      padding: 6px 10px;
      background: var(--code-bg);
      border-radius: 6px;
      border: 1px solid #1e293b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .empty-state {
      background: var(--card-bg);
      border: 1px dashed var(--card-border);
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted);
    }
    .empty-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }
    .empty-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">⚡</div>
        <div>
          <h1>Rig Bridge Monitor</h1>
          <div class="brand-meta">
            <span class="pulse-dot"></span>
            <span>Live on port ${port}</span>
            <span>•</span>
            <span id="uptime-label">Uptime: ...</span>
          </div>
        </div>
      </div>
      <div class="controls">
        <button id="toggle-refresh-btn" class="btn" onclick="toggleAutoRefresh()">Auto-refresh: ON</button>
        <button class="btn" onclick="fetchStatus()">Refresh Now</button>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Active Workspaces</div>
        <div id="stat-workspaces" class="stat-val">0</div>
      </div>
      <div id="stat-running-card" class="stat-card">
        <div class="stat-label">Running Commands</div>
        <div id="stat-running" class="stat-val">0</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Server Version</div>
        <div id="stat-version" class="stat-val" style="font-size: 20px; padding-top: 4px;">...</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Last Updated</div>
        <div id="stat-updated" class="stat-val" style="font-size: 16px; color: var(--text-muted); padding-top: 6px;">just now</div>
      </div>
    </div>

    <div class="section-title">
      <span>Workspaces & Activity</span>
    </div>

    <div id="workspaces-container" class="workspaces-list">
      <div class="empty-state">
        <div class="empty-icon">⏳</div>
        <div class="empty-title">Loading status...</div>
      </div>
    </div>
  </div>

  <script>
    let autoRefresh = true;
    let refreshTimer = null;
    let expandedWorkspaces = new Set();

    function formatTimeAgo(ts) {
      if (!ts) return "never";
      const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (seconds < 5) return "just now";
      if (seconds < 60) return seconds + "s ago";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + "m ago";
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + "h " + (minutes % 60) + "m ago";
      return Math.floor(hours / 24) + "d ago";
    }

    function formatDuration(ms) {
      if (!ms && ms !== 0) return "";
      if (ms < 1000) return ms + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }

    function formatUptime(seconds) {
      if (!seconds) return "0s";
      const m = Math.floor(seconds / 60);
      const h = Math.floor(m / 60);
      const d = Math.floor(h / 24);
      if (d > 0) return d + "d " + (h % 24) + "h";
      if (h > 0) return h + "h " + (m % 60) + "m";
      if (m > 0) return m + "m " + (seconds % 60) + "s";
      return seconds + "s";
    }

    function escapeHtml(str) {
      if (!str) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    async function abortCommand(workspaceId, commandId) {
      if (!confirm("Are you sure you want to abort this running command?")) return;
      try {
        const res = await fetch("/api/abort", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: workspaceId, command_id: commandId })
        });
        if (res.ok) {
          fetchStatus();
        } else {
          alert("Failed to abort command.");
        }
      } catch (err) {
        alert("Error sending abort request: " + err.message);
      }
    }

    function toggleDetails(wsId) {
      if (expandedWorkspaces.has(wsId)) {
        expandedWorkspaces.delete(wsId);
      } else {
        expandedWorkspaces.add(wsId);
      }
      renderWorkspaces(currentStatus);
    }

    let currentStatus = null;

    async function fetchStatus() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        currentStatus = data;
        render(data);
      } catch (err) {
        document.getElementById("stat-updated").textContent = "offline";
        console.error("Failed to fetch bridge status:", err);
      }
    }

    function render(data) {
      document.getElementById("uptime-label").textContent = "Uptime: " + formatUptime(data.uptimeSeconds);
      document.getElementById("stat-workspaces").textContent = data.workspacesCount;
      document.getElementById("stat-running").textContent = data.activeCommandsCount;
      document.getElementById("stat-version").textContent = "v" + data.version;
      document.getElementById("stat-updated").textContent = new Date().toLocaleTimeString();

      const runningCard = document.getElementById("stat-running-card");
      if (data.activeCommandsCount > 0) {
        runningCard.classList.add("alert-running");
        document.getElementById("stat-running").classList.add("running-val");
      } else {
        runningCard.classList.remove("alert-running");
        document.getElementById("stat-running").classList.remove("running-val");
      }

      renderWorkspaces(data);
    }

    function renderWorkspaces(data) {
      const container = document.getElementById("workspaces-container");
      if (!data || !data.workspaces || data.workspaces.length === 0) {
        container.innerHTML = \`
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div class="empty-title">No Active Workspaces</div>
            <div>When ChatGPT or another assistant calls <code>workspace_open</code>, its directory and active commands will be tracked here live.</div>
          </div>\`;
        return;
      }

      container.innerHTML = data.workspaces.map(ws => {
        const isRunning = ws.activeCommands && ws.activeCommands.length > 0;
        const isExpanded = expandedWorkspaces.has(ws.id);

        let runningHtml = "";
        if (isRunning) {
          runningHtml = ws.activeCommands.map(cmd => {
            const elapsedSec = (cmd.elapsedMs / 1000).toFixed(1);
            return \`
              <div class="running-box">
                <div class="running-box-header">
                  <span>⚡ EXECUTING: \${escapeHtml(cmd.tool)}</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="running-timer">running for \${elapsedSec}s</span>
                    <button class="btn btn-danger" style="padding: 2px 8px; font-size: 11px;" onclick="abortCommand('\${ws.id}', '\${cmd.id}')">Abort</button>
                  </div>
                </div>
                <div class="running-command-desc">\${escapeHtml(cmd.description)}</div>
              </div>\`;
          }).join("");
        }

        let lastCmdHtml = "";
        if (ws.lastCommand) {
          const pillClass = ws.lastCommand.success ? "pill-success" : "pill-fail";
          const pillText = ws.lastCommand.success ? "✓ Success" : "✗ Error";
          lastCmdHtml = \`
            <div class="last-command">
              <div class="last-cmd-title">Last command</div>
              <div class="last-cmd-content">
                <span class="status-pill \${pillClass}">\${pillText}</span>
                <strong>\${escapeHtml(ws.lastCommand.tool)}</strong>
                <span>\${escapeHtml(ws.lastCommand.description)}</span>
              </div>
              <div style="color: var(--text-dim); font-size: 11px;">
                \${formatTimeAgo(ws.lastCommand.completedAt)} (\${formatDuration(ws.lastCommand.durationMs)})
              </div>
            </div>\`;
        }

        let recentHtml = "";
        if (isExpanded && ws.recentCommands && ws.recentCommands.length > 0) {
          recentHtml = \`
            <div class="recent-list">
              \${ws.recentCommands.map(c => \`
                <div class="recent-item">
                  <div style="display: flex; align-items: center; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <span class="status-pill \${c.success ? 'pill-success' : 'pill-fail'}">\${c.success ? 'OK' : 'ERR'}</span>
                    <strong>\${escapeHtml(c.tool)}</strong>
                    <span style="color: var(--text-muted);">\${escapeHtml(c.description)}</span>
                  </div>
                  <div style="color: var(--text-dim); white-space: nowrap; font-size: 11px;">
                    \${formatTimeAgo(c.completedAt)} (\${formatDuration(c.durationMs)})
                  </div>
                </div>\`).join("")}
            </div>\`;
        }

        return \`
          <div class="workspace-card \${isRunning ? 'running' : ''}">
            <div class="ws-header">
              <div class="ws-path-wrapper">
                <div class="ws-dot \${isRunning ? 'running' : ''}"></div>
                <span class="ws-path">\${escapeHtml(ws.cwd)}</span>
              </div>
              <div class="ws-badges">
                <span class="badge \${isRunning ? 'badge-running' : 'badge-idle'}">\${isRunning ? 'Running Command' : 'Idle'}</span>
                <span class="badge badge-id" title="Workspace ID">\${escapeHtml(ws.id.slice(0, 8))}...</span>
              </div>
            </div>

            <div class="ws-meta">
              <span>Opened \${formatTimeAgo(ws.createdAt)}</span>
              <span>•</span>
              <span>Last active \${formatTimeAgo(ws.lastUsed)}</span>
            </div>

            \${runningHtml}
            \${lastCmdHtml}

            \${ws.recentCommands && ws.recentCommands.length > 0 ? \`
              <button class="details-toggle" onclick="toggleDetails('\${ws.id}')">
                \${isExpanded ? '▼ Hide recent commands' : '▶ View recent commands (' + ws.recentCommands.length + ')'}
              </button>
              \${recentHtml}
            \` : ''}
          </div>\`;
      }).join("");
    }

    function toggleAutoRefresh() {
      autoRefresh = !autoRefresh;
      document.getElementById("toggle-refresh-btn").textContent = "Auto-refresh: " + (autoRefresh ? "ON" : "OFF");
      if (autoRefresh) {
        fetchStatus();
        startTimer();
      } else {
        clearInterval(refreshTimer);
      }
    }

    function startTimer() {
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (autoRefresh) fetchStatus();
      }, 1000);
    }

    fetchStatus();
    startTimer();
  </script>
</body>
</html>`;
}
