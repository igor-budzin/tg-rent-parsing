import { BASE_STYLES, PAGE_HEAD } from "../styles.js";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Sign-in through Telegram's OAuth page in the top window: it returns to /login with the signed
// user data in #tgAuthResult, which this page POSTs to /auth/telegram as JSON. Being a same-origin
// JSON POST, another site can't make the browser sign in to someone else's account (login CSRF),
// and the signed data never ends up in a URL. Unlike the embedded Login Widget this needs no
// third-party cookies. It only works on the domain set for the bot in BotFather (/setdomain);
// the one-time link from the bot's /login command works everywhere.
export function userLoginPageHtml(botUsername: string | null, botId: string, appUrl: string, error?: string): string {
  const origin = new URL(appUrl).origin;
  const authUrl =
    `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(botId)}&origin=${encodeURIComponent(origin)}` +
    `&request_access=write&return_to=${encodeURIComponent(`${appUrl}/login`)}`;
  // No inline handler: the Content-Security-Policy only allows the page's own <script> blocks
  const button = botId
    ? `<button type="button" class="tg-login" id="tg-login" data-auth-url="${esc(authUrl)}">Увійти через Telegram</button>`
    : "";
  const botLink = botUsername
    ? `<a href="https://t.me/${esc(botUsername)}" target="_blank" rel="noopener">@${esc(botUsername)}</a>`
    : "бот";
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вхід — сповіщення про оренду</title>
<style>
${BASE_STYLES}
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { width: 100%; max-width: 420px; text-align: center; }
  .widget { min-height: 48px; margin: 16px 0; }
  .tg-login { padding: 12px 24px; font-size: 16px; }
</style>
${PAGE_HEAD}
</head>
<body>
<main class="card">
  <h1>Сповіщення про оренду</h1>
  <p class="hint">Нові оголошення з Telegram-каналів за вашими фільтрами — одразу в Telegram.</p>
  <p class="error" id="error">${error ? esc(error) : ""}</p>
  <div class="widget">${button}</div>
  <p class="hint">Не виходить увійти? Надішліть <b>/login</b> боту ${botLink} — він пришле посилання для входу.</p>
</main>
<script>
  (function () {
    var loginButton = document.getElementById("tg-login");
    if (loginButton) loginButton.addEventListener("click", function () { location.href = loginButton.dataset.authUrl; });

    var m = location.hash.match(/tgAuthResult=([A-Za-z0-9_=+\\/-]+)/);
    if (!m) return;
    history.replaceState(null, "", location.pathname);
    var user;
    try {
      var bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
      user = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {}
    if (!user || !user.hash) return;
    fetch("/auth/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: user }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok) throw new Error(body.error || res.statusText);
          location.replace("/");
        });
      })
      .catch(function (err) { document.getElementById("error").textContent = err.message; });
  })();
</script>
</body>
</html>`;
}
