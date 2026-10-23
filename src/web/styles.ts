// Base styles of the newer pages in both apps; same palette as the older admin pages

const DARK_VARS = `
      --bg: #17191c; --card: #212428; --text: #e4e6eb; --muted: #a0a4ab; --border: #3a3d42;
      --accent: #3a9ce0; --accent-text: #fff; --chip: #1e3347; --error: #ef6b6b; --error-bg: #3a2222;
      --ok: #6bc46f; --ok-bg: #1f3321; --warn: #f0c060; --warn-bg: #3a3020; --off-bg: #2c2f33;`;

export const BASE_STYLES = `
  :root {
    --bg: #f4f5f7; --card: #fff; --text: #1c1e21; --muted: #65676b; --border: #dadde1;
    --accent: #2481cc; --accent-text: #fff; --chip: #e8f1fa; --error: #c62828; --error-bg: #fdecea;
    --ok: #2e7d32; --ok-bg: #e8f5e9; --warn: #8a5a00; --warn-bg: #fff4dc; --off-bg: #eceff1;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {${DARK_VARS}
    }
  }
  :root[data-theme="dark"] {${DARK_VARS}
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1280px; margin: 0 auto; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  h3 { font-size: 14px; margin: 16px 0 8px; color: var(--muted); font-weight: 600; }
  nav { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 14px; }
  a { color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 16px; align-items: start; }
  .grid + .grid, main > .card + .card, .grid + .card, .card + .grid, fieldset + .grid, .grid + fieldset { margin-top: 16px; }
  fieldset > .grid + .grid { margin-top: 16px; }
  .row > input { min-width: 80px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; min-width: 0; }
  .hint, .muted { color: var(--muted); font-size: 13px; }
  .hint { margin: 0 0 12px; }
  form.row, .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
  input, select, textarea {
    flex: 1; min-width: 0; padding: 8px 12px; font: inherit; color: var(--text); background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
  }
  select { flex: none; padding: 8px; }
  label.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); flex: 1; min-width: 120px; }
  label.field input, label.field select { color: var(--text); }
  button {
    padding: 8px 16px; font: inherit; font-weight: 600; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text);
  }
  button.secondary { background: transparent; color: var(--accent); }
  button.danger { background: transparent; color: var(--error); border-color: var(--error); }
  button.small { padding: 2px 10px; font-size: 13px; }
  button:disabled { opacity: .6; cursor: default; }
  .error { color: var(--error); font-size: 13px; margin: 0 0 12px; }
  .error:empty { display: none; }
  .notice { padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; background: var(--warn-bg); color: var(--warn); }
  .notice:empty { display: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 10px;
    background: var(--chip); border-radius: 999px; font-size: 14px; max-width: 100%;
  }
  .chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove {
    border: none; background: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1;
    padding: 2px 6px; border-radius: 999px; font-weight: 400;
  }
  .remove:hover { color: var(--error); }
  .toggles { display: flex; flex-wrap: wrap; gap: 8px; }
  .toggle { min-width: 52px; border-color: var(--border); background: var(--bg); color: var(--text); }
  .toggle[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
  .status { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 13px; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td, tr.selected td { background: var(--chip); }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .badge.on { background: var(--ok-bg); color: var(--ok); }
  .badge.off { background: var(--off-bg); color: var(--muted); }
  .badge.warn { background: var(--warn-bg); color: var(--warn); }
  .badge.bad { background: var(--error-bg); color: var(--error); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .tile { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; }
  .tile .value { font-size: 22px; font-weight: 700; }
  .tile .label { color: var(--muted); font-size: 13px; }
  .empty { color: var(--muted); font-size: 14px; padding: 8px 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; }
  dt { color: var(--muted); }
  dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  @media (max-width: 700px) {
    .card { padding: 16px; }
    .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
`;

// Hamburger button placed in <header> right after <h1>; the page's navs go into the
// <div class="menu"> after it. On wide screens the wrapper is transparent to layout.
export const MENU_BUTTON =
  '<button type="button" class="menu-toggle" aria-label="Меню" aria-expanded="false" aria-controls="menu">☰</button>';

// Logout is a POST, so another site can't sign people out with a link; looks like a nav link
export const LOGOUT_BUTTON =
  '<form class="logout" method="post" action="/logout"><button type="submit" class="link">Вийти</button></form>';

// Goes into <head> of every page (after the page's own styles, so it wins ties): applies the
// saved theme before first paint, adds a floating button that cycles system → light → dark
// (stored per browser in localStorage), collapses the header menu into a hamburger on
// narrow screens and holds the mobile tweaks shared by all pages
export const PAGE_HEAD = `
<style>
  :root { color-scheme: light dark; }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  .theme-toggle {
    position: fixed; right: 16px; bottom: 16px; z-index: 100; width: 40px; height: 40px; padding: 0;
    border-radius: 999px; border: 1px solid var(--border); background: var(--card); color: var(--text);
    font: 18px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px rgba(0, 0, 0, .15);
  }
  .menu-toggle { display: none; }
  .menu { display: contents; }
  header nav a[aria-current="page"] { font-weight: 600; }
  form.logout { display: inline; margin: 0; }
  button.link {
    padding: 0; border: none; border-radius: 0; background: none; color: var(--accent);
    font: inherit; text-decoration: underline; cursor: pointer;
  }
  @media (max-width: 700px) {
    body { padding: 16px 16px 72px; }
    h1 { font-size: 18px; }
    input, select, textarea { font-size: 16px; }
    header { align-items: center; margin-bottom: 16px; }
    header h1 { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    header .menu-toggle {
      display: inline-flex; align-items: center; justify-content: center; flex: none; width: 40px; height: 40px;
      padding: 0; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--text);
      font: 20px/1 system-ui, sans-serif; cursor: pointer;
    }
    header .menu {
      display: none; flex-basis: 100%; padding: 6px; background: var(--card);
      border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, .12);
    }
    header.menu-open .menu { display: block; }
    header .menu nav { display: flex; flex-direction: column; gap: 2px; margin: 0; font-size: 15px; }
    header .menu nav + nav { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
    header .menu nav > * { display: block; padding: 10px 12px; border-radius: 8px; }
    header .menu nav > :empty { display: none; }
    header .menu nav a, header .menu nav button.link { color: var(--text); text-decoration: none; }
    header .menu nav button.link { width: 100%; text-align: left; }
    header .menu nav a[aria-current="page"] { background: var(--accent); color: var(--accent-text, #fff); }
  }
</style>
<script>
  (function () {
    var KEY = "theme";
    var MODES = ["auto", "light", "dark"];
    var ICONS = { auto: "◐", light: "☀", dark: "☾" };
    var TITLES = { auto: "Тема: як у системі", light: "Тема: світла", dark: "Тема: темна" };
    function read() {
      try { var v = localStorage.getItem(KEY); return MODES.indexOf(v) >= 0 ? v : "auto"; } catch (e) { return "auto"; }
    }
    function apply(mode) {
      if (mode === "auto") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", mode);
    }
    var current = read();
    apply(current);
    document.addEventListener("DOMContentLoaded", function () {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-toggle";
      function render(mode) {
        btn.textContent = ICONS[mode];
        btn.title = TITLES[mode];
        btn.setAttribute("aria-label", TITLES[mode]);
      }
      render(current);
      btn.addEventListener("click", function () {
        current = MODES[(MODES.indexOf(current) + 1) % MODES.length];
        try { localStorage.setItem(KEY, current); } catch (e) {}
        apply(current);
        render(current);
      });
      document.body.appendChild(btn);

      var toggle = document.querySelector(".menu-toggle");
      if (!toggle) return;
      var header = toggle.closest("header");
      if (!header.querySelector(".menu [aria-current]")) {
        var here = header.querySelector('.menu a[href="' + location.pathname + '"]');
        if (here) here.setAttribute("aria-current", "page");
      }
      function setOpen(open) {
        header.classList.toggle("menu-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.textContent = open ? "✕" : "☰";
      }
      toggle.addEventListener("click", function () {
        setOpen(!header.classList.contains("menu-open"));
      });
      document.addEventListener("click", function (e) {
        if (!header.contains(e.target)) setOpen(false);
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && header.classList.contains("menu-open")) {
          setOpen(false);
          toggle.focus();
        }
      });
    });
  })();
</script>`;

// Client-side helpers shared by the newer pages
export const BASE_SCRIPT = `
  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  async function api(method, path, body) {
    const res = await fetch(location.origin + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = "/login";
      throw new Error("Потрібно увійти");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function formatDate(iso, withTime) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("uk-UA", withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
  }

  function money(amount, currency) {
    return Number(amount).toLocaleString("uk-UA") + " " + currency;
  }
`;
