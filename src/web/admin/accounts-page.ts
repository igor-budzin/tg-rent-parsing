import { ADMIN_NAV } from "./nav.js";
import { BASE_STYLES, BASE_SCRIPT, PAGE_HEAD } from "../styles.js";

// Accounts and users: subscription status, cash payments, members and blocking.
// The selected account is kept in the URL hash, so a page reload keeps it open.

export const ACCOUNTS_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Акаунти</title>
<style>
${BASE_STYLES}
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 900px) { .layout { grid-template-columns: minmax(0, 1fr); } }
  .tabs { display: flex; gap: 8px; margin-bottom: 12px; }
  .tabs button { font-weight: 500; }
  .tabs button[aria-pressed="false"] { background: transparent; color: var(--text); border-color: var(--border); }
  #detail:empty::before { content: "Виберіть акаунт у списку."; color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
${PAGE_HEAD}
</head>
<body>
<main>
  <header>
    <h1>Акаунти й користувачі</h1>
    ${ADMIN_NAV}
  </header>
  <div class="tiles" id="tiles"></div>
  <div class="layout">
    <section class="card">
      <div class="tabs" role="group" aria-label="Список">
        <button data-tab="accounts" aria-pressed="true">Акаунти</button>
        <button data-tab="users" aria-pressed="false">Користувачі</button>
      </div>
      <form class="row" id="search">
        <input name="q" placeholder="Назва, @юзернейм, імʼя або Telegram ID" aria-label="Пошук">
        <button type="submit" class="secondary">Знайти</button>
      </form>
      <p class="error" id="list-error"></p>
      <div class="table-wrap" id="list"></div>
    </section>
    <section class="card" id="detail"></section>
  </div>
</main>
<script>
${BASE_SCRIPT}
  const KINDS = { trial: "пробний", paid: "оплачений", gift: "подарунок" };
  const ROLES = { owner: "власник", editor: "редактор", viewer: "глядач" };
  const STATUSES = { active: "активний", blocked: "заблокований", archived: "архів" };
  let tab = "accounts";
  let query = "";
  let plans = [];
  let selectedId = null;

  function subscriptionBadge(a) {
    if (a.activeKind) {
      return '<span class="badge ' + (a.activeKind === "trial" ? "warn" : "on") + '">' + KINDS[a.activeKind] +
        ' до ' + formatDate(a.activeUntil) + '</span>';
    }
    return a.lastEndsAt
      ? '<span class="badge bad">закінчилась ' + formatDate(a.lastEndsAt) + '</span>'
      : '<span class="badge off">немає</span>';
  }

  function statusBadge(status) {
    const cls = status === "active" ? "on" : status === "blocked" ? "bad" : "off";
    return '<span class="badge ' + cls + '">' + (STATUSES[status] || esc(status)) + '</span>';
  }

  async function loadOverview() {
    try {
      const o = await api("GET", "/api/overview");
      const conversion = o.trialAccounts ? Math.round((o.convertedTrials / o.trialAccounts) * 100) + "%" : "—";
      const revenue = o.revenue30d.length ? o.revenue30d.map((r) => money(r.amount, r.currency)).join(", ") : "0";
      const tiles = [
        ["Користувачі", o.users], ["Акаунти", o.accounts], ["Оплачені зараз", o.activePaid],
        ["На пробному", o.activeTrials], ["Закінчуються за 7 днів", o.expiringIn7Days],
        ["Нові за 30 днів", o.signups30d], ["Пробний → оплата", conversion], ["Виручка за 30 днів", revenue],
      ];
      document.getElementById("tiles").innerHTML = tiles.map(([label, value]) =>
        '<div class="tile"><div class="value">' + esc(value) + '</div><div class="label">' + label + '</div></div>').join("");
    } catch (err) {
      document.getElementById("tiles").innerHTML = '<p class="error">' + esc(err.message) + '</p>';
    }
  }

  async function loadList() {
    const list = document.getElementById("list");
    document.getElementById("list-error").textContent = "";
    try {
      if (tab === "accounts") {
        const accounts = await api("GET", "/api/accounts?q=" + encodeURIComponent(query));
        list.innerHTML = accounts.length === 0 ? '<p class="empty">Нічого не знайдено.</p>' :
          '<table><thead><tr><th>Акаунт</th><th>Власник</th><th>Учасн.</th><th>Підписка</th><th>Статус</th></tr></thead><tbody>' +
          accounts.map((a) => '<tr class="clickable' + (a.id === selectedId ? ' selected' : '') + '" data-account="' + a.id + '">' +
            '<td>' + esc(a.name) + ' <span class="muted">#' + a.id + '</span></td>' +
            '<td>' + esc(a.ownerName || "—") + '</td><td>' + a.members + '</td>' +
            '<td>' + subscriptionBadge(a) + '</td><td>' + statusBadge(a.status) + '</td></tr>').join("") + '</tbody></table>';
      } else {
        const users = await api("GET", "/api/users?q=" + encodeURIComponent(query));
        list.innerHTML = users.length === 0 ? '<p class="empty">Нічого не знайдено.</p>' :
          '<table><thead><tr><th>Користувач</th><th>Акаунт</th><th>Бот</th><th>Статус</th><th></th></tr></thead><tbody>' +
          users.map((u) => '<tr>' +
            '<td>' + esc([u.firstName, u.lastName].filter(Boolean).join(" ") || "—") +
              (u.username ? ' <a href="https://t.me/' + encodeURIComponent(u.username) + '" target="_blank" rel="noopener">@' + esc(u.username) + '</a>' : '') +
              '<div class="muted mono">ID ' + u.id + ' · TG ' + esc(u.telegramUserId) + ' · з ' + formatDate(u.createdAt) + '</div></td>' +
            '<td>' + (u.accountId ? '<a href="#account=' + u.accountId + '">' + esc(u.accountName) + '</a> <span class="muted">' + ROLES[u.role] + '</span>' : '—') + '</td>' +
            '<td>' + (u.botBlocked ? '<span class="badge bad">заблокував</span>' : !u.chatId ? '<span class="badge off">не писав</span>'
              : u.notificationsEnabled ? '<span class="badge on">сповіщення</span>' : '<span class="badge off">вимкнув</span>') + '</td>' +
            '<td>' + statusBadge(u.status) + '</td>' +
            '<td><button class="small ' + (u.status === "active" ? "danger" : "secondary") + '" data-user-status="' + u.id + '" data-status="' +
              (u.status === "active" ? "blocked" : "active") + '">' + (u.status === "active" ? "Заблокувати" : "Розблокувати") + '</button></td></tr>').join("") +
          '</tbody></table>';
      }
    } catch (err) {
      document.getElementById("list-error").textContent = err.message;
    }
  }

  function grantForm(d) {
    const options = plans.filter((p) => p.active && p.code !== "trial").map((p) =>
      '<option value="' + p.id + '" data-price="' + p.price + '" data-currency="' + esc(p.currency) + '" data-days="' + p.durationDays + '">' +
      esc(p.name) + ' — ' + money(p.price, p.currency) + ' / ' + p.durationDays + ' дн.</option>').join("");
    return '<h3>Продовжити підписку</h3>' +
      '<p class="hint">Новий період починається, коли закінчиться поточний. Сума 0 — подарунок без платежу.</p>' +
      '<form id="grant"><div class="row">' +
      '<label class="field">Тариф<select name="planId">' + options + '</select></label>' +
      '<label class="field">Періодів<input name="periods" type="number" min="1" max="24" step="1" value="1"></label>' +
      '<label class="field">Днів (необовʼязково)<input name="days" type="number" min="1" max="3650" step="1" placeholder="за тарифом"></label></div>' +
      '<div class="row"><label class="field">Сума<input name="amount" type="number" min="0" step="any"></label>' +
      '<label class="field">Валюта<input name="currency" maxlength="3"></label>' +
      '<label class="field">Спосіб<select name="method"><option value="cash">Готівка</option><option value="card">Переказ на картку</option>' +
      '<option value="bank">Рахунок ФОП</option><option value="other">Інше</option></select></label></div>' +
      '<div class="row"><input name="note" placeholder="Примітка (хто платив, номер чека…)" aria-label="Примітка">' +
      '<button type="submit">Записати</button></div><p class="error" data-error="grant"></p></form>';
  }

  function syncGrantAmount(form) {
    const option = form.elements.planId.selectedOptions[0];
    if (!option) return;
    const periods = Number(form.elements.periods.value) || 1;
    form.elements.amount.value = Number(option.dataset.price) * periods;
    form.elements.currency.value = option.dataset.currency;
  }

  async function loadDetail() {
    const detail = document.getElementById("detail");
    if (!selectedId) { detail.innerHTML = ""; return; }
    try {
      const d = await api("GET", "/api/accounts/detail?id=" + encodeURIComponent(selectedId));
      const a = d.account;
      const s = a.subscription;
      const f = d.filters;
      const range = (r) => r.min === null && r.max === null ? "будь-який" : (r.min ?? "…") + " – " + (r.max ?? "…");
      detail.innerHTML =
        '<h2>' + esc(a.name) + ' <span class="muted">#' + a.id + '</span> ' + statusBadge(a.status) + '</h2>' +
        '<dl><dt>Підписка</dt><dd>' + (s.active ? KINDS[s.kind] + ' · ' + esc(s.plan.name) + ' до ' + formatDate(s.endsAt, true) +
          ' (' + s.daysLeft + ' дн.)' : '<span class="badge bad">неактивна</span>' + (s.endsAt ? ' з ' + formatDate(s.endsAt, true) : '')) + '</dd>' +
        '<dt>Ліміти</dt><dd>' + a.limits.maxMembers + ' учасн., ' + a.limits.maxKeywords + ' ключових слів</dd>' +
        '<dt>Надіслано</dt><dd>' + a.deliveries30d + ' за 30 днів</dd>' +
        '<dt>Створено</dt><dd>' + formatDate(a.createdAt, true) + '</dd>' +
        '<dt>Фільтри</dt><dd>' + (f.keywords.length ? f.keywords.map(esc).join(", ") : '<span class="muted">немає ключових слів</span>') +
          '<div class="muted">кімнати: ' + (f.rooms.length ? f.rooms.map((r) => r === 4 ? "4+" : r).join(", ") : "будь-які") +
          ' · поверх: ' + range(f.floor) + ' · ціна: ' + range(f.price) + ' ₴</div></dd></dl>' +
        '<div class="actions" style="margin-top:12px">' +
          (a.status === "archived" ? '' : '<button class="small ' + (a.status === "active" ? "danger" : "secondary") + '" data-account-status="' +
          (a.status === "active" ? "blocked" : "active") + '">' + (a.status === "active" ? "Заблокувати акаунт" : "Розблокувати акаунт") + '</button>') +
        '</div>' +
        grantForm(a) +
        '<h3>Учасники</h3><div class="table-wrap"><table><tbody>' + a.members.map((m) =>
          '<tr><td>' + esc(m.name) + (m.username ? ' <span class="muted">@' + esc(m.username) + '</span>' : '') +
          (m.botBlocked ? ' <span class="badge bad">заблокував бота</span>' : !m.notificationsEnabled ? ' <span class="badge off">сповіщення вимк.</span>' : '') + '</td>' +
          '<td>' + ROLES[m.role] + '</td><td class="actions">' + (m.role === "owner" ? '' :
            '<button class="small secondary" data-transfer="' + m.userId + '">Зробити власником</button>' +
            '<button class="small danger" data-remove-member="' + m.userId + '">Видалити</button>') + '</td></tr>').join("") +
        '</tbody></table></div>' +
        '<form class="row" id="add-member" style="margin-top:8px"><input name="userId" placeholder="ID користувача (з вкладки «Користувачі»)" aria-label="ID користувача">' +
        '<select name="role"><option value="editor">редактор</option><option value="viewer">глядач</option></select>' +
        '<button type="submit" class="secondary">Перемістити сюди</button></form><p class="error" data-error="members"></p>' +
        '<h3>Періоди підписки</h3>' + (d.subscriptions.length === 0 ? '<p class="empty">Ще не було.</p>' :
          '<div class="table-wrap"><table><thead><tr><th>Тариф</th><th>Тип</th><th>Період</th><th>Ким</th><th></th></tr></thead><tbody>' +
          d.subscriptions.map((p) => '<tr><td>' + esc(p.planName) + '</td><td>' + KINDS[p.kind] + ' <span class="muted">' + esc(p.source) + '</span></td>' +
            '<td>' + formatDate(p.startsAt) + ' – ' + formatDate(p.endsAt) + (p.cancelledAt ? ' <span class="badge bad">скасовано</span>' : '') + '</td>' +
            '<td>' + esc(p.adminLogin || "—") + '</td><td>' + (p.cancelledAt ? '' :
              '<button class="small danger" data-cancel-sub="' + p.id + '">Скасувати</button>') + '</td></tr>').join("") + '</tbody></table></div>') +
        '<h3>Платежі</h3>' + (d.payments.length === 0 ? '<p class="empty">Немає.</p>' :
          '<div class="table-wrap"><table><tbody>' + d.payments.map((p) => '<tr><td>' + formatDate(p.createdAt, true) + '</td><td>' +
            money(p.amount, p.currency) + '</td><td>' + esc(p.method) + '</td><td>' + esc(p.note || "") + '</td><td class="muted">' +
            esc(p.adminLogin || "") + '</td></tr>').join("") + '</tbody></table></div>') +
        '<h3>Журнал</h3>' + (d.audit.length === 0 ? '<p class="empty">Порожньо.</p>' :
          '<div class="table-wrap"><table><tbody>' + d.audit.map((e) => '<tr><td>' + formatDate(e.createdAt, true) + '</td><td>' +
            esc(e.action) + '</td><td class="muted">' + esc(e.actorName || e.actorType) + '</td></tr>').join("") + '</tbody></table></div>');
      const form = document.getElementById("grant");
      syncGrantAmount(form);
      form.elements.planId.addEventListener("change", () => syncGrantAmount(form));
      form.elements.periods.addEventListener("input", () => syncGrantAmount(form));
    } catch (err) {
      detail.innerHTML = '<p class="error">' + esc(err.message) + '</p>';
    }
  }

  async function act(errorKey, fn) {
    const el = document.querySelector('[data-error="' + errorKey + '"]');
    if (el) el.textContent = "";
    try {
      await fn();
      await Promise.all([loadDetail(), loadList(), loadOverview()]);
    } catch (err) {
      const target = document.querySelector('[data-error="' + errorKey + '"]');
      if (target) target.textContent = err.message; else document.getElementById("list-error").textContent = err.message;
    }
  }

  function selectFromHash() {
    const match = location.hash.match(/account=(\\d+)/);
    selectedId = match ? match[1] : null;
    loadDetail();
    loadList();
  }

  document.addEventListener("click", (e) => {
    const t = e.target;
    const row = t.closest("[data-account]");
    if (row && !t.closest("a, button")) { location.hash = "account=" + row.dataset.account; return; }
    const tabButton = t.closest("[data-tab]");
    if (tabButton) {
      tab = tabButton.dataset.tab;
      document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b === tabButton)));
      loadList();
      return;
    }
    const b = t.closest("button");
    if (!b) return;
    if (b.dataset.userStatus) act("list", () => api("POST", "/api/users/status", { userId: b.dataset.userStatus, status: b.dataset.status }));
    if (b.dataset.accountStatus) act("grant", () => api("POST", "/api/accounts/status", { accountId: selectedId, status: b.dataset.accountStatus }));
    if (b.dataset.transfer) act("members", () => api("POST", "/api/accounts/transfer", { accountId: selectedId, userId: b.dataset.transfer }));
    if (b.dataset.removeMember) act("members", () => api("POST", "/api/accounts/remove-member", { accountId: selectedId, userId: b.dataset.removeMember }));
    if (b.dataset.cancelSub) act("grant", () => api("POST", "/api/subscriptions/cancel", { id: b.dataset.cancelSub }));
  });

  document.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    if (form.id === "search") {
      query = form.elements.q.value;
      loadList();
    } else if (form.id === "grant") {
      const days = form.elements.days.value.trim();
      act("grant", () => api("POST", "/api/accounts/grant", {
        accountId: selectedId,
        planId: form.elements.planId.value,
        periods: Number(form.elements.periods.value),
        days: days ? Number(days) : null,
        amount: Number(form.elements.amount.value || 0),
        currency: form.elements.currency.value.trim().toUpperCase(),
        method: form.elements.method.value,
        note: form.elements.note.value,
      }));
    } else if (form.id === "add-member") {
      act("members", () => api("POST", "/api/accounts/move-user", {
        accountId: selectedId, userId: form.elements.userId.value.trim(), role: form.elements.role.value,
      }));
    }
  });

  window.addEventListener("hashchange", selectFromHash);
  api("GET", "/api/plans").then((p) => { plans = p; selectFromHash(); }).catch((err) => {
    document.getElementById("list-error").textContent = err.message;
  });
  loadOverview();
</script>
</body>
</html>`;
