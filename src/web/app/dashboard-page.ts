import { BASE_STYLES, BASE_SCRIPT, PAGE_HEAD, MENU_BUTTON } from "../styles.js";

// Pages of the user app. They share one layout and one script: everything is rendered from
// GET /api/me, every change returns the updated state, and each renderer only fills the
// sections present on the current page.

export type UserPage = "filters" | "subscription" | "members" | "notifications";

export const USER_PAGE_PATHS: Record<string, UserPage> = {
  "/": "filters",
  "/subscription": "subscription",
  "/members": "members",
  "/notifications": "notifications",
};

const NAV: [string, UserPage, string][] = [
  ["/", "filters", "Фільтри"],
  ["/subscription", "subscription", "Підписка"],
  ["/members", "members", "Учасники"],
  ["/notifications", "notifications", "Сповіщення"],
];

const SECTIONS: Record<UserPage, { title: string; html: string }> = {
  filters: {
    title: "Фільтри",
    html: `  <fieldset id="filters">
  <div class="grid">
    <section class="card">
      <h2>Кількість кімнат</h2>
      <p class="hint">Пости з іншою кількістю кімнат не надсилаються. Якщо кімнати не вказано або пост не вдалося розібрати, він надсилається.</p>
      <div class="toggles" id="rooms">
        <button class="toggle" type="button" data-rooms="1" aria-pressed="false">1</button>
        <button class="toggle" type="button" data-rooms="2" aria-pressed="false">2</button>
        <button class="toggle" type="button" data-rooms="3" aria-pressed="false">3</button>
        <button class="toggle" type="button" data-rooms="4" aria-pressed="false">4+</button>
      </div>
      <p class="status" id="rooms-status"></p>
      <p class="error" data-error="rooms"></p>
    </section>
    <section class="card">
      <h2>Поверх</h2>
      <p class="hint">Порожнє поле — без обмеження.</p>
      <form class="row" data-kind="floor">
        <input name="min" type="number" step="1" placeholder="від" aria-label="Мінімальний поверх">
        <input name="max" type="number" step="1" placeholder="до" aria-label="Максимальний поверх">
        <button type="submit">Зберегти</button>
      </form>
      <p class="error" data-error="floor"></p>
      <p class="status" id="floor-status"></p>
    </section>
    <section class="card">
      <h2>Ціна</h2>
      <p class="hint">Ціни в інших валютах перераховуються за курсом НБУ. Порожнє поле — без обмеження.</p>
      <form class="row" data-kind="price">
        <input name="min" type="number" min="0" step="any" placeholder="від" aria-label="Мінімальна ціна">
        <input name="max" type="number" min="0" step="any" placeholder="до" aria-label="Максимальна ціна">
        <select name="currency" aria-label="Валюта">
          <option value="UAH">₴</option>
          <option value="USD">$</option>
          <option value="EUR">€</option>
        </select>
        <button type="submit">Зберегти</button>
      </form>
      <p class="error" data-error="price"></p>
      <p class="status" id="price-status"></p>
    </section>
  </div>
  <div class="grid">
    <section class="card">
      <h2>Ключові слова</h2>
      <p class="hint">Пост підходить, якщо містить будь-яке з ключових слів (регістр не важливий): район, вулицю, ЖК… Можна вставити кілька через кому.</p>
      <form class="row" data-kind="keywords">
        <input name="value" placeholder="напр. оболонь" aria-label="Нове ключове слово" required>
        <button type="submit">Додати</button>
      </form>
      <p class="error" data-error="keywords"></p>
      <div class="chips" id="keywords"></div>
      <p class="status" id="keywords-status"></p>
    </section>
  </div>
  </fieldset>
  <div class="grid">
    <section class="card">
      <h2>Останні знахідки</h2>
      <div id="matches"><p class="muted">Завантаження…</p></div>
    </section>
  </div>
`,
  },
  subscription: {
    title: "Підписка",
    html: `  <div class="grid">
    <section class="card">
      <h2>Підписка</h2>
      <div id="subscription"><p class="muted">Завантаження…</p></div>
    </section>
  </div>
`,
  },
  members: {
    title: "Учасники",
    html: `  <div class="grid">
    <section class="card">
      <h2>Учасники</h2>
      <p class="hint">Усі учасники отримують сповіщення за фільтрами цього акаунта — зручно, коли житло шукаєте разом.</p>
      <ul class="plain" id="members"></ul>
      <p class="error" data-error="members"></p>
    </section>
    <section class="card">
      <div id="invite"></div>
      <div id="account-actions"></div>
    </section>
  </div>
`,
  },
  notifications: {
    title: "Мої сповіщення",
    html: `  <div class="grid">
    <section class="card">
      <h2>Мої сповіщення</h2>
      <p class="hint">Вмикає чи вимикає сповіщення лише для вас; інші учасники акаунта отримують їх і далі.
        Те саме роблять кнопки «▶️ Підписатися» та «⏹ Зупинити» в боті.</p>
      <div class="row"><button id="notifications" type="button"></button></div>
      <p class="status" id="notifications-status"></p>
      <p class="error" data-error="notifications"></p>
    </section>
    <section class="card">
      <h2>Telegram</h2>
      <p class="hint">Сповіщення надходять у ваш чат із ботом.</p>
      <dl id="bot-status"></dl>
    </section>
  </div>
`,
  },
};

function pageHtml(page: UserPage): string {
  const nav = NAV.map(([href, key, label]) =>
    `<a href="${href}"${key === page ? ' aria-current="page"' : ""}>${label}</a>`
  ).join("");
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SECTIONS[page].title} — сповіщення про оренду</title>
<style>
${BASE_STYLES}
  .invite-link { display: flex; gap: 8px; margin-top: 8px; }
  .invite-link input { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border); }
  ul.plain li:first-child { border-top: none; }
  ul.plain li .grow { flex: 1; min-width: 160px; }
  .match { padding: 10px 0; border-top: 1px solid var(--border); }
  .match:first-child { border-top: none; }
  .match .meta { font-size: 13px; color: var(--muted); }
  .match .text { white-space: pre-wrap; font-size: 14px; margin-top: 4px; }
  fieldset { border: none; margin: 0; padding: 0; min-width: 0; }
  .account { color: var(--muted); font-size: 14px; }
  .match .text { overflow-wrap: anywhere; }
  nav.tabs { display: flex; flex-wrap: wrap; gap: 4px; order: 3; flex-basis: 100%; margin-top: 8px; }
  nav.tabs a { padding: 6px 14px; border-radius: 999px; text-decoration: none; color: var(--text); }
  nav.tabs a:hover { background: var(--chip); }
  nav.tabs a[aria-current="page"] { background: var(--accent); color: var(--accent-text); font-weight: 600; }
</style>
${PAGE_HEAD}
</head>
<body>
<main>
  <header>
    <h1>${SECTIONS[page].title} <span class="account" id="account-name"></span></h1>
    ${MENU_BUTTON}
    <div class="menu" id="menu">
      <nav class="tabs" aria-label="Розділи">${nav}</nav>
      <nav class="user"><span id="who" class="muted"></span><a href="/logout">Вийти</a></nav>
    </div>
  </header>
  <div class="notice" id="notice"></div>
${SECTIONS[page].html}</main>
<script>
${BASE_SCRIPT}
  const ROLES = { owner: "власник", editor: "редактор", viewer: "глядач" };
  let me = null;
  let lastInviteLink = null;

  function showError(kind, message) {
    const el = document.querySelector('[data-error="' + kind + '"]');
    if (el) el.textContent = message || "";
  }

  function renderSubscription() {
    const s = me.subscription;
    const pay = me.payment;
    const payHtml = (pay.instructions ? '<p>' + esc(pay.instructions) + '</p>' : '') +
      (pay.support ? '<p class="muted">Звʼязок: ' + esc(pay.support) + '</p>' : '');
    const card = document.getElementById("subscription");
    if (card) card.innerHTML =
      '<dl><dt>Статус</dt><dd>' + (s.active
        ? '<span class="badge ' + (s.kind === "trial" ? "warn" : "on") + '">' + (s.kind === "trial" ? "пробний період" : "активна") + '</span>'
        : '<span class="badge bad">неактивна</span>') + '</dd>' +
      (s.active ? '<dt>Тариф</dt><dd>' + esc(s.plan.name) + '</dd><dt>Діє до</dt><dd>' + formatDate(s.endsAt, true) +
        ' (' + s.daysLeft + ' дн.)</dd>' : (s.endsAt ? '<dt>Закінчилась</dt><dd>' + formatDate(s.endsAt, true) + '</dd>' : '')) +
      '<dt>Учасники</dt><dd>' + me.members.length + ' з ' + me.limits.maxMembers + '</dd>' +
      '<dt>Ключові слова</dt><dd>' + me.filters.keywords.length + ' з ' + me.limits.maxKeywords + '</dd></dl>' +
      (payHtml ? '<h3>' + (s.active ? "Продовження" : "Як оплатити") + '</h3>' + payHtml : '');

    const notices = [];
    if (me.account.status === "blocked") notices.push("Акаунт заблоковано адміністратором — сповіщення не надсилаються.");
    else if (!s.active) notices.push("Підписка неактивна — сповіщення не надсилаються. Фільтри збережено.");
    if (me.user.botBlocked) notices.push("Ви заблокували бота — розблокуйте його в Telegram, щоб отримувати сповіщення.");
    else if (!me.user.hasChat) notices.push("Напишіть боту /start" + (me.botUsername ? " (@" + me.botUsername + ")" : "") + ", щоб він міг надсилати вам сповіщення.");
    document.getElementById("notice").textContent = notices.join(" ");
  }

  function renderNotifications() {
    const button = document.getElementById("notifications");
    if (!button) return;
    const on = me.user.notificationsEnabled;
    button.textContent = on ? "Вимкнути для мене" : "Увімкнути для мене";
    button.className = on ? "secondary" : "";
    document.getElementById("notifications-status").textContent = on ? "Сповіщення увімкнені." : "Сповіщення вимкнені.";
    const bot = me.botUsername
      ? '<a href="https://t.me/' + encodeURIComponent(me.botUsername) + '" target="_blank" rel="noopener">@' + esc(me.botUsername) + '</a>'
      : "бот";
    document.getElementById("bot-status").innerHTML =
      '<dt>Бот</dt><dd>' + bot + '</dd><dt>Стан</dt><dd>' +
      (me.user.botBlocked ? '<span class="badge bad">ви заблокували бота</span>'
        : !me.user.hasChat ? '<span class="badge warn">напишіть боту /start</span>'
        : '<span class="badge on">може надсилати вам повідомлення</span>') + '</dd>';
  }

  function renderFilters() {
    if (!document.getElementById("filters")) return;
    const f = me.filters;
    document.getElementById("filters").disabled = !me.can.editFilters;
    document.getElementById("keywords").innerHTML = f.keywords.length
      ? f.keywords.map((k) =>
          '<span class="chip"><span>' + esc(k) + '</span>' +
          (me.can.editFilters ? '<button class="remove" data-kind="keywords" data-value="' + esc(k) + '" aria-label="Видалити ' + esc(k) + '">×</button>' : '') +
          '</span>').join("")
      : '<p class="empty">Немає ключових слів — жоден пост не підійде.</p>';
    document.getElementById("keywords-status").textContent = me.can.editFilters ? "" : "Змінювати фільтри можуть власник і редактори.";

    for (const button of document.querySelectorAll("[data-rooms]")) {
      button.setAttribute("aria-pressed", String(f.rooms.includes(Number(button.dataset.rooms))));
    }
    document.getElementById("rooms-status").textContent = f.rooms.length
      ? "Надсилаються пости з кімнатами: " + f.rooms.map((r) => r === 4 ? "4+" : r).join(", ")
      : "Нічого не вибрано — підходить будь-яка кількість кімнат.";

    const floorForm = document.querySelector('form[data-kind="floor"]');
    floorForm.elements.min.value = f.floor.min ?? "";
    floorForm.elements.max.value = f.floor.max ?? "";
    const { min, max } = f.floor;
    document.getElementById("floor-status").textContent =
      min !== null && max !== null ? "Поверх від " + min + " до " + max + "."
      : min !== null ? "Поверх від " + min + "."
      : max !== null ? "Поверх до " + max + "."
      : "Без обмеження — підходить будь-який поверх.";

    const priceForm = document.querySelector('form[data-kind="price"]');
    const price = f.price;
    priceForm.elements.min.value = price.min ?? "";
    priceForm.elements.max.value = price.max ?? "";
    priceForm.elements.currency.value = price.currency;
    document.getElementById("price-status").textContent =
      price.min !== null && price.max !== null ? "Ціна від " + money(price.min, price.currency) + " до " + money(price.max, price.currency) + "."
      : price.min !== null ? "Ціна від " + money(price.min, price.currency) + "."
      : price.max !== null ? "Ціна до " + money(price.max, price.currency) + "."
      : "Без обмеження — підходить будь-яка ціна.";
  }

  function renderMembers() {
    if (!document.getElementById("members")) return;
    document.getElementById("members").innerHTML = me.members.map((m) => {
      const isMe = m.userId === me.user.id;
      const role = me.can.manageMembers && m.role !== "owner"
        ? '<select data-role-for="' + m.userId + '" aria-label="Роль">' +
          ['editor', 'viewer'].map((r) => '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + ROLES[r] + '</option>').join("") + '</select>'
        : '<span class="muted">' + ROLES[m.role] + '</span>';
      return '<li><span class="grow">' + esc(m.name) + (isMe ? ' <span class="muted">(ви)</span>' : '') +
        (m.botBlocked ? ' <span class="badge bad">заблокував бота</span>' : !m.notificationsEnabled ? ' <span class="badge off">сповіщення вимк.</span>' : '') +
        '</span>' + role +
        (me.can.manageMembers && m.role !== "owner" ? '<button class="small danger" data-remove-member="' + m.userId + '">Видалити</button>' : '') + '</li>';
    }).join("");

    const full = me.members.length >= me.limits.maxMembers;
    document.getElementById("invite").innerHTML = !me.can.invite ? '' :
      '<h3>Запросити</h3>' +
      (full ? '<p class="hint">Досягнуто ліміту учасників вашого тарифу (' + me.limits.maxMembers + ').</p>' :
        '<p class="hint">Створіть посилання й надішліть його в Telegram. Воно одноразове й діє 7 днів. Посилання показується лише раз — скопіюйте його одразу.</p>' +
        '<div class="row"><select id="invite-role" aria-label="Роль"><option value="editor">редактор — може змінювати фільтри</option>' +
        '<option value="viewer">глядач — лише отримує сповіщення</option></select>' +
        '<button type="button" id="create-invite">Створити посилання</button></div>') +
      (lastInviteLink ? '<div class="invite-link"><input readonly value="' + esc(lastInviteLink) + '" aria-label="Посилання-запрошення">' +
        '<button type="button" class="secondary" id="copy-invite">Копіювати</button></div>' : '') +
      (me.invites.length ? '<h3>Активні запрошення</h3><ul class="plain">' + me.invites.map((i) =>
        '<li><span class="grow">' + ROLES[i.role] + ' · до ' + formatDate(i.expiresAt) + '</span>' +
        '<button class="small danger" data-revoke="' + i.id + '">Скасувати</button></li>').join("") + '</ul>' : '') +
      '<p class="error" data-error="invite"></p>';

    document.getElementById("account-actions").innerHTML =
      (me.can.rename ? '<h3>Назва акаунта</h3><form class="row" id="rename"><input name="name" maxlength="60" value="' + esc(me.account.name) +
        '" aria-label="Назва акаунта"><button type="submit" class="secondary">Зберегти</button></form><p class="error" data-error="rename"></p>' : '') +
      (me.account.role !== "owner" ? '<h3>Вийти з акаунта</h3><p class="hint">Ви перестанете отримувати сповіщення цього акаунта.</p>' +
        '<div class="row"><button type="button" class="danger" id="leave">Покинути «' + esc(me.account.name) + '»</button></div><p class="error" data-error="leave"></p>' : '');
  }

  function render(data) {
    me = data;
    document.getElementById("account-name").textContent = me.account.name;
    document.getElementById("who").textContent = me.user.name + " · " + ROLES[me.account.role];
    renderSubscription();
    renderNotifications();
    renderFilters();
    renderMembers();
  }

  async function loadMatches() {
    if (!document.getElementById("matches")) return;
    try {
      const matches = await api("GET", "/api/matches");
      document.getElementById("matches").innerHTML = matches.length === 0
        ? '<p class="empty">Поки нічого. Нові оголошення за вашими фільтрами зʼявляться тут і в Telegram.</p>'
        : matches.map((m) => '<div class="match"><div class="meta">' + formatDate(m.sentAt, true) + ' · ' + esc(m.channelTitle) +
            ' · <a href="' + esc(m.messageLink) + '" target="_blank" rel="noopener">відкрити</a></div>' +
            '<div class="text">' + esc(m.preview) + (m.preview.length >= 300 ? '…' : '') + '</div></div>').join("");
    } catch (err) {
      document.getElementById("matches").innerHTML = '<p class="error">' + esc(err.message) + '</p>';
    }
  }

  async function change(errorKey, fn) {
    showError(errorKey, "");
    try {
      render(await fn());
    } catch (err) {
      showError(errorKey, err.message);
    }
  }

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.dataset.kind;
    if (form.id === "rename") return change("rename", () => api("PUT", "/api/account/name", { name: form.elements.name.value }));
    if (kind === "floor" || kind === "price") {
      const toNumber = (input) => input.value.trim() === "" ? null : Number(input.value);
      const value = { min: toNumber(form.elements.min), max: toNumber(form.elements.max) };
      if (form.elements.currency) value.currency = form.elements.currency.value;
      return change(kind, () => api("PUT", "/api/" + kind, { value }));
    }
    if (kind === "keywords") {
      const input = form.elements.value;
      const values = input.value.split(/[,\\n]/).map((v) => v.trim()).filter(Boolean);
      showError("keywords", "");
      const failed = [];
      for (const value of values) {
        try {
          render(await api("POST", "/api/keywords", { value }));
        } catch (err) {
          failed.push({ value, message: err.message });
        }
      }
      showError("keywords", failed.map((f) => f.value + ": " + f.message).join("; "));
      input.value = failed.map((f) => f.value).join(", ");
      input.focus();
    }
  });

  document.addEventListener("change", (e) => {
    const select = e.target.closest("[data-role-for]");
    if (select) change("members", () => api("PUT", "/api/members/role", { userId: select.dataset.roleFor, role: select.value }));
  });

  document.addEventListener("click", async (e) => {
    const t = e.target;
    const roomButton = t.closest("[data-rooms]");
    if (roomButton) {
      roomButton.setAttribute("aria-pressed", String(roomButton.getAttribute("aria-pressed") !== "true"));
      const rooms = [...document.querySelectorAll("[data-rooms]")]
        .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => Number(b.dataset.rooms));
      return change("rooms", () => api("PUT", "/api/rooms", { value: rooms }));
    }
    const remove = t.closest(".remove");
    if (remove) return change("keywords", () => api("DELETE", "/api/keywords", { value: remove.dataset.value }));
    if (t.id === "notifications") return change("notifications", () => api("PUT", "/api/notifications", { enabled: !me.user.notificationsEnabled }));
    if (t.dataset.removeMember) return change("members", () => api("DELETE", "/api/members", { userId: t.dataset.removeMember }));
    if (t.dataset.revoke) return change("invite", () => api("DELETE", "/api/invites", { id: t.dataset.revoke }));
    if (t.id === "create-invite") {
      showError("invite", "");
      try {
        const result = await api("POST", "/api/invites", { role: document.getElementById("invite-role").value });
        lastInviteLink = result.link;
        render(result.me);
      } catch (err) {
        showError("invite", err.message);
      }
      return;
    }
    if (t.id === "copy-invite") {
      const input = t.previousElementSibling;
      input.select();
      navigator.clipboard?.writeText(input.value).then(() => (t.textContent = "Скопійовано"), () => {});
      return;
    }
    if (t.id === "leave") {
      if (t.dataset.confirm !== "yes") {
        t.dataset.confirm = "yes";
        t.textContent = "Точно покинути? Натисніть ще раз";
        return;
      }
      showError("leave", "");
      try {
        await api("POST", "/api/leave", {});
        location.reload();
      } catch (err) {
        showError("leave", err.message);
      }
    }
  });

  api("GET", "/api/me").then(render).catch((err) => {
    document.getElementById("notice").textContent = "Не вдалося завантажити дані: " + err.message;
  });
  loadMatches();
</script>
</body>
</html>`;
}

export const USER_PAGES_HTML = Object.fromEntries(
  (Object.keys(SECTIONS) as UserPage[]).map((page) => [page, pageHtml(page)])
) as Record<UserPage, string>;
