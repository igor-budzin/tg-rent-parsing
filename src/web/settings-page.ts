export const SETTINGS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parser Settings</title>
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
  main { max-width: 960px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 4px; }
  nav { display: flex; gap: 16px; font-size: 14px; }
  a { color: var(--accent); }
  .intro { color: var(--muted); font-size: 14px; margin: 0 0 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; min-width: 0; }
  .hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  form { display: flex; gap: 8px; margin-bottom: 12px; }
  input {
    flex: 1; min-width: 0; padding: 8px 12px; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
  }
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
</style>
</head>
<body>
<main>
  <header>
    <h1>Parser settings</h1>
    <nav><a href="/">Status</a><a href="/subscribers">Subscribers</a></nav>
  </header>
  <p class="intro">Changes apply immediately, no restart needed.</p>
  <div class="grid">
    <section class="card">
      <h2>Keywords</h2>
      <p class="hint">A message matches if it contains any keyword (case-insensitive). Paste several separated by commas.</p>
      <form data-kind="keywords">
        <input name="value" placeholder="e.g. оболонь" aria-label="New keyword" required>
        <button class="add" type="submit">Add</button>
      </form>
      <p class="error" data-error="keywords"></p>
      <div class="chips" id="keywords"></div>
    </section>
    <section class="card">
      <h2>Channels</h2>
      <p class="hint">Username, t.me link or numeric ID. The logged-in account should be a member to receive new posts.</p>
      <form data-kind="channels">
        <input name="value" placeholder="e.g. orenda_kvatir" aria-label="New channel" required>
        <button class="add" type="submit">Add</button>
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
          '<button class="remove" data-kind="keywords" data-value="' + esc(k) + '" aria-label="Remove ' + esc(k) + '">×</button></span>'
        ).join("")
      : '<p class="empty">No keywords — nothing will match.</p>';

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
            (c.error ? '<span class="badge" title="' + esc(c.error) + '">Not found</span>' : '') +
            '<button class="remove" data-kind="channels" data-value="' + esc(c.name) + '" aria-label="Remove ' + esc(c.name) + '">×</button></li>';
        }).join("")
      : '<li class="empty">No channels — nothing is being watched.</li>';
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

  api("GET", "/api/settings").then(render).catch((err) => showError("keywords", "Could not load settings: " + err.message));
</script>
</body>
</html>`;
