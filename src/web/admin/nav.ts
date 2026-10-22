import { MENU_BUTTON } from "../styles.js";

// Links shown at the top of every admin page; collapse into a hamburger menu on mobile
export const ADMIN_NAV = MENU_BUTTON +
  '<div class="menu" id="menu"><nav><a href="/">Статус</a><a href="/accounts">Акаунти</a><a href="/settings">Канали</a>' +
  '<a href="/plans">Тарифи</a><a href="/audit">Журнал</a><a href="/failures">Помилки AI</a>' +
  '<a href="/stats">Статистика</a><a href="/logout">Вийти</a></nav></div>';
