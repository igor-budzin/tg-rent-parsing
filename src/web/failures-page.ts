export const FAILURES_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Помилки AI-розбору</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #65676b;
    --border: #dadde1; --accent: #2481cc; --err: #c62828; --err-bg: #fdecea;
    --warn: #a15c00; --warn-bg: #fff4e0; --off-bg: #eceff1; --code-bg: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab;
      --border: #3a3d42; --accent: #3a9ce0; --err: #ef7a72; --err-bg: #3a2020;
      --warn: #f0b45a; --warn-bg: #3a2e1a; --off-bg: #2c2f33; --code-bg: #1a1c1f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1100px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  a { color: var(--accent); }
  nav { display: flex; gap: 16px; font-size: 14px; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .summary { color: var(--muted); font-size: 14px; margin: 0; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  button {
    font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
  }
  .filters button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  button.danger { color: var(--err); }
  .list { display: flex; flex-direction: column; gap: 8px; }
  details { background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  summary {
    list-style: none; cursor: pointer; padding: 10px 14px;
    display: grid; grid-template-columns: 150px 170px 1fr; gap: 4px 12px; align-items: baseline;
  }
  summary::-webkit-details-marker { display: none; }
  @media (max-width: 700px) { summary { grid-template-columns: 1fr; } }
  .time { color: var(--muted); font-size: 13px; white-space: nowrap; }
  .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .msg small { color: var(--muted); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge.err { background: var(--err-bg); color: var(--err); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .badge.off { background: var(--off-bg); color: var(--muted); }
  .body { padding: 0 14px 14px; border-top: 1px solid var(--border); }
  dl { display: grid; grid-template-columns: 160px 1fr; gap: 6px 12px; margin: 12px 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  @media (max-width: 700px) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 6px; } }
  h3 { font-size: 13px; font-weight: 600; color: var(--muted); margin: 14px 0 6px; }
  pre {
    margin: 0; padding: 10px 12px; background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
    font: 12.5px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
  .muted { color: var(--muted); }
  .empty { padding: 32px; text-align: center; color: var(--muted); background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Помилки AI-розбору</h1>
    <nav><a href="/">Статус</a><a href="/settings">Налаштування</a><a href="/subscribers">Підписники</a></nav>
  </header>
  <div class="toolbar">
    <p class="summary" id="summary">Завантаження…</p>
    <button class="danger" id="clear" hidden>Очистити журнал</button>
  </div>
  <div class="filters" id="filters" role="group" aria-label="Фільтр за причиною"></div>
  <div class="list" id="list"></div>
</main>
<script>
  const REASONS = {
    api_error: { label: "Помилка API", tone: "err" },
    network: { label: "Мережа / тайм-аут", tone: "err" },
    error: { label: "Інша помилка", tone: "err" },
    empty_response: { label: "Порожня відповідь", tone: "warn" },
    invalid_json: { label: "Не JSON", tone: "warn" },
    nothing_extracted: { label: "Нічого не знайдено", tone: "warn" },
    cooldown: { label: "Пауза AI", tone: "off" },
    no_models: { label: "Немає моделей", tone: "err" },
  };

  const list = document.getElementById("list");
  const summary = document.getElementById("summary");
  const filters = document.getElementById("filters");
  const clearButton = document.getElementById("clear");
  let failures = [];
  let filter = "all";
  // Expanded rows survive the periodic refresh
  const open = new Set();

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "medium" });
  }

  function reasonBadge(reason) {
    const r = REASONS[reason] || { label: reason, tone: "err" };
    return '<span class="badge ' + r.tone + '">' + esc(r.label) + '</span>';
  }

  function headline(f) {
    if (f.error) return esc(f.error);
    if (f.reason === "nothing_extracted") return "Модель повернула JSON без даних оголошення";
    if (f.reason === "invalid_json") return "Модель повернула текст, який не є JSON";
    if (f.reason === "empty_response") return "Модель не повернула вмісту";
    return "";
  }

  function field(label, value) {
    return value === null || value === undefined || value === "" ? "" : '<dt>' + label + '</dt><dd>' + value + '</dd>';
  }

  function block(title, text) {
    return text ? '<h3>' + title + '</h3><pre>' + esc(text) + '</pre>' : "";
  }

  function item(f) {
    const channel = f.channel ? esc(f.channel) : "";
    const link = f.messageLink
      ? '<a href="' + esc(f.messageLink) + '" target="_blank" rel="noopener">' + esc(f.messageLink) + '</a>'
      : "";
    const outcome = f.willRetry
      ? "Повторна спроба з наступною моделлю"
      : (f.reason === "cooldown" || f.reason === "no_models" ? "AI пропущено, " : "") + "пост надіслано без розбору";

    return '<details data-id="' + esc(f.id) + '"' + (open.has(f.id) ? " open" : "") + '>' +
      '<summary><span class="time">' + formatDate(f.createdAt) + '</span>' +
      '<span>' + reasonBadge(f.reason) + '</span>' +
      '<span class="msg">' + headline(f) + (channel ? ' <small>· ' + channel + '</small>' : "") + '</span></summary>' +
      '<div class="body"><dl>' +
        field("Час", esc(new Date(f.createdAt).toISOString())) +
        field("Причина", reasonBadge(f.reason) + ' <span class="mono muted">' + esc(f.reason) + '</span>') +
        field("Наслідок", esc(outcome)) +
        field("Відповіла модель", f.model ? '<span class="mono">' + esc(f.model) + '</span>' : null) +
        field("Ланцюжок моделей", f.models.length ? '<span class="mono">' + f.models.map(esc).join(" → ") + '</span>' : null) +
        field("HTTP-статус", f.status ? '<span class="mono">' + f.status + '</span>' : null) +
        field("Тривалість", f.durationMs != null ? (f.durationMs / 1000).toFixed(1) + " с" : null) +
        field("Канал", channel) +
        field("Пост", link) +
        field("Помилка", f.error ? esc(f.error) : null) +
      '</dl>' +
      block("Відповідь моделі", f.response) +
      block("Деталі", f.details ? JSON.stringify(f.details, null, 2) : "") +
      block("Текст поста", f.postText) +
      '</div></details>';
  }

  function renderFilters() {
    const counts = {};
    for (const f of failures) counts[f.reason] = (counts[f.reason] || 0) + 1;
    const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (filter !== "all" && !counts[filter]) filter = "all";
    filters.innerHTML = [["all", "Усі", failures.length]]
      .concat(keys.map((k) => [k, (REASONS[k] || { label: k }).label, counts[k]]))
      .map(([key, label, n]) =>
        '<button data-filter="' + esc(key) + '" aria-pressed="' + (filter === key) + '">' + esc(label) + ' · ' + n + '</button>')
      .join("");
  }

  function render() {
    const day = Date.now() - 24 * 60 * 60 * 1000;
    const lastDay = failures.filter((f) => new Date(f.createdAt).getTime() > day).length;
    summary.textContent = failures.length
      ? "За останні 24 год: " + lastDay + " · Усього в журналі: " + failures.length + " (зберігаються останні 1000)"
      : "";
    clearButton.hidden = failures.length === 0;
    renderFilters();

    const shown = failures.filter((f) => filter === "all" || f.reason === filter);
    list.innerHTML = shown.length === 0
      ? '<div class="empty">Помилок немає. Тут зʼявляться всі випадки, коли AI-модель не змогла розібрати пост.</div>'
      : shown.map(item).join("");
  }

  filters.addEventListener("click", (e) => {
    const button = e.target.closest("[data-filter]");
    if (!button) return;
    filter = button.dataset.filter;
    render();
  });

  list.addEventListener("toggle", (e) => {
    const id = e.target.dataset.id;
    if (e.target.open) open.add(id); else open.delete(id);
  }, true);

  clearButton.addEventListener("click", async () => {
    if (!confirm("Видалити всі записи про помилки?")) return;
    const res = await fetch(location.origin + "/api/parse-failures", { method: "DELETE" });
    if (res.ok) { open.clear(); load(); }
  });

  async function load() {
    try {
      const res = await fetch(location.origin + "/api/parse-failures");
      if (!res.ok) throw new Error(res.statusText);
      failures = await res.json();
      render();
    } catch (e) {
      summary.textContent = "Не вдалося завантажити журнал: " + e.message;
    }
  }

  load();
  setInterval(load, 15000);
</script>
</body>
</html>`;
