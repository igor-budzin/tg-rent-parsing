export const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вхід — Парсер оренди</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #65676b;
    --border: #dadde1; --accent: #2481cc; --accent-text: #fff; --error: #c62828; --ok: #2e7d32;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab;
      --border: #3a3d42; --accent: #3a9ce0; --accent-text: #fff; --error: #ef6b6b; --ok: #6bc46f;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card {
    width: 100%; max-width: 380px; background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
  .error { color: var(--error); font-size: 13px; margin: 0 0 12px; }
  .ok { color: var(--ok); font-weight: 600; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input {
    width: 100%; padding: 10px 12px; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px;
  }
  button {
    width: 100%; padding: 10px 12px; font: inherit; font-weight: 600; border-radius: 8px;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text); cursor: pointer;
  }
  button.secondary { background: transparent; color: var(--accent); margin-top: 8px; }
  button:disabled { opacity: .6; cursor: default; }
  .divider { text-align: center; color: var(--muted); font-size: 13px; margin: 16px 0; }
  .qr { display: block; width: 240px; height: 240px; margin: 0 auto 12px; border-radius: 8px; background: #fff; padding: 8px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main class="card" id="app"><p class="muted">Завантаження…</p></main>
<script>
  const app = document.getElementById("app");
  let renderedKey = "";

  async function api(path, body) {
    // Absolute URL without credentials: fetch() rejects relative URLs on a page opened as user:pass@host
    const res = await fetch(location.origin + path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  function errorHtml(s) {
    return s.error ? '<p class="error">' + esc(s.error) + "</p>" : "";
  }

  const views = {
    connecting: (s) => '<h1>Підключення…</h1><p class="muted">Зʼєднуємося з Telegram, зачекайте.</p>' + errorHtml(s),

    needs_login: (s) => '<h1>Вхід у Telegram</h1>' +
      '<p class="muted">Парсеру потрібен акаунт Telegram, щоб читати канали.</p>' + errorHtml(s) +
      '<button data-action="qr">Увійти за QR-кодом</button>' +
      '<div class="divider">або</div>' +
      '<form data-form="phone"><label for="phone">Номер телефону</label>' +
      '<input id="phone" name="value" type="tel" placeholder="+380XXXXXXXXX" required autocomplete="tel">' +
      '<button type="submit">Надіслати код</button></form>',

    qr: (s) => '<h1>Відскануйте QR-код</h1>' +
      '<p class="muted">Telegram → Налаштування → Пристрої → Підключити пристрій. Код оновлюється кожні 30 с.</p>' +
      errorHtml(s) +
      (s.qrDataUrl ? '<img class="qr" alt="QR-код для входу в Telegram" src="' + s.qrDataUrl + '">' : '<p class="muted">Створюємо QR-код…</p>') +
      '<button class="secondary" data-action="cancel">Скасувати</button>',

    code: (s) => '<h1>Введіть код входу</h1>' +
      '<p class="muted">Telegram надіслав код у застосунок або SMS.</p>' + errorHtml(s) +
      '<form data-form="submit"><label for="code">Код</label>' +
      '<input id="code" name="value" inputmode="numeric" autocomplete="one-time-code" required autofocus>' +
      '<button type="submit">Увійти</button></form>' +
      '<button class="secondary" data-action="cancel">Скасувати</button>',

    password: (s) => '<h1>Двоетапна перевірка</h1>' +
      '<p class="muted">' + (s.passwordHint ? "Підказка: " + esc(s.passwordHint) : "Введіть хмарний пароль.") + '</p>' +
      errorHtml(s) +
      '<form data-form="submit"><label for="password">Пароль</label>' +
      '<input id="password" name="value" type="password" autocomplete="current-password" required autofocus>' +
      '<button type="submit">Увійти</button></form>' +
      '<button class="secondary" data-action="cancel">Скасувати</button>',

    logged_in: (s) => '<h1 class="ok">Парсер працює</h1>' +
      '<p class="muted">Вхід виконано, стежимо за новими повідомленнями.</p>' +
      '<dl><dt>Акаунт</dt><dd>' + accountHtml() + '</dd>' +
      '<dt>Підписники</dt><dd><a href="/subscribers">' + (s.subscribers ?? "—") + ' — переглянути список</a></dd>' +
      '<dt>Відстеження</dt><dd><a href="/settings">Ключові слова й канали</a></dd></dl>',
  };

  // Telegram account the app is logged in as, fetched live once per page load
  let account = { status: "idle" };
  let lastState = null;

  function accountHtml() {
    if (account.status === "done") {
      const a = account.data;
      return esc(a.name || "—") +
        (a.username ? ' <a href="https://t.me/' + encodeURIComponent(a.username) + '" target="_blank" rel="noopener">@' + esc(a.username) + '</a>' : '') +
        '<div class="muted" style="margin:0;font-size:12px">' +
        (a.phone ? '<a href="tel:' + esc(a.phone) + '">' + esc(a.phone) + '</a> · ' : '') + 'ID ' + esc(a.id) + '</div>';
    }
    if (account.status === "error") return '<span class="error">' + esc(account.error) + '</span>';
    return '<span class="muted">Завантаження…</span>';
  }

  async function loadAccount() {
    account = { status: "loading" };
    try {
      account = { status: "done", data: await api("/api/account") };
    } catch (e) {
      account = { status: "error", error: e.message };
    }
    if (lastState) render(lastState);
  }

  function render(s) {
    lastState = s;
    if (s.status === "logged_in" && account.status === "idle") loadAccount();
    // Re-render only when something visible changes, so typing isn't interrupted
    const key = JSON.stringify({ ...s, subscribers: s.status === "logged_in" ? s.subscribers : null, account });
    if (key === renderedKey) return;
    renderedKey = key;
    app.innerHTML = (views[s.status] || views.connecting)(s);
  }

  async function refresh() {
    try {
      render(await api("/api/state"));
    } catch (e) {
      render({ status: "connecting", error: e.message });
    }
  }

  async function run(action, button) {
    if (button) button.disabled = true;
    try {
      await action();
    } catch (e) {
      alert(e.message);
    }
    renderedKey = "";
    await refresh();
  }

  app.addEventListener("click", (e) => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    run(() => action === "qr" ? api("/api/login", { method: "qr" }) : api("/api/cancel", {}), button);
  });

  app.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const value = form.elements.value.value;
    const button = form.querySelector("button");
    run(() => form.dataset.form === "phone"
      ? api("/api/login", { method: "phone", phone: value })
      : api("/api/submit", { value }), button);
  });

  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
