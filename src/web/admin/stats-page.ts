import { ADMIN_NAV } from "./nav.js";
import { PAGE_HEAD } from "../styles.js";

export const STATS_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Статистика постів</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #65676b;
    --border: #dadde1; --accent: #2481cc; --ok: #2e7d32; --warn: #a15c00; --err: #c62828;
    --bar-bg: #eceff1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab;
      --border: #3a3d42; --accent: #3a9ce0; --ok: #6cc070; --warn: #f0b45a; --err: #ef7a72;
      --bar-bg: #2c2f33;
    }
  }
  :root[data-theme="dark"] {
    --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab;
    --border: #3a3d42; --accent: #3a9ce0; --ok: #6cc070; --warn: #f0b45a; --err: #ef7a72;
    --bar-bg: #2c2f33;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1100px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  a { color: var(--accent); }
  nav { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
  .periods { display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--border); background: var(--card); color: var(--text);
  }
  .periods button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
  button.danger { color: var(--err); }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  @media (max-width: 700px) { .cards { grid-template-columns: repeat(2, 1fr); } }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
  .card .label { color: var(--muted); font-size: 13px; }
  .card .value { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .hint { color: var(--muted); font-size: 12px; }
  .card.sent .value { color: var(--ok); }
  .card.filtered .value { color: var(--warn); }
  .table-wrap { overflow-x: auto; background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 12px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--muted); font-weight: 600; font-size: 13px; border-bottom: 1px solid var(--border); }
  tr + tr td { border-top: 1px solid var(--border); }
  td.ch { white-space: normal; overflow-wrap: anywhere; min-width: 160px; }
  .bar { display: inline-block; vertical-align: middle; width: 60px; height: 6px; border-radius: 3px; background: var(--bar-bg); margin-left: 8px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--ok); }
  .muted { color: var(--muted); }
  .summary { color: var(--muted); font-size: 14px; margin: 12px 0 0; }
  .empty { padding: 24px; text-align: center; color: var(--muted); }
</style>
${PAGE_HEAD}
</head>
<body>
<main>
  <header>
    <h1>Статистика постів</h1>
    ${ADMIN_NAV}
  </header>
  <div class="toolbar">
    <div class="periods" id="periods" role="group" aria-label="Період"></div>
    <button class="danger" id="clear" hidden>Скинути статистику</button>
  </div>
  <div class="cards" id="cards"></div>
  <p class="summary" id="summary">Завантаження…</p>
  <h2>За каналами</h2>
  <div class="table-wrap" id="channels"></div>
  <h2>За днями</h2>
  <div class="table-wrap" id="days"></div>
</main>
<script>
  const PERIODS = [
    { key: "1", label: "Сьогодні", days: 1 },
    { key: "7", label: "7 днів", days: 7 },
    { key: "30", label: "30 днів", days: 30 },
    { key: "90", label: "90 днів", days: 90 },
    { key: "all", label: "Увесь час", days: null },
  ];

  const periodsEl = document.getElementById("periods");
  const cardsEl = document.getElementById("cards");
  const summaryEl = document.getElementById("summary");
  const channelsEl = document.getElementById("channels");
  const daysEl = document.getElementById("days");
  const clearButton = document.getElementById("clear");
  let data = null;
  let period = "7";
  let confirmClear = false;

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  function num(n) {
    return Number(n).toLocaleString("uk-UA");
  }

  function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) + "%" : "—";
  }

  function emptyTotals() {
    return { checked: 0, matched: 0, filteredOut: 0, sent: 0 };
  }

  function add(into, row) {
    into.checked += row.checked;
    into.matched += row.matched;
    into.filteredOut += row.filteredOut;
    into.sent += row.sent;
    return into;
  }

  // YYYY-MM-DD of the day "offset" days before today (in the server's stats time zone)
  function dayBefore(today, offset) {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  }

  function rowsInPeriod() {
    const p = PERIODS.find((x) => x.key === period);
    if (!p.days) return data.rows;
    const from = dayBefore(data.today, p.days - 1);
    return data.rows.filter((r) => r.day >= from);
  }

  function card(cls, label, value, hint) {
    return '<div class="card ' + cls + '"><div class="label">' + label + '</div>' +
      '<div class="value">' + num(value) + '</div><div class="hint">' + hint + '</div></div>';
  }

  function renderCards(t) {
    cardsEl.innerHTML =
      card("checked", "Перевірено постів", t.checked, "текстові пости з каналів") +
      card("matched", "Збіг ключових слів", t.matched, pct(t.matched, t.checked) + " від перевірених") +
      card("filtered", "Відсіяно фільтром", t.filteredOut, "кімнати / поверх / ціна") +
      card("sent", "Надіслано в бот", t.sent, pct(t.sent, t.checked) + " від перевірених");
  }

  function table(headers, rows) {
    if (rows.length === 0) return '<div class="empty">Немає даних за цей період</div>';
    return '<table><thead><tr>' + headers.map((h) => '<th>' + h + '</th>').join("") + '</tr></thead><tbody>' +
      rows.join("") + '</tbody></table>';
  }

  function statCells(t) {
    const share = t.checked ? Math.round((t.sent / t.checked) * 100) : 0;
    return '<td>' + num(t.checked) + '</td><td>' + num(t.matched) + '</td><td>' + num(t.filteredOut) + '</td>' +
      '<td>' + num(t.sent) + '</td><td>' + pct(t.sent, t.checked) +
      '<span class="bar"><span style="width:' + share + '%"></span></span></td>';
  }

  const HEADERS = ["Перевірено", "Збіг слів", "Відсіяно", "Надіслано", "Конверсія"];

  function renderChannels(rows) {
    const byChannel = new Map();
    for (const r of rows) add(byChannel.get(r.channel) || byChannel.set(r.channel, emptyTotals()).get(r.channel), r);
    const sorted = [...byChannel.entries()].sort((a, b) => b[1].checked - a[1].checked);
    channelsEl.innerHTML = table(["Канал"].concat(HEADERS),
      sorted.map(([channel, t]) => '<tr><td class="ch">' + esc(channel) + '</td>' + statCells(t) + '</tr>'));
  }

  function renderDays(rows) {
    const byDay = new Map();
    for (const r of rows) add(byDay.get(r.day) || byDay.set(r.day, emptyTotals()).get(r.day), r);
    const sorted = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    daysEl.innerHTML = table(["День"].concat(HEADERS), sorted.map(([day, t]) =>
      '<tr><td>' + new Date(day + "T00:00:00Z").toLocaleDateString("uk-UA", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }) +
      (day === data.today ? ' <span class="muted">(сьогодні)</span>' : "") + '</td>' + statCells(t) + '</tr>'));
  }

  function renderPeriods() {
    periodsEl.innerHTML = PERIODS.map((p) =>
      '<button data-period="' + p.key + '" aria-pressed="' + (period === p.key) + '">' + p.label + '</button>').join("");
  }

  function render() {
    renderPeriods();
    const rows = rowsInPeriod();
    const totals = period === "all" ? data.allTime : rows.reduce(add, emptyTotals());
    renderCards(totals);
    renderChannels(rows);
    renderDays(rows);
    const hasData = data.allTime.checked > 0;
    clearButton.hidden = !hasData;
    summaryEl.textContent = (hasData ? "" : "Статистика ще не зібрана — тут зʼявляться дані, щойно парсер перевірить перші пости. ") +
      "Дні рахуються за часом " + data.timeZone + "." +
      (period === "all" ? " Таблиці показують останні 90 днів." : "");
  }

  periodsEl.addEventListener("click", (e) => {
    const button = e.target.closest("[data-period]");
    if (!button) return;
    period = button.dataset.period;
    render();
  });

  clearButton.addEventListener("click", async () => {
    // Two-step confirm, since the browser confirm() dialog may be unavailable
    if (!confirmClear) {
      confirmClear = true;
      clearButton.textContent = "Точно скинути?";
      setTimeout(() => { confirmClear = false; clearButton.textContent = "Скинути статистику"; }, 4000);
      return;
    }
    confirmClear = false;
    clearButton.textContent = "Скинути статистику";
    const res = await fetch(location.origin + "/api/stats", { method: "DELETE" });
    if (res.ok) load();
  });

  async function load() {
    try {
      const res = await fetch(location.origin + "/api/stats");
      if (!res.ok) throw new Error(res.statusText);
      data = await res.json();
      render();
    } catch (e) {
      summaryEl.textContent = "Не вдалося завантажити статистику: " + e.message;
    }
  }

  load();
  setInterval(load, 30000);
</script>
</body>
</html>`;
