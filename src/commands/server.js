const http = require("http");
const cp = require("child_process");
const { BASE_URL, PORT, ENTRY, readStdin } = require("../core/data");
const { sendPush, subscriptions } = require("../server/push");
const { ping } = require("../server/state");
const { a, json, fail } = require("./args");

function launchServer(message) {
  const agent = require("../core/mac-agent");
  const viaAgent = agent.isMac && agent.loaded() && agent.kickstart();
  if (!viaAgent) cp.spawn(process.execPath, [ENTRY, "serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  setTimeout(() => ping((ok) => console.log(ok ? `${message}: ${BASE_URL}` : "No se pudo arrancar el tablero")), viaAgent ? 6000 : 800);
}

module.exports = {
  serve() {
    require("../server/server").serve();
  },

  ensure() {
    ping((up) => (up ? console.log(`Tablero ya en marcha: ${BASE_URL}`) : launchServer("Tablero arrancado")));
  },

  restart() {
    const stop = http.request(`${BASE_URL}/api/quit`, { method: "POST" }, (r) => {
      r.resume();
      if (r.statusCode !== 200) {
        const legacy = http.request(`${BASE_URL}/api/salir`, { method: "POST" }, (r2) => {
          r2.resume();
          if (r2.statusCode !== 200) return console.log(`El servidor en marcha no sabe reiniciarse: cierra a mano el proceso node del puerto ${PORT} (por su PID, nunca \`taskkill /IM node.exe\`) y ejecuta \`ensure\`.`);
          setTimeout(() => launchServer("Tablero reiniciado"), 400);
        });
        legacy.on("error", () => launchServer("Tablero reiniciado"));
        return legacy.end();
      }
      setTimeout(() => launchServer("Tablero reiniciado"), 400);
    });
    stop.on("error", () => launchServer("Tablero reiniciado"));
    stop.end();
  },

  watch() {
    require("../server/watcher").watch(a);
  },

  host() {
    require("../sessions/host").serve();
  },

  startup() {
    require("../server/startup").launchStartup(a === "--child" || a === "--hijo", process.argv.includes("--force"));
  },

  overtime() {
    if (a === "on" || a === "off") return require("../server/startup").setOvertime(a === "on").then((v) => json({ overtime: v }));
    json({ overtime: require("../core/hours").overtime(), workHours: require("../core/hours").workHours() });
  },

  "push-test"() {
    sendPush("test", true).then((n) => console.log(`aviso de prueba enviado a ${n} de ${subscriptions().length} dispositivo(s)`));
  },

  async "claude-token"() {
    const t = require("../features/claude-token");
    const remove = a === "--remove";
    try {
      if (a === "--setup") {
        const expires = await t.setupToken();
        return console.log(`\nToken de Claude guardado en el .env de este ordenador (caduca hacia el ${expires}) y puesto también para VS Code. Cierra VS Code del todo y ábrelo de nuevo. Falta copiarlo al otro ordenador.`);
      }
      if (a === "--import") {
        const expires = t.importToken(readStdin());
        return console.log(`Token de Claude guardado en este ordenador (caduca hacia el ${expires}) y puesto también para VS Code.`);
      }
      if (a === "--export") {
        if (process.stdout.isTTY) fail("--export solo se usa encadenado a otro comando (… | ssh mac \"… claude-token --import\"), para no enseñar el token.");
        const token = require("../sessions/registry").sessionToken();
        if (!token) fail("No hay token en el .env de este ordenador.");
        return process.stdout.write(token);
      }
      t.applyUserToken(remove);
    } catch (e) {
      fail(e.message);
    }
    console.log(remove ? "Token de Claude quitado de las variables de tu usuario: VS Code vuelve a usar el /login." : "Token de Claude puesto en las variables de tu usuario. Cierra VS Code del todo y ábrelo de nuevo para que lo use.");
  },
};
