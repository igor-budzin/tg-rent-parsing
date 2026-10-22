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
      <div class="table-wrap"><table><thead><tr><th>Логін</th><th>Створено</th><th>Останній вхід</th></tr></thead><tbody id="admins"></tbody></table></div>
      <h3>Додати адміністратора</h3>
      <form class="row" id="add-admin">
        <input name="login" placeholder="Логін" aria-label="Логін" required>
        <input name="password" type="password" autocomplete="new-password" placeholder="Пароль (від 10 символів)" aria-label="Пароль" required>
        <button type="submit">Додати</button>
      </form>
      <p class="error" data-error="add-admin"></p>
    </section>
    <section class="card">
      <h2>Мій пароль</h2>
      <p class="hint">Після зміни всі ваші сесії завершаться, і потрібно буде увійти знову.</p>
      <form class="row" id="password">
        <input name="password" type="password" autocomplete="new-password" placeholder="Новий пароль" aria-label="Новий пароль" required>
        <button type="submit">Змінити</button>
      </form>
      <p class="error" data-error="password"></p>
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

  async function loadAdmins() {
    const admins = await api("GET", "/api/admins");
    document.getElementById("admins").innerHTML = admins.map((a) =>
      '<tr><td>' + esc(a.login) + '</td><td>' + formatDate(a.createdAt) + '</td><td>' + formatDate(a.lastLoginAt, true) + '</td></tr>').join("");
  }

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
    const errorEl = document.querySelector('[data-error="' + form.id + '"]');
    errorEl.textContent = "";
    try {
      if (form.id === "add-admin") {
        await api("POST", "/api/admins", { login: form.elements.login.value.trim(), password: form.elements.password.value });
        form.reset();
        await loadAdmins();
      } else if (form.id === "password") {
        await api("POST", "/api/admins/password", { password: form.elements.password.value });
        location.href = "/login";
      }
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  loadPlans().catch((err) => (document.getElementById("plans-error").textContent = err.message));
  loadAdmins().catch(() => {});
</script>
</body>
</html>`;
