export const SETTINGS_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Налаштування парсера</title>
<style>
  :root {
    --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #65676b; --border: #dadde1;
    --accent: #2481cc; --accent-text: #fff; --chip: #e8f1fa; --error: #c62828; --error-bg: #fdecea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab; --border: #3a3d42;
      --accent: #3a9ce0; --accent-text: #fff; --chip: #1e3347; --error: #ef6b6b; --error-bg: #3a2222;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1280px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  nav { display: flex; gap: 16px; font-size: 14px; }
  a { color: var(--accent); }
  .intro { color: var(--muted); font-size: 14px; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
  .grid + .grid { margin-top: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; min-width: 0; }
  .hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  form { display: flex; gap: 8px; margin-bottom: 12px; }
  input, select {
    flex: 1; min-width: 0; padding: 8px 12px; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
  }
  select { flex: none; padding: 8px; }
  button.add {
    padding: 8px 16px; font: inherit; font-weight: 600; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text);
  }
  button:disabled { opacity: .6; cursor: default; }
  .error { color: var(--error); font-size: 13px; margin: -4px 0 12px; }
  .error:empty { display: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 10px;
    background: var(--chip); border-radius: 999px; font-size: 14px; max-width: 100%;
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove {
    border: none; background: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1;
    padding: 2px 6px; border-radius: 999px;
  }
  .remove:hover { color: var(--error); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid var(--border); }
  li:first-child { border-top: none; }
  .avatar {
    flex: none; width: 40px; height: 40px; border-radius: 50%; object-fit: cover;
    display: grid; place-items: center; background: var(--chip); color: var(--accent); font-weight: 600;
  }
  .channel { flex: 1; min-width: 0; }
  .channel .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .channel .name { font-size: 13px; color: var(--muted); }
  .badge { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--error-bg); color: var(--error); }
  .empty { color: var(--muted); font-size: 14px; }
  .toggles { display: flex; flex-wrap: wrap; gap: 8px; }
  .toggle {
    min-width: 52px; padding: 8px 14px; font: inherit; font-weight: 600; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
  }
  .toggle[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
  .status { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Налаштування парсера</h1>
    <nav><a href="/">Статус</a><a href="/subscribers">Підписники</a><a href="/failures">Помилки AI</a></nav>
  </header>
  <p class="intro">Зміни застосовуються одразу, перезапуск не потрібен.</p>
  <div class="grid">
    <section class="card">
      <h2>Кількість кімнат</h2>
      <p class="hint">AI визначає кількість кімнат у пості. Якщо вона не підходить, пост не надсилається. Пости, які AI не зміг розібрати або де кімнати не вказано, надсилаються як є.</p>
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
      <p class="hint">Пости з поверхом поза діапазоном не надсилаються. Порожнє поле — без обмеження. Пости, які AI не зміг розібрати або де поверх не вказано, надсилаються як є.</p>
      <form data-kind="floor">
        <input name="min" type="number" step="1" placeholder="від" aria-label="Мінімальний поверх">
        <input name="max" type="number" step="1" placeholder="до" aria-label="Максимальний поверх">
        <button class="add" type="submit">Зберегти</button>
      </form>
      <p class="error" data-error="floor"></p>
      <p class="status" id="floor-status"></p>
    </section>
    <section class="card">
      <h2>Ціна</h2>
      <p class="hint">Ціни в інших валютах перераховуються за курсом НБУ. Порожнє поле — без обмеження. Пости, які AI не зміг розібрати або де ціну не вказано, надсилаються як є.</p>
      <form data-kind="price">
        <input name="min" type="number" min="0" step="any" placeholder="від" aria-label="Мінімальна ціна">
        <input name="max" type="number" min="0" step="any" placeholder="до" aria-label="Максимальна ціна">
        <select name="currency" aria-label="Валюта">
          <option value="UAH">₴</option>
          <option value="USD">$</option>
          <option value="EUR">€</option>
        </select>
        <button class="add" type="submit">Зберегти</button>
      </form>
      <p class="error" data-error="price"></p>
      <p class="status" id="price-status"></p>
    </section>
  </div>
  <div class="grid">
    <section class="card">
      <h2>Ключові слова</h2>
      <p class="hint">Повідомлення підходить, якщо містить будь-яке ключове слово (регістр не важливий). Можна вставити кілька через кому.</p>
      <form data-kind="keywords">
        <input name="value" placeholder="напр. оболонь" aria-label="Нове ключове слово" required>
        <button class="add" type="submit">Додати</button>
      </form>
      <p class="error" data-error="keywords"></p>
      <div class="chips" id="keywords"></div>
    </section>
    <section class="card">
      <h2>Канали</h2>
      <p class="hint">Юзернейм, посилання t.me або числовий ID. Щоб отримувати нові пости, акаунт має бути учасником каналу.</p>
      <form data-kind="channels">
        <input name="value" placeholder="напр. orenda_kvatir" aria-label="Новий канал" required>
        <button class="add" type="submit">Додати</button>
      </form>
      <p class="error" data-error="channels"></p>
      <ul id="channels"></ul>
    </section>
  </div>
</main>
<script>
  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  async function api(method, path, body) {
    const res = await fetch(location.origin + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function render(config) {
    document.getElementById("keywords").innerHTML = config.keywords.length
      ? config.keywords.map((k) =>
          '<span class="chip"><span>' + esc(k) + '</span>' +
          '<button class="remove" data-kind="keywords" data-value="' + esc(k) + '" aria-label="Видалити ' + esc(k) + '">×</button></span>'
        ).join("")
      : '<p class="empty">Немає ключових слів — жодне повідомлення не підійде.</p>';

    document.getElementById("channels").innerHTML = config.channels.length
      ? config.channels.map((c) => {
          const link = /^-?\\d+$/.test(c.name) ? esc(c.name)
            : '<a href="https://t.me/' + encodeURIComponent(c.name) + '" target="_blank" rel="noopener">@' + esc(c.name) + '</a>';
          const initial = esc(Array.from(c.title || c.name)[0]?.toUpperCase());
          const avatar = c.photoId
            ? '<img class="avatar" alt="" loading="lazy" data-initial="' + initial + '" src="/api/channels/photo?name=' +
              encodeURIComponent(c.name) + '&v=' + encodeURIComponent(c.photoId) + '">'
            : '<span class="avatar" aria-hidden="true">' + initial + '</span>';
          return '<li>' + avatar + '<div class="channel"><div class="title">' + (c.title ? esc(c.title) : esc(c.name)) + '</div>' +
            '<div class="name">' + link + '</div></div>' +
            (c.error ? '<span class="badge" title="' + esc(c.error) + '">Не знайдено</span>' : '') +
            '<button class="remove" data-kind="channels" data-value="' + esc(c.name) + '" aria-label="Видалити ' + esc(c.name) + '">×</button></li>';
        }).join("")
      : '<li class="empty">Немає каналів — нічого не відстежується.</li>';

    for (const button of document.querySelectorAll("[data-rooms]")) {
      button.setAttribute("aria-pressed", String(config.rooms.includes(Number(button.dataset.rooms))));
    }
    document.getElementById("rooms-status").textContent = config.rooms.length
      ? "Надсилаються пости з кімнатами: " + config.rooms.map((r) => r === 4 ? "4+" : r).join(", ")
      : "Нічого не вибрано — підходить будь-яка кількість кімнат.";

    const floorForm = document.querySelector('form[data-kind="floor"]');
    floorForm.elements.min.value = config.floor.min ?? "";
    floorForm.elements.max.value = config.floor.max ?? "";
    const { min, max } = config.floor;
    document.getElementById("floor-status").textContent =
      min !== null && max !== null ? "Надсилаються пости з поверхом від " + min + " до " + max + "."
      : min !== null ? "Надсилаються пости з поверхом від " + min + "."
      : max !== null ? "Надсилаються пости з поверхом до " + max + "."
      : "Без обмеження — підходить будь-який поверх.";

    const priceForm = document.querySelector('form[data-kind="price"]');
    const price = config.price;
    priceForm.elements.min.value = price.min ?? "";
    priceForm.elements.max.value = price.max ?? "";
    priceForm.elements.currency.value = price.currency;
    const money = (amount) => amount.toLocaleString("uk-UA") + " " + price.currency;
    document.getElementById("price-status").textContent =
      price.min !== null && price.max !== null ? "Надсилаються пости з ціною від " + money(price.min) + " до " + money(price.max) + "."
      : price.min !== null ? "Надсилаються пости з ціною від " + money(price.min) + "."
      : price.max !== null ? "Надсилаються пости з ціною до " + money(price.max) + "."
      : "Без обмеження — підходить будь-яка ціна.";
  }

  // Missing or broken photo: fall back to the first letter
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("avatar")) return;
    const span = document.createElement("span");
    span.className = "avatar";
    span.setAttribute("aria-hidden", "true");
    span.textContent = img.dataset.initial || "";
    img.replaceWith(span);
  }, true);

  function showError(kind, message) {
    document.querySelector('[data-error="' + kind + '"]').textContent = message || "";
  }

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.dataset.kind;
    if (kind === "floor" || kind === "price") return saveRange(form, kind);
    const input = form.elements.value;
    const button = form.querySelector("button");
    // Keywords can be pasted as a comma-separated list
    const values = kind === "keywords"
      ? input.value.split(/[,\\n]/).map((v) => v.trim()).filter(Boolean)
      : [input.value.trim()];

    button.disabled = true;
    showError(kind, "");
    const failed = [];
    for (const value of values) {
      try {
        render(await api("POST", "/api/" + kind, { value }));
      } catch (err) {
        failed.push({ value, message: err.message });
      }
    }
    button.disabled = false;
    showError(kind, failed.map((f) => f.value + ": " + f.message).join("; "));
    // Keep only what failed, so it can be fixed and resubmitted
    input.value = failed.map((f) => f.value).join(", ");
    input.focus();
  });

  async function saveRange(form, kind) {
    const toNumber = (input) => input.value.trim() === "" ? null : Number(input.value);
    const value = { min: toNumber(form.elements.min), max: toNumber(form.elements.max) };
    if (form.elements.currency) value.currency = form.elements.currency.value;
    const button = form.querySelector("button");
    button.disabled = true;
    showError(kind, "");
    try {
      render(await api("PUT", "/api/" + kind, { value }));
    } catch (err) {
      showError(kind, err.message);
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById("rooms").addEventListener("click", async (e) => {
    const button = e.target.closest("[data-rooms]");
    if (!button) return;
    const buttons = [...document.querySelectorAll("[data-rooms]")];
    button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
    const rooms = buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => Number(b.dataset.rooms));
    buttons.forEach((b) => (b.disabled = true));
    showError("rooms", "");
    try {
      render(await api("PUT", "/api/rooms", { value: rooms }));
    } catch (err) {
      showError("rooms", err.message);
      api("GET", "/api/settings").then(render).catch(() => {});
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });

  document.addEventListener("click", async (e) => {
    const button = e.target.closest(".remove");
    if (!button) return;
    button.disabled = true;
    try {
      render(await api("DELETE", "/api/" + button.dataset.kind, { value: button.dataset.value }));
    } catch (err) {
      button.disabled = false;
      showError(button.dataset.kind, err.message);
    }
  });

  api("GET", "/api/settings").then(render).catch((err) => showError("keywords", "Не вдалося завантажити налаштування: " + err.message));
</script>
</body>
</html>`;
