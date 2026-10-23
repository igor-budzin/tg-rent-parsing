import { BASE_STYLES, PAGE_HEAD } from "../styles.js";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Sign-in through Telegram's OAuth page in the top window: it returns to /login with the signed
// user data in #tgAuthResult, which is passed on to /auth/telegram. Unlike the embedded Login
// Widget this needs no third-party cookies. It only works on the domain set for the bot in
// BotFather (/setdomain); the one-time link from the bot's /login command works everywhere.
export function userLoginPageHtml(botUsername: string | null, botId: string, appUrl: string, error?: string): string {
  const origin = new URL(appUrl).origin;
  const authUrl =
    `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(botId)}&origin=${encodeURIComponent(origin)}` +
    `&request_access=write&return_to=${encodeURIComponent(`${appUrl}/login`)}`;
  const button = botId
    ? `<button type="button" class="tg-login" onclick="location.href='${esc(authUrl)}'">Увійти через Telegram</button>`
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
<script>
  (function () {
    var m = location.hash.match(/tgAuthResult=([A-Za-z0-9_=+\\/-]+)/);
    if (!m) return;
    history.replaceState(null, "", location.pathname);
    try {
      var bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      var bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
      var user = JSON.parse(new TextDecoder().decode(bytes));
      if (user && user.hash) location.replace("/auth/telegram?" + new URLSearchParams(user));
    } catch (e) {}
  })();
</script>
</head>
<body>
<main class="card">
  <h1>Сповіщення про оренду</h1>
  <p class="hint">Нові оголошення з Telegram-каналів за вашими фільтрами — одразу в Telegram.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <div class="widget">${button}</div>
  <p class="hint">Не виходить увійти? Надішліть <b>/login</b> боту ${botLink} — він пришле посилання для входу.</p>
</main>
</body>
</html>`;
}
