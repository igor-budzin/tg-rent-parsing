import { BASE_STYLES, PAGE_HEAD } from "../styles.js";

export const ADMIN_LOGIN_PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вхід в адмінку</title>
<style>
${BASE_STYLES}
  body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { width: 100%; max-width: 360px; }
  input { width: 100%; margin-bottom: 12px; }
  button { width: 100%; }
</style>
${PAGE_HEAD}
</head>
<body>
<form class="card" id="form">
  <h1>Адмінка</h1>
  <p class="hint">Вхід для адміністраторів сервісу.</p>
  <input name="login" autocomplete="username" placeholder="Логін" aria-label="Логін" required>
  <input name="password" type="password" autocomplete="current-password" placeholder="Пароль" aria-label="Пароль" required>
  <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="Код із застосунку автентифікації" aria-label="Код двофакторного входу" hidden>
  <p class="error" id="error"></p>
  <button type="submit">Увійти</button>
</form>
<script>
  const form = document.getElementById("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    document.getElementById("error").textContent = "";
    try {
      const res = await fetch(location.origin + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login: form.elements.login.value,
          password: form.elements.password.value,
          code: form.elements.code.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // Password accepted, 2FA is on: show the code field and wait for the code
      if (data.codeRequired) {
        form.elements.code.hidden = false;
        form.elements.code.required = true;
        form.elements.code.focus();
      }
      if (!res.ok) throw new Error(data.error || res.statusText);
      location.href = "/";
    } catch (err) {
      document.getElementById("error").textContent = err.message;
      button.disabled = false;
    }
  });
</script>
</body>
</html>`;
