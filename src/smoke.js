const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const config = require("./config");
const { DATA_DIR, BASE_URL } = require("./data");

const FILE = path.join(DATA_DIR, "smoke.json");
const VIEWS = ["home", "pending", "approved", "sent", "waiting", "done", "ignored", "find", "projects", "deploy", "sentry", "context", "follow-up", "learning", "sessions", "machines"];
const PHONE_VIEWS = ["today", "pending", "more"];

const head = () => {
  try {
    return cp.execFileSync("git", ["-C", path.join(__dirname, ".."), "rev-parse", "--short", "HEAD"], { windowsHide: true }).toString().trim();
  } catch (e) {
    return null;
  }
};

function playwright() {
  const p = path.join(config.root, "scripts", "mcp", "node_modules", "playwright");
  return fs.existsSync(p) ? require(p) : null;
}

async function visit(page, view, problems) {
  const errors = [];
  const onError = (e) => errors.push(String(e.message || e).slice(0, 200));
  const onConsole = (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 200));
  page.on("pageerror", onError);
  page.on("console", onConsole);
  await page.evaluate((v) => localStorage.setItem("board-tab", v), view);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const body = await page.evaluate(() => {
    const g = document.getElementById("groups");
    return { children: g ? g.children.length : 0, down: /El tablero no responde/.test(document.body.innerText) };
  });
  page.off("pageerror", onError);
  page.off("console", onConsole);
  if (!body.children) errors.push("la vista sale vacía");
  if (body.down) errors.push("dice que el tablero no responde");
  for (const e of errors) problems.push(`${view}: ${e}`);
}

async function runSmoke() {
  const pw = playwright();
  if (!pw) return { skipped: "no está instalado Playwright en scripts/mcp" };
  const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
  const problems = [];
  try {
    const desk = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await desk.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    for (const v of VIEWS) await visit(desk, v, problems);
    const phone = await browser.newPage({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
    await phone.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    for (const v of PHONE_VIEWS) await visit(phone, `${v}`, problems);
  } finally {
    await browser.close().catch(() => {});
  }
  return { problems };
}

async function smokeAfterUpdate() {
  if (!require("./cluster").isPrimary()) return;
  const now = head();
  let last = {};
  try {
    last = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {}
  if (!now || last.head === now) return;
  const result = await runSmoke().catch((e) => ({ problems: [`no se pudo lanzar la prueba: ${String(e.message || e).slice(0, 200)}`] }));
  fs.writeFileSync(FILE, JSON.stringify({ head: now, at: new Date().toISOString(), ...result }, null, 1));
  if (!result.problems || !result.problems.length) return;
  const board = require("./sessions").loadRoutes().board;
  if (!board || !board.session) return;
  const list = result.problems.slice(0, 8).join("; ");
  require("./sessions")
    .wakeSession(board.session, `Aviso del tablero: la prueba automática del tablero ha fallado con el commit ${now}: ${list}. Revísalo y arréglalo; si no es un fallo del tablero, dilo en una línea.`)
    .catch(() => {});
}

module.exports = { runSmoke, smokeAfterUpdate };
