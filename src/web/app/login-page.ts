import { BASE_STYLES, PAGE_HEAD } from "../styles.js";

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Sign-in with the Telegram Login Widget. It only works on the domain set for the bot in
// BotFather (/setdomain); the one-time link from the bot's /login command works everywhere.
export function userLoginPageHtml(botUsername: string | null, appUrl: string, error?: string): string {
  const widget = botUsername
    ? `<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${esc(botUsername)}"
         data-size="large" data-radius="8" data-request-access="write" data-auth-url="${esc(appUrl)}/auth/telegram"></script>`
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
</style>
${PAGE_HEAD}
</head>
<body>
<main class="card">
  <h1>Сповіщення про оренду</h1>
  <p class="hint">Нові оголошення з Telegram-каналів за вашими фільтрами — одразу в Telegram.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ""}
  <div class="widget">${widget}</div>
  <p class="hint">Не бачите кнопки? Надішліть <b>/login</b> боту ${botLink} — він пришле посилання для входу.</p>
</main>
</body>
</html>`;
}
