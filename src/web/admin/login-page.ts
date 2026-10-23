import { ADMIN_NAV } from "./nav.js";
import { BASE_STYLES, BASE_SCRIPT, PAGE_HEAD } from "../styles.js";

// Admin home: the Telegram reader's login state (with the QR / phone login flows), today's
// post counts, channel health and the key subscription numbers

export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Статус — Парсер оренди</title>
<style>
${BASE_STYLES}
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .card-head h2 { margin: 0; }
  #reader form { max-width: 360px; }
  #reader label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  #reader input { width: 100%; margin-bottom: 12px; }
  #reader .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .divider { color: var(--muted); font-size: 13px; margin: 16px 0; }
  .qr { display: block; width: 240px; height: 240px; margin: 0 0 12px; border-radius: 8px; background: #fff; padding: 8px; }
  .tile a { color: inherit; text-decoration: none; }
  .tile.alert .value { color: var(--warn); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .layout { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(0, 2fr); gap: 16px; align-items: start; }
  .layout > div { display: grid; gap: 16px; min-width: 0; }
  @media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); } }
  .links { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 14px; margin-top: 12px; }
</style>
${PAGE_HEAD}
</head>
<body>
<main>
  <header>
    <h1>Статус</h1>
    ${ADMIN_NAV}
  </header>
  <div class="tiles" id="tiles"></div>
  <div class="layout">
    <div>
      <section class="card" id="reader"><p class="muted">Завантаження…</p></section>
      <section class="card">
        <div class="card-head"><h2>Канали</h2><a href="/settings">Керувати</a></div>
        <div id="channels"><p class="muted">Завантаження…</p></div>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>Сьогодні</h2><span class="muted" id="today-date"></span></div>
      <div id="today"><p class="muted">Завантаження…</p></div>
      <div class="links"><a href="/stats">Уся статистика</a><a href="/failures">Помилки AI</a></div>
    </section>
  </div>
</main>
<script>
${BASE_SCRIPT}
  const reader = document.getElementById("reader");
  let renderedKey = "";
  let actionError = "";

  // POST when a body is given, GET otherwise
  function call(path, body) {
    return body === undefined ? api("GET", path) : api("POST", path, body);
  }

  function errorHtml(s) {
    const message = actionError || s.error;
    return message ? '<p class="error">' + esc(message) + "</p>" : "";
  }

  function head(title, badge) {
    return '<div class="card-head"><h2>' + title + '</h2>' + badge + '</div>';
  }

  const views = {
    connecting: (s) => head("Telegram-читач", '<span class="badge warn">підключення</span>') +
      '<p class="hint">Зʼєднуємося з Telegram, зачекайте.</p>' + errorHtml(s),

    needs_login: (s) => head("Telegram-читач", '<span class="badge bad">потрібен вхід</span>') +
      '<p class="hint">Парсеру потрібен акаунт Telegram, щоб читати канали. Поки входу немає, сповіщення не надсилаються.</p>' +
      errorHtml(s) +
      '<div class="actions"><button data-action="qr">Увійти за QR-кодом</button></div>' +
      '<div class="divider">або за номером телефону</div>' +
      '<form data-form="phone"><label for="phone">Номер телефону</label>' +
      '<input id="phone" name="value" type="tel" placeholder="+380XXXXXXXXX" required autocomplete="tel">' +
      '<button type="submit">Надіслати код</button></form>',

    qr: (s) => head("Відскануйте QR-код", '<span class="badge warn">вхід</span>') +
      '<p class="hint">Telegram → Налаштування → Пристрої → Підключити пристрій. Код оновлюється кожні 30 с.</p>' +
      errorHtml(s) +
      (s.qrDataUrl ? '<img class="qr" alt="QR-код для входу в Telegram" src="' + s.qrDataUrl + '">'
        : s.loginByOwner ? '<p class="muted">Вхід виконує власник; QR-код бачить лише він.</p>'
        : '<p class="muted">Створюємо QR-код…</p>') +
      '<button class="secondary" data-action="cancel">Скасувати</button>',

    code: (s) => head("Введіть код входу", '<span class="badge warn">вхід</span>') +
      '<p class="hint">Telegram надіслав код у застосунок або SMS.</p>' + errorHtml(s) +
      '<form data-form="submit"><label for="code">Код</label>' +
      '<input id="code" name="value" inputmode="numeric" autocomplete="one-time-code" required autofocus>' +
      '<div class="actions"><button type="submit">Увійти</button>' +
      '<button type="button" class="secondary" data-action="cancel">Скасувати</button></div></form>',

    password: (s) => head("Двоетапна перевірка", '<span class="badge warn">вхід</span>') +
      '<p class="hint">' + (s.passwordHint ? "Підказка: " + esc(s.passwordHint) : "Введіть хмарний пароль.") + '</p>' +
      errorHtml(s) +
      '<form data-form="submit"><label for="password">Пароль</label>' +
      '<input id="password" name="value" type="password" autocomplete="current-password" required autofocus>' +
      '<div class="actions"><button type="submit">Увійти</button>' +
      '<button type="button" class="secondary" data-action="cancel">Скасувати</button></div></form>',

    logged_in: (s) => head("Telegram-читач", '<span class="badge on">працює</span>') +
      '<p class="hint">Вхід виконано, стежимо за новими повідомленнями в каналах.</p>' + errorHtml(s) +
      '<dl><dt>Акаунт</dt><dd>' + accountHtml() + '</dd>' +
      '<dt>Отримувачі</dt><dd><a href="/accounts">' + (s.recipients ?? "—") + ' користувачів</a>' +
      '<div class="muted">у акаунтах з активною підпискою й увімкненими сповіщеннями</div></dd></dl>',
  };

  // Telegram account the app is logged in as, fetched live once per page load
  let account = { status: "idle" };
  let lastState = null;

  function accountHtml() {
    if (account.status === "done") {
      const a = account.data;
      return esc(a.name || "—") +
        (a.username ? ' <a href="https://t.me/' + encodeURIComponent(a.username) + '" target="_blank" rel="noopener">@' + esc(a.username) + '</a>' : '') +
        '<div class="muted">' + (a.phone ? esc(a.phone) + ' · ' : '') + 'ID ' + esc(a.id) + '</div>';
    }
    if (account.status === "error") return '<span class="error">' + esc(account.error) + '</span>';
    return '<span class="muted">Завантаження…</span>';
  }

  async function loadAccount() {
    account = { status: "loading" };
    try {
      account = { status: "done", data: await call("/api/account") };
    } catch (e) {
      account = { status: "error", error: e.message };
    }
    if (lastState) render(lastState);
  }

  function render(s) {
    lastState = s;
    if (s.status === "logged_in" && account.status === "idle") loadAccount();
    // Re-render only when something visible changes, so typing isn't interrupted
    const key = JSON.stringify({ ...s, recipients: s.status === "logged_in" ? s.recipients : null, account, actionError });
    if (key === renderedKey) return;
    renderedKey = key;
    reader.innerHTML = (views[s.status] || views.connecting)(s);
  }

  async function refresh() {
    try {
      render(await call("/api/state"));
    } catch (e) {
      render({ status: "connecting", error: e.message });
    }
  }

  async function run(action, button) {
    if (button) button.disabled = true;
    actionError = "";
    try {
      await action();
    } catch (e) {
      actionError = e.message;
    }
    renderedKey = "";
    await refresh();
  }

  reader.addEventListener("click", (e) => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    run(() => action === "qr" ? call("/api/login", { method: "qr" }) : call("/api/cancel", {}), button);
  });

  reader.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const value = form.elements.value.value;
    const button = form.querySelector("button");
    run(() => form.dataset.form === "phone"
      ? call("/api/login", { method: "phone", phone: value })
      : call("/api/submit", { value }), button);
  });

  async function loadOverview() {
    try {
      const o = await call("/api/overview");
      const revenue = o.revenue30d.length ? o.revenue30d.map((r) => money(r.amount, r.currency)).join(", ") : "0";
      const tiles = [
        ["Оплачені зараз", o.activePaid, "/accounts"],
        ["На пробному", o.activeTrials, "/accounts"],
        ["Закінчуються за 7 днів", o.expiringIn7Days, "/accounts", o.expiringIn7Days > 0],
        ["Нові користувачі за 30 днів", o.signups30d, "/accounts"],
        ["Виручка за 30 днів", revenue, "/accounts"],
      ];
      document.getElementById("tiles").innerHTML = tiles.map(([label, value, href, alert]) =>
        '<div class="tile' + (alert ? ' alert' : '') + '"><a href="' + href + '"><div class="value">' + esc(value) +
        '</div><div class="label">' + label + '</div></a></div>').join("");
    } catch (e) {
      document.getElementById("tiles").innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }

  async function loadToday() {
    const el = document.getElementById("today");
    try {
      const stats = await call("/api/stats");
      document.getElementById("today-date").textContent = formatDate(stats.today);
      const rows = stats.rows.filter((r) => r.day === stats.today);
      const total = rows.reduce((t, r) => ({
        checked: t.checked + r.checked, matched: t.matched + r.matched, filteredOut: t.filteredOut + r.filteredOut, sent: t.sent + r.sent,
      }), { checked: 0, matched: 0, filteredOut: 0, sent: 0 });
      el.innerHTML = rows.length === 0 ? '<p class="empty">Сьогодні ще не було нових постів.</p>' :
        '<div class="table-wrap"><table><thead><tr><th>Канал</th><th class="num">Перевірено</th><th class="num">Збіг</th>' +
        '<th class="num">Відфільтровано</th><th class="num">Надіслано</th></tr></thead><tbody>' +
        rows.sort((a, b) => b.sent - a.sent || b.matched - a.matched).map((r) => '<tr><td>' + esc(r.channel) + '</td>' +
          '<td class="num">' + r.checked + '</td><td class="num">' + r.matched + '</td><td class="num">' + r.filteredOut +
          '</td><td class="num">' + r.sent + '</td></tr>').join("") +
        '<tr><th>Разом</th><th class="num">' + total.checked + '</th><th class="num">' + total.matched + '</th><th class="num">' +
          total.filteredOut + '</th><th class="num">' + total.sent + '</th></tr></tbody></table></div>';
    } catch (e) {
      el.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }

  async function loadChannels() {
    const el = document.getElementById("channels");
    try {
      const { channels } = await call("/api/settings");
      const broken = channels.filter((c) => c.error);
      el.innerHTML = channels.length === 0
        ? '<p class="notice">Немає каналів — нічого не відстежується. <a href="/settings">Додати канал</a></p>'
        : '<dl><dt>Відстежуються</dt><dd>' + (channels.length - broken.length) + ' з ' + channels.length + '</dd></dl>' +
          (broken.length === 0 ? '<p class="status">Усі канали знайдено.</p>' :
            '<h3>Не знайдено</h3><ul class="chips" style="list-style:none;padding:0;margin:0">' + broken.map((c) =>
              '<li class="chip" title="' + esc(c.error) + '"><span>' + esc(c.name) + '</span></li>').join("") + '</ul>');
    } catch (e) {
      el.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
    }
  }

  function refreshSummary() {
    loadOverview();
    loadToday();
    loadChannels();
  }

  refresh();
  setInterval(refresh, 2000);
  refreshSummary();
  setInterval(refreshSummary, 30000);
</script>
</body>
</html>`;
