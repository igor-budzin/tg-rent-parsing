import { ADMIN_NAV } from "./nav.js";
import { BASE_STYLES, BASE_SCRIPT, PAGE_HEAD } from "../styles.js";

// Plans (price, duration, limits) and the admins who can use this app

export const PLANS_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Тарифи</title>
<style>
${BASE_STYLES}
  td input, td select { width: 100%; min-width: 64px; padding: 4px 8px; }
</style>
${PAGE_HEAD}
</head>
<body>
<main>
  <header>
    <h1>Тарифи й адміністратори</h1>
    ${ADMIN_NAV}
  </header>
  <section class="card">
    <h2>Тарифи</h2>
    <p class="hint">Тариф «trial» дається новим користувачам один раз (тривалість — змінна TRIAL_DAYS); його ліміти діють і для акаунтів без підписки.
      Зміни цін не зачіпають уже оплачені періоди. Вимкнений тариф не можна вибрати для нових оплат.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Код</th><th>Назва</th><th>Ціна</th><th>Валюта</th><th>Днів</th><th>Учасників</th><th>Ключ. слів</th><th>Активний</th><th></th></tr></thead>
      <tbody id="plans"></tbody>
    </table></div>
    <p class="error" id="plans-error"></p>
  </section>
  <div class="grid">
    <section class="card">
      <h2>Адміністратори</h2>
      <p class="hint">Власники керують адміністраторами й входом читача Telegram; решту можуть усі адміністратори.</p>
      <div class="table-wrap"><table><thead><tr><th>Логін</th><th>Роль</th><th>2FA</th><th>Останній вхід</th><th></th></tr></thead><tbody id="admins"></tbody></table></div>
      <p class="error" data-error="admins"></p>
      <div id="add-admin-block" hidden>
        <h3>Додати адміністратора</h3>
        <form class="row" id="add-admin">
          <input name="login" placeholder="Логін" aria-label="Логін" required>
          <input name="password" type="password" autocomplete="new-password" placeholder="Пароль (від 10 символів)" aria-label="Пароль" required>
          <button type="submit">Додати</button>
        </form>
        <p class="error" data-error="add-admin"></p>
      </div>
    </section>
    <section class="card">
      <h2>Мій пароль</h2>
      <p class="hint">Після зміни всі ваші сесії завершаться, і потрібно буде увійти знову.</p>
      <form class="row" id="password">
        <input name="password" type="password" autocomplete="new-password" placeholder="Новий пароль" aria-label="Новий пароль" required>
        <button type="submit">Змінити</button>
      </form>
      <p class="error" data-error="password"></p>
      <h2>Двофакторний вхід</h2>
      <div id="totp"></div>
      <p class="error" data-error="totp"></p>
    </section>
  </div>
</main>
<script>
${BASE_SCRIPT}
  const FIELDS = [
    ["code", "text"], ["name", "text"], ["price", "number"], ["currency", "text"],
    ["durationDays", "number"], ["maxMembers", "number"], ["maxKeywords", "number"],
  ];

  function planRow(p) {
    return '<tr data-id="' + esc(p.id || "") + '">' + FIELDS.map(([key, type]) =>
      '<td><input name="' + key + '" type="' + type + '" value="' + esc(p[key] ?? "") + '"' + (type === "number" ? ' min="0" step="any"' : '') + '></td>').join("") +
      '<td><input name="active" type="checkbox"' + (p.active !== false ? ' checked' : '') + '></td>' +
      '<td><button class="small" data-save>' + (p.id ? "Зберегти" : "Створити") + '</button></td></tr>';
  }

  async function loadPlans() {
    const plans = await api("GET", "/api/plans");
    document.getElementById("plans").innerHTML = plans.map(planRow).join("") +
      planRow({ code: "", name: "", price: 0, currency: "UAH", durationDays: 30, maxMembers: 4, maxKeywords: 30, active: true });
  }

  const ADMIN_ROLES = { owner: "власник", admin: "адміністратор" };
  let totpSetup = null;

  function adminActions(a, me) {
    if (me.role !== "owner" || a.id === me.id) return a.id === me.id ? '<span class="muted">ви</span>' : '';
    return '<div class="row">' +
      '<button class="small secondary" data-admin-role="' + esc(a.id) + '" data-role="' + (a.role === "owner" ? "admin" : "owner") + '">' +
        (a.role === "owner" ? "Зробити адміністратором" : "Зробити власником") + '</button>' +
      '<button class="small ' + (a.disabled ? "secondary" : "danger") + '" data-admin-disabled="' + esc(a.id) + '" data-disabled="' + !a.disabled + '">' +
        (a.disabled ? "Увімкнути" : "Вимкнути") + '</button>' +
      (a.totpEnabled ? '<button class="small secondary" data-totp-reset="' + esc(a.id) + '">Скинути 2FA</button>' : '') +
      '</div>';
  }

  function renderTotp(me) {
    const el = document.getElementById("totp");
    if (me.totpEnabled) {
      el.innerHTML = '<p><span class="badge on">увімкнено</span> Під час входу потрібен код із застосунку.</p>' +
        '<form class="row" id="totp-disable"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="Код" aria-label="Код" required>' +
        '<button type="submit" class="secondary">Вимкнути</button></form>';
    } else if (totpSetup) {
      el.innerHTML = '<p class="hint">Відскануйте QR-код у Google Authenticator, 1Password чи іншому застосунку, потім введіть код, який він показує.</p>' +
        '<img src="' + esc(totpSetup.qrDataUrl) + '" alt="QR-код для застосунку автентифікації" width="200" height="200">' +
        '<p class="hint">Або введіть ключ вручну: <span class="mono">' + esc(totpSetup.secret) + '</span></p>' +
        '<form class="row" id="totp-enable"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="Код" aria-label="Код" required>' +
        '<button type="submit">Підтвердити</button></form>';
    } else {
      el.innerHTML = '<p><span class="badge warn">вимкнено</span> Увімкніть, щоб для входу, крім пароля, був потрібен код із телефона.</p>' +
        '<button type="button" id="totp-setup">Налаштувати</button>';
    }
  }

  async function loadAdmins() {
    const { me, admins } = await api("GET", "/api/admins");
    document.getElementById("add-admin-block").hidden = me.role !== "owner";
    document.getElementById("admins").innerHTML = admins.map((a) =>
      '<tr><td>' + esc(a.login) + (a.disabled ? ' <span class="badge bad">вимкнено</span>' : '') + '</td>' +
      '<td>' + ADMIN_ROLES[a.role] + '</td>' +
      '<td>' + (a.totpEnabled ? '<span class="badge on">так</span>' : '<span class="badge warn">ні</span>') + '</td>' +
      '<td>' + formatDate(a.lastLoginAt, true) + '</td><td>' + adminActions(a, me) + '</td></tr>').join("");
    renderTotp(me);
  }

  async function adminAction(errorKey, fn) {
    const errorEl = document.querySelector('[data-error="' + errorKey + '"]');
    errorEl.textContent = "";
    try {
      await fn();
      await loadAdmins();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.adminRole) adminAction("admins", () => api("POST", "/api/admins/role", { adminId: b.dataset.adminRole, role: b.dataset.role }));
    if (b.dataset.adminDisabled) adminAction("admins", () => api("POST", "/api/admins/disabled", { adminId: b.dataset.adminDisabled, disabled: b.dataset.disabled === "true" }));
    if (b.dataset.totpReset) adminAction("admins", () => api("POST", "/api/admins/totp/reset", { adminId: b.dataset.totpReset }));
    if (b.id === "totp-setup") adminAction("totp", async () => { totpSetup = await api("POST", "/api/admins/totp/setup", {}); });
  });

  document.addEventListener("click", async (e) => {
    const button = e.target.closest("[data-save]");
    if (!button) return;
    const row = button.closest("tr");
    const body = { id: row.dataset.id || null, active: row.querySelector('[name="active"]').checked };
    for (const [key, type] of FIELDS) {
      const value = row.querySelector('[name="' + key + '"]').value.trim();
      body[key] = type === "number" ? Number(value) : value;
    }
    document.getElementById("plans-error").textContent = "";
    button.disabled = true;
    try {
      await api("POST", "/api/plans", body);
      await loadPlans();
    } catch (err) {
      document.getElementById("plans-error").textContent = err.message;
      button.disabled = false;
    }
  });

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = document.querySelector('[data-error="' + (form.id.startsWith("totp") ? "totp" : form.id) + '"]');
    errorEl.textContent = "";
    try {
      if (form.id === "add-admin") {
        await api("POST", "/api/admins", { login: form.elements.login.value.trim(), password: form.elements.password.value });
        form.reset();
        await loadAdmins();
      } else if (form.id === "password") {
        await api("POST", "/api/admins/password", { password: form.elements.password.value });
        location.href = "/login";
      } else if (form.id === "totp-enable" || form.id === "totp-disable") {
        await api("POST", "/api/admins/totp/" + (form.id === "totp-enable" ? "enable" : "disable"), { code: form.elements.code.value });
        totpSetup = null;
        await loadAdmins();
      }
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  loadPlans().catch((err) => (document.getElementById("plans-error").textContent = err.message));
  loadAdmins().catch((err) => (document.querySelector('[data-error="admins"]').textContent = err.message));
</script>
</body>
</html>`;
