import { chromium } from "/home/bricekz/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs";
const B = "http://127.0.0.1:8799/collecte/";

async function shot(theme, file) {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 420, height: 700 }, serviceWorkers: "block" });
  const p = await c.newPage();
  await p.route(/script\.google\.com/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  await p.addInitScript((th) => { try { localStorage.setItem("ng-theme", th); } catch (e) {} }, theme);
  await p.goto(B, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(900);
  await p.evaluate(() => { const l = document.querySelector("#app-loader"); if (l) l.style.display = "none"; });
  await p.evaluate(() => {
    location.hash = "#/notifications";
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const feed = document.querySelector("#notif-feed");
    const empty = document.querySelector("#notif-empty");
    if (empty) empty.hidden = true;
    const items = [
      { unread: true, ico: "🔔", msg: "Ibrahim a répondu à ta demande pour le mot « courage » en ngiemboon.", time: "il y a 2 min" },
      { unread: true, ico: "👍", msg: "Salimatou a noté ta traduction de « bonheur » : juste.", time: "il y a 1 h" },
      { unread: false, ico: "🏅", msg: "Tu as atteint 10 contributions confirmées. Merci pour ta régularité.", time: "hier" },
      { unread: false, ico: "💬", msg: "Nouvelle demande de traduction pour « courage » en bassa.", time: "il y a 2 jours" },
    ];
    feed.innerHTML = items.map(it =>
      `<li class="notif ${it.unread ? "notif--unread" : ""} notif--action" role="button" tabindex="0">` +
      `<span class="notif-ico" aria-hidden="true">${it.ico}</span>` +
      `<div class="notif-body"><p class="notif-msg">${it.msg}</p><span class="notif-time">${it.time}</span></div>` +
      `<span class="notif-go" aria-hidden="true">→</span></li>`
    ).join("");
  });
  await p.waitForTimeout(150);
  await p.screenshot({ path: file });
  await c.close(); await b.close();
}
await shot("dark", "server/_auth_work/_notif_contrast_dark.png");
await shot("light", "server/_auth_work/_notif_contrast_light.png");
