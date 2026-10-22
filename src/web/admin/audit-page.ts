import { ADMIN_NAV } from "./nav.js";
import { BASE_STYLES, BASE_SCRIPT, PAGE_HEAD } from "../styles.js";

export const AUDIT_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Журнал дій</title>
<style>
${BASE_STYLES}
  td.payload { max-width: 480px; overflow-wrap: anywhere; }
</style>
${PAGE_HEAD}
</head>
<body>
<main>
  <header>
    <h1>Журнал дій</h1>
    ${ADMIN_NAV}
  </header>
  <section class="card">
    <p class="hint">Останні 200 дій адміністраторів, користувачів і системи з акаунтами, учасниками, підписками й тарифами.</p>
    <p class="error" id="error"></p>
    <div class="table-wrap" id="list"></div>
  </section>
</main>
<script>
${BASE_SCRIPT}
  const ACTORS = { admin: "адмін", user: "користувач", system: "система" };

  function target(e) {
    if (!e.targetType) return "—";
    return e.targetType === "account"
      ? '<a href="/accounts#account=' + esc(e.targetId) + '">акаунт #' + esc(e.targetId) + '</a>'
      : esc(e.targetType) + ' #' + esc(e.targetId);
  }

  api("GET", "/api/audit").then((entries) => {
    document.getElementById("list").innerHTML = entries.length === 0 ? '<p class="empty">Порожньо.</p>' :
      '<table><thead><tr><th>Час</th><th>Хто</th><th>Дія</th><th>Обʼєкт</th><th>Деталі</th></tr></thead><tbody>' +
      entries.map((e) => '<tr><td>' + formatDate(e.createdAt, true) + '</td>' +
        '<td>' + (ACTORS[e.actorType] || esc(e.actorType)) + (e.actorName ? ' ' + esc(e.actorName) : '') + '</td>' +
        '<td class="mono">' + esc(e.action) + '</td><td>' + target(e) + '</td>' +
        '<td class="payload mono muted">' + (e.payload ? esc(JSON.stringify(e.payload)) : '') + '</td></tr>').join("") +
      '</tbody></table>';
  }).catch((err) => (document.getElementById("error").textContent = err.message));
</script>
</body>
</html>`;
