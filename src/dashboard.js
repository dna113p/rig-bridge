/* Dashboard state is read from the bridge. Conversation text stays in the caller. */
let autoRefresh = true, refreshTimer, currentStatus;
let selectedProjectId, selectedThreadId, inboxSelected = false, fetchInFlight = false;
const browserKey = "rig-bridge-browser-projects";
const deliveredKey = "rig-bridge-browser-delivered";
const browserSeen = new Set();
let browserProjects = [], delivered = [];
try {
  browserProjects = JSON.parse(localStorage.getItem(browserKey) || "[]");
  delivered = JSON.parse(localStorage.getItem(deliveredKey) || "[]");
  if (!Array.isArray(browserProjects)) browserProjects = [];
  if (!Array.isArray(delivered)) delivered = [];
} catch { /* Storage is optional; the persisted inbox remains available. */ }
delivered.forEach(id => browserSeen.add(id));

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function timeAgo(ts) {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  return Math.floor(seconds / 86400) + "d ago";
}
function duration(ms) { return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }
function handleFor(threadId) { return currentStatus.workspaces.find(w => w.threadId === threadId); }
function threadState(thread) {
  const handle = handleFor(thread.id);
  if (handle?.activeCommands.length) return "Working";
  if (!thread.run) return "Idle · no work reported";
  return ({
    working: "Idle · awaiting handoff", interrupted: "Interrupted · status unknown",
    completed: "Your turn · completed", needs_input: "Your turn · needs input",
    blocked: "Your turn · blocked", failed: "Your turn · failed", cancelled: "Your turn · cancelled"
  })[thread.run.status] || "Status unknown";
}
function selectWorkspace(id) {
  selectedProjectId = id;
  selectedThreadId = undefined;
  inboxSelected = false;
  render();
}
function selectThread(id) {
  const project = currentStatus.projects.find(p => p.threads.some(t => t.id === id));
  if (!project) return;
  selectedProjectId = project.id;
  selectedThreadId = id;
  inboxSelected = false;
  history.replaceState(null, "", "#thread=" + id);
  render();
}
function showInbox() { inboxSelected = true; render(); }
async function post(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error("Request failed (HTTP " + response.status + ")");
}
async function openHandoff(id) {
  const event = currentStatus.notifications.find(n => n.id === id);
  if (!event) return;
  try {
    await post("/api/handoffs/read", { handoff_id: id });
    await fetchStatus();
    selectThread(event.threadId);
  } catch (error) { alert(error.message); }
}
async function markProjectRead(id) {
  try {
    for (const event of currentStatus.notifications.filter(n => !n.readAt && (!id || n.projectId === id))) {
      await post("/api/handoffs/read", { handoff_id: event.id });
    }
    await fetchStatus();
  } catch (error) { alert(error.message); }
}
async function toggleDesktop(id) {
  const project = currentStatus.projects.find(p => p.id === id);
  try {
    await post("/api/projects/preferences", { project_id: id, desktop_notifications: !project.desktopNotifications });
    await fetchStatus();
  } catch (error) { alert(error.message); }
}
async function toggleBrowser(id) {
  if (!("Notification" in window)) { alert("This browser does not support notifications. Handoffs remain in the inbox."); return; }
  if (browserProjects.includes(id)) browserProjects = browserProjects.filter(p => p !== id);
  else {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") { alert("Browser notification permission was not granted. Handoffs remain in the inbox."); return; }
    // Enabling alerts starts with future handoffs; existing ones remain in the inbox.
    currentStatus.notifications.filter(n => n.projectId === id).forEach(n => browserSeen.add(n.id));
    browserProjects.push(id);
  }
  try { localStorage.setItem(browserKey, JSON.stringify(browserProjects)); } catch {}
  rememberDelivered();
  render();
}
function rememberDelivered() {
  const unread = new Set(currentStatus.notifications.filter(n => !n.readAt).map(n => n.id));
  const retained = new Set([...browserSeen].slice(-1000));
  // Retain every unread event, so a large inbox cannot cause old alerts to be replayed.
  for (const id of browserSeen) if (unread.has(id)) retained.add(id);
  try { localStorage.setItem(deliveredKey, JSON.stringify([...retained])); } catch {}
}
async function browserAlerts() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const send = () => {
    // Reread storage while holding the origin lock so multiple tabs do not duplicate alerts.
    try { JSON.parse(localStorage.getItem(deliveredKey) || "[]").forEach(id => browserSeen.add(id)); } catch {}
    for (const event of currentStatus.notifications) {
      if (event.readAt || browserSeen.has(event.id) || !browserProjects.includes(event.projectId)) continue;
      const project = currentStatus.projects.find(p => p.id === event.projectId);
      const thread = project?.threads.find(t => t.id === event.threadId);
      try {
        const notification = new Notification((project?.name || "Rig Bridge") + " · Your turn", {
          body: (thread?.title || "Thread") + ": " + event.summary, tag: event.id
        });
        notification.onclick = () => { window.focus(); openHandoff(event.id); notification.close(); };
        browserSeen.add(event.id);
      } catch { /* A browser failure does not discard the unread handoff. */ }
    }
    rememberDelivered();
  };
  if (navigator.locks) await navigator.locks.request("rig-bridge-notifications", send);
  else send();
}
async function abortCommand(workspaceId, commandId) {
  if (!confirm("Abort this running command?")) return;
  try { await post("/api/abort", { workspace_id: workspaceId, command_id: commandId }); await fetchStatus(); }
  catch (error) { alert(error.message); }
}
async function fetchStatus() {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error("HTTP " + response.status);
    currentStatus = await response.json();
    if (!selectedThreadId && location.hash.startsWith("#thread=")) {
      const id = location.hash.slice(8);
      const project = currentStatus.projects.find(p => p.threads.some(t => t.id === id));
      if (project) { selectedProjectId = project.id; selectedThreadId = id; }
    }
    render();
    await browserAlerts();
  } catch (error) {
    document.getElementById("stat-updated").textContent = "offline";
    console.error("Failed to fetch bridge status:", error);
  } finally { fetchInFlight = false; }
}
function render() {
  if (!currentStatus) return;
  const data = currentStatus;
  document.getElementById("uptime-label").textContent = "Uptime: " + Math.floor(data.uptimeSeconds / 60) + "m";
  document.getElementById("stat-workspaces").textContent = data.projectsCount;
  document.getElementById("ws-count-badge").textContent = data.projectsCount;
  document.getElementById("stat-running").textContent = data.activeCommandsCount;
  document.getElementById("stat-version").textContent = "v" + data.version;
  document.getElementById("stat-updated").textContent = new Date().toLocaleTimeString();
  document.getElementById("inbox-btn").textContent = "Your turn · Inbox (" + data.unreadCount + ")";
  document.getElementById("stat-running-card").classList.toggle("alert-running", data.activeCommandsCount > 0);
  if (!data.projects.some(p => p.id === selectedProjectId)) selectedProjectId = data.projects[0]?.id;
  renderSidebar();
  renderMain();
}
function renderSidebar() {
  const data = currentStatus;
  document.getElementById("workspaces-list").innerHTML = data.projects.map(project => {
    const unread = data.notifications.filter(n => n.projectId === project.id && !n.readAt).length;
    const count = project.threads.filter(t => handleFor(t.id)?.activeCommands.length).length;
    return '<div class="ws-item ' + (project.id === selectedProjectId && !inboxSelected ? "selected" : "") + '">' +
      '<button class="project-select" onclick="selectWorkspace(\'' + project.id + '\')">' +
      '<div class="ws-item-header"><span class="ws-item-title">' + escapeHtml(project.name) + '</span>' +
      (unread ? '<span class="badge badge-running">' + unread + ' YOUR TURN</span>' : "") + '</div>' +
      '<div class="ws-item-path">' + escapeHtml(project.root) + '</div>' +
      '<div class="ws-item-meta">' + project.threads.length + ' threads · ' + count + ' working</div></button>' +
      (project.id === selectedProjectId && !inboxSelected ? project.threads.map(thread =>
        '<button class="thread-select ' + (thread.id === selectedThreadId ? "selected" : "") + '" onclick="selectThread(\'' + thread.id + '\')">' +
        '<strong>' + escapeHtml(thread.title) + '</strong><span>' + escapeHtml(threadState(thread)) + '</span></button>'
      ).join("") : "") + '</div>';
  }).join("") || '<div class="empty-state">No project workspaces yet. An assistant opening a directory will appear here.</div>';
}
function notificationCards(events) {
  return events.map(event => {
    const project = currentStatus.projects.find(p => p.id === event.projectId);
    const thread = project?.threads.find(t => t.id === event.threadId);
    return '<button class="handoff-card ' + (event.readAt ? "" : "unread") + '" onclick="openHandoff(\'' + event.id + '\')">' +
      '<div class="last-cmd-header"><strong>' + escapeHtml(project?.name) + ' · ' + escapeHtml(thread?.title) + '</strong>' +
      '<span>' + (event.readAt ? "Read" : "Unread") + ' · ' + timeAgo(event.createdAt) + '</span></div>' +
      '<div class="handoff-outcome">Your turn · ' + escapeHtml(event.reason.replaceAll("_", " ")) + '</div>' +
      '<div class="handoff-summary">' + escapeHtml(event.summary) + '</div>' +
      (event.deliveryError ? '<div class="delivery-error">Desktop alert: ' + escapeHtml(event.deliveryError) + '</div>' : "") +
      '</button>';
  }).join("") || '<div class="empty-state">No handoffs yet. The assistant reports here when it returns control to you.</div>';
}
function renderMain() {
  const container = document.getElementById("main-content");
  if (inboxSelected) {
    container.innerHTML = '<div class="main-header"><div class="main-ws-path">Your turn · Inbox</div>' +
      '<button class="btn" onclick="markProjectRead()">Mark all read</button></div>' + notificationCards(currentStatus.notifications);
    return;
  }
  const project = currentStatus.projects.find(p => p.id === selectedProjectId);
  if (!project) { container.innerHTML = '<div class="empty-state">Open a project through MCP to begin.</div>'; return; }
  if (!project.threads.some(t => t.id === selectedThreadId)) {
    selectedThreadId = (project.threads.find(t => handleFor(t.id)?.activeCommands.length) || project.threads[0])?.id;
  }
  const thread = project.threads.find(t => t.id === selectedThreadId);
  // Sidebar selection also reflects the automatically selected thread.
  renderSidebar();
  const browserEnabled = browserProjects.includes(project.id) && "Notification" in window && Notification.permission === "granted";
  let html = '<div class="main-header"><div class="main-title-wrap"><div class="main-ws-path">' + escapeHtml(project.name) + '</div>' +
    '<div class="main-ws-meta">' + escapeHtml(project.root) + '</div></div></div>' +
    '<div class="notification-controls"><button class="btn" onclick="toggleBrowser(\'' + project.id + '\')">Browser alerts: ' + (browserEnabled ? "ON" : "OFF") + '</button>' +
    '<button class="btn" onclick="toggleDesktop(\'' + project.id + '\')">Desktop alerts: ' + (project.desktopNotifications ? "ON" : "OFF") + '</button>' +
    '<button class="btn" onclick="markProjectRead(\'' + project.id + '\')">Mark workspace read</button></div>';
  if (thread) {
    const handle = handleFor(thread.id);
    html += '<section class="thread-detail"><div class="section-title">' + escapeHtml(thread.title) + '</div>' +
      '<div class="handoff-outcome">' + escapeHtml(threadState(thread)) + '</div>' +
      '<div class="main-ws-meta">Checkout: ' + escapeHtml(thread.cwd) + '</div>' +
      '<div class="main-ws-meta">Thread: <code>' + thread.id + '</code> · ' + (handle ? "Connected" : "Saved · resume through MCP") + '</div></section>';
    if (handle?.activeCommands.length) {
      html += '<div class="section-title">Currently running commands</div>' + handle.activeCommands.map(command =>
        '<div class="running-box"><div class="running-box-header"><span>' + escapeHtml(command.tool) + ' · ' + duration(command.elapsedMs) + '</span>' +
        '<button class="btn btn-danger" onclick="abortCommand(\'' + handle.id + '\',\'' + command.id + '\')">Abort command</button></div>' +
        '<div class="running-command-desc">' + escapeHtml(command.description) + '</div></div>'
      ).join("");
    }
    if (handle?.recentCommands.length) {
      html += '<div class="section-title">Recent tool activity</div><div class="recent-table-wrap"><table class="recent-table"><thead><tr><th>Status</th><th>Tool</th><th>Command / action</th><th>Duration</th></tr></thead><tbody>' +
        handle.recentCommands.map(command => '<tr><td>' + (command.success ? "OK" : "ERR") + '</td><td>' + escapeHtml(command.tool) + '</td><td>' +
          escapeHtml(command.description) + (command.error ? '<div class="delivery-error">' + escapeHtml(command.error) + '</div>' : "") +
          '</td><td>' + duration(command.durationMs) + '</td></tr>').join("") + '</tbody></table></div>';
    }
    if (thread.runs.length) {
      html += '<div class="section-title">Run history</div>' + thread.runs.map(run =>
        '<div class="last-command-card"><div class="last-cmd-header"><strong>' + escapeHtml(run.title) + '</strong><span>' + escapeHtml(run.status.replaceAll("_", " ")) +
        ' · ' + timeAgo(run.completedAt || run.startedAt) + '</span></div>' +
        (run.summary ? '<div class="handoff-summary">' + escapeHtml(run.summary) + '</div>' : "") + '</div>'
      ).join("");
    }
    html += '<div class="section-title">Thread handoffs</div>' + notificationCards(currentStatus.notifications.filter(n => n.threadId === thread.id));
  }
  container.innerHTML = html;
}
function toggleAutoRefresh() {
  autoRefresh = !autoRefresh;
  document.getElementById("toggle-refresh-btn").textContent = "Auto-refresh: " + (autoRefresh ? "ON" : "OFF");
  if (autoRefresh) { fetchStatus(); startTimer(); } else clearInterval(refreshTimer);
}
function startTimer() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (autoRefresh) fetchStatus(); }, 1000);
}
window.addEventListener("hashchange", () => {
  if (currentStatus && location.hash.startsWith("#thread=")) selectThread(location.hash.slice(8));
});
window.addEventListener("storage", event => {
  if (event.key !== browserKey) return;
  try {
    const value = JSON.parse(event.newValue || "[]");
    browserProjects = Array.isArray(value) ? value : [];
    render();
  } catch {}
});
fetchStatus();
startTimer();
