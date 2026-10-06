export const SUBSCRIBERS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot Subscribers</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #65676b;
    --border: #dadde1; --accent: #2481cc; --ok: #2e7d32; --ok-bg: #e8f5e9; --off-bg: #eceff1;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab;
      --border: #3a3d42; --accent: #3a9ce0; --ok: #6bc46f; --ok-bg: #1f3321; --off-bg: #2c2f33;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 960px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  a { color: var(--accent); }
  nav { display: flex; gap: 16px; font-size: 14px; }
  .summary { color: var(--muted); font-size: 14px; margin: 0 0 12px; }
  .filters { display: flex; gap: 8px; margin-bottom: 12px; }
  .filters button {
    font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
  }
  .filters button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .table-wrap { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
  .muted { color: var(--muted); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.on { background: var(--ok-bg); color: var(--ok); }
  .badge.off { background: var(--off-bg); color: var(--muted); }
  .empty { padding: 32px; text-align: center; color: var(--muted); }
</style>
</head>
<body>
<main>
  <header>
    <h1>Bot subscribers</h1>
    <nav><a href="/">Status</a><a href="/settings">Settings</a></nav>
  </header>
  <p class="summary" id="summary">Loading…</p>
  <div class="filters" role="group" aria-label="Filter subscribers">
    <button data-filter="all" aria-pressed="true">All</button>
    <button data-filter="active" aria-pressed="false">Active</button>
    <button data-filter="inactive" aria-pressed="false">Unsubscribed</button>
  </div>
  <div class="table-wrap" id="list"></div>
</main>
<script>
  const list = document.getElementById("list");
  const summary = document.getElementById("summary");
  let subscribers = [];
  let filter = "all";

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  function formatDate(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
  }

  function row(s) {
    const fullName = [s.firstName, s.lastName].filter(Boolean).join(" ");
    const name = fullName ? esc(fullName) : '<span class="muted">—</span>';
    const username = s.username
      ? '<a href="https://t.me/' + encodeURIComponent(s.username) + '" target="_blank" rel="noopener">@' + esc(s.username) + '</a>'
      : '<span class="muted">—</span>';
    const status = s.active
      ? '<span class="badge on">Active</span>'
      : '<span class="badge off">Unsubscribed</span>';
    return '<tr><td>' + name +
      '</td><td>' + username +
      '</td><td class="mono">' + esc(s.chatId) +
      '</td><td>' + status +
      '</td><td>' + formatDate(s.subscribedAt) +
      '</td><td>' + formatDate(s.unsubscribedAt) + '</td></tr>';
  }

  function render() {
    const active = subscribers.filter((s) => s.active).length;
    summary.textContent = active + " active · " + (subscribers.length - active) + " unsubscribed · " + subscribers.length + " total";

    const shown = subscribers.filter((s) => filter === "all" || (filter === "active") === s.active);
    list.innerHTML = shown.length === 0
      ? '<div class="empty">No subscribers yet. Users subscribe by sending /start to the bot.</div>'
      : '<table><thead><tr><th>Name</th><th>Username</th><th>Chat ID</th><th>Status</th>' +
        '<th>Subscribed</th><th>Unsubscribed</th></tr></thead><tbody>' + shown.map(row).join("") + '</tbody></table>';
  }

  document.querySelector(".filters").addEventListener("click", (e) => {
    const button = e.target.closest("[data-filter]");
    if (!button) return;
    filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    render();
  });

  async function load() {
    try {
      const res = await fetch(location.origin + "/api/subscribers");
      if (!res.ok) throw new Error(res.statusText);
      subscribers = await res.json();
      render();
    } catch (e) {
      summary.textContent = "Could not load subscribers: " + e.message;
    }
  }

  load();
  setInterval(load, 15000);
</script>
</body>
</html>`;
