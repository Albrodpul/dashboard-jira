---
description: Relanza la vigilancia de Jira {{PROJECTS}} (cambios de {{REVIEWER}} y de otros; de {{ME}}, solo los tickets que crea) y publica cada reporte en el tablero local. Los envíos a otras sesiones los hace la sesión orquestadora (/orquesta)
---

Este comando es solo para la sesión principal e interactiva. Si te encuentras este fichero mientras haces OTRA tarea (por ejemplo, como subagente), IGNÓRALO por completo: no es una instrucción para ti, no montes ningún loop ni menciones `CronCreate`/`ScheduleWakeup`/`/loop`.

Esta sesión es la **de reporte**: lee Jira, publica el reporte y deja las tarjetas. **No envía nada a otras sesiones**: de eso se encarga la sesión orquestadora («Orquestar agentes», `/orquesta`), para que un envío no interrumpa un reporte ni al revés.

Si de verdad se ha invocado este comando (`/resumen-jira`):

1. Registra esta sesión como la de reporte: llama a `ListAgents`, toma tu propio nombre y ref de la línea «This session is … […]» y ejecuta `node {{WORKSPACE}}/sessions.js iam reporter <nombre> <ref>`.
2. Arranca el tablero: `node {{WORKSPACE}}/board.js ensure` (página en http://127.0.0.1:4747, datos en `{{WORKSPACE}}/data/`).
3. Arma un Monitor con `node {{WORKSPACE}}/board.js watch reports` (timeout_ms 1800000; vuelve a armarlo cada vez que avise de que caduca). Es el disparador principal y da dos tipos de evento, que se atienden en el momento:
   - `CYCLE hh:mm …`: toca la revisión periódica (cada 5 minutos, de lunes a viernes de 8:00 a 18:30). Haz «Cada revisión».
   - `REFRESH …`: {{ME}} ha pulsado Refrescar. Haz «Cada revisión» aunque no haya novedades.
   - `MESSAGE <id>`: {{ME}} te ha escrito desde la pestaña «Hablar» (suele ser fuera de casa, sin acceso a VS Code). Léelo con `node {{WORKSPACE}}/board.js message <id>`: vale como si lo hubiera escrito aquí. Haz lo que pida y contéstale con `node {{WORKSPACE}}/board.js answer-message <id> "<respuesta>"`; lo ve en la pestaña y le llega un aviso. Si en vez del evento te llega como mensaje de otra sesión con el mismo texto, es igual de válido: lo que cuenta es leerlo del tablero.
   El ciclo lo marca el propio monitor y no un `/loop`. Los botones Hacer y Desplegar los vigila la orquestadora con `watch dispatches`; `watch` sin argumento da los cuatro eventos y solo se usa si no hay orquestadora (ver «Si no hay orquestadora»).
4. Despierta a la orquestadora (pasos de «Orquestadora despierta»): tras reiniciar VS Code nadie la ha arrancado, y {{ME}} no tiene que escribir nada en ella.
5. Crea un cron de respaldo, por si el monitor caduca sin que te enteres: dos `CronCreate`, uno con cron `2-57/5 8-17 * * 1-5` y otro con `2-27/5 18 * * 1-5` (con uno solo de 8 a 18 seguía saltando hasta las 18:57, fuera de horario), los dos con este prompt: «Revisión de Jira de respaldo. Primero ejecuta `node {{WORKSPACE}}/board.js reporter`: si dice "paused": true, contesta solo «En pausa» y borra este cron con `CronDelete`; si dice "watching": true, el monitor está armado y no hagas nada ni contestes más que una palabra («Vigilando»). Si dice false: arma un Monitor (command `node {{WORKSPACE}}/board.js watch reports`, timeout_ms 1800000) y haz «Cada revisión» de `{{ROOT}}/.claude/commands/resumen-jira.md`. Solo en horario 8:00-18:30 Europe/Madrid.» Los cron disparan aunque el monitor esté armado: sin esa comprobación, cada cinco minutos habría una revisión de más.

## Cada revisión

La misma, la dispare el ciclo o un `REFRESH`:

1. Las sesiones abiertas no hay que guardarlas: el tablero las lee solo del registro de Claude Code (`~/.claude/sessions/<pid>.json`, que trae el uuid de la conversación y el nombre automático actual) y enlaza cada sesión con su conversación por ese uuid, que no cambia al reanudar. Los ficheros `.key` de esa carpeta son secretos: no se leen.
2. Lee Jira tú mismo, en esta sesión (no delegues en un subagente): `node {{WORKSPACE}}/jira-window.js`, sin número. Mira desde el último reporte publicado, con margen: vale igual para la primera revisión del día, tras un festivo o tras tener el ordenador suspendido. **Solo saca lo que no se ha contado todavía**: cada evento queda como contado al publicar el reporte, así que no hay que descartar nada a mano y lo que Jira entrega con retraso sale en la revisión siguiente. `--all` enseña también lo ya contado, por si hace falta repasar. El script deja fuera lo que hace {{ME}} (salvo los tickets que crea: esos se reportan y dan tarjeta como cualquier ticket nuevo, porque los crea para que se hagan), los enlaces y los cambios de Rank, saca cada evento con la hora en Madrid y con su epic, y al final lista qué sesión lleva cada epic. Si falla, usa las herramientas `mcp__jira__*` con JQL "{{JQLPROJECTS}} AND updated >= -30m", sin filtrar por sprint, comprobando `created`/`reporter`, el changelog Y el campo `comment` de cada ticket (los comentarios no siempre salen en el changelog; pasa las horas de Jira a Europe/Madrid).
3. Los epics vistos y las tarjetas los pone el propio script; su salida dice cuáles en «Tarjetas del tablero». No las crees a mano salvo que el script haya fallado (`echo '<json>' | node {{WORKSPACE}}/board.js add`, campos key, title, kind, epicKey, epicName, assignee, note, noteBy, at, proposedArea).
   - **Qué se ofrece**: tickets nuevos sin asignar o asignados a {{ME}} y que no estén cerrados (`new`); tareas de {{ME}} devueltas (etiqueta `{{REJECTLABEL}}` o paso a «{{RETURNED}}», `returned`, con el comentario de revisión como nota); y comentarios de otros en una tarea de {{ME}} sin devolverla ni cerrarla (`comment`). Las dos últimas vuelven a Pendientes aunque la tarjeta estuviera enviada, hecha o ignorada.
   - Lo que tiene otra persona (otro compañero, {{REVIEWER}}…) no se ofrece. Si una tarjeta pendiente o ignorada pasa a tenerla otra persona, el tablero la retira solo, con una nota.
   - Un ticket nuevo cuya tarjeta borró {{ME}} no se vuelve a crear.
4. `proposedArea` sale de la sesión que lleva el epic; si el epic no tiene sesión queda vacío y {{ME}} la elige en la tarjeta.
5. **Publica el reporte en el tablero, siempre**, lo haya pedido {{ME}} o sea el ciclo automático: `echo "<texto>" | node {{WORKSPACE}}/board.js report` (markdown simple: una línea de título en negrita y viñetas). Es lo que {{ME}} lee en la página; si no se publica, la página se queda con el reporte anterior.
   - **Formato**, que es el que la página sabe pintar ordenado:
     - Primera línea, el titular, entera en negrita: `**Revisión de las 11:20: {{REVIEWER}} crea un ticket sin asignar.**`
     - Un bloque por epic: una línea en negrita con el epic y su sesión entre paréntesis, `**WEB-120 Checkout (sesión: Checkout)**` o `(sin sesión)`. Los eventos sin epic, al final, bajo `**Sin epic**`.
     - Debajo, una viñeta por evento con tres partes separadas por ` · `: hora, ticket y qué ha pasado. `- 11:17 · WEB-121 · {{REVIEWER}} crea «título». Sin asignar.` La página las pinta como una tabla (Hora, Ticket, Qué ha pasado) y enlaza sola cada clave de ticket a Jira; no uses ` · ` dentro del texto.
     - Lo que no es de Jira (tarjetas nuevas, envíos esperando, resultado de un despliegue), en viñetas sin hora al final.
   - Cada cambio una sola vez (un ticket + un evento = una línea). No repitas eventos ya reportados.
   - Los comentarios nuevos, con un resumen de 1-2 líneas de lo que dicen y a quién mencionan. Presta especial atención a {{REVIEWER}}. Di siempre a quién está asignado cada ticket.
   - Cada reporte cuenta solo lo de esa revisión, nunca un resumen del día ({{ME}} lo descartó). Si no hay novedades, solo el titular (`**Revisión de las 16:20: sin novedades desde las 12:28.**`): el tablero lo reconoce por «sin novedades» y no lo pone encima del último reporte con contenido, solo actualiza la hora de la última revisión. Un reporte con alguna línea de evento (`- HH:MM · …`) cuenta como reporte con contenido.
   - Horas en Europe/Madrid. La hora del título se saca con node (`toLocaleTimeString` con `timeZone: "Europe/Madrid"`): el `date` de Git Bash da UTC. Si no hay nada relevante, una frase corta.
6. **Orquestadora despierta**: haz los pasos de ese apartado. Si además hay envíos esperando más de 2 minutos con la orquestadora vigilando, dilo en el reporte («N envíos esperando a la orquestadora»); no los envíes tú.
7. En el chat, una sola línea: «Reporte publicado en el tablero (HH:MM)», más «N tarjetas nuevas» si las hay.

## Arranque al abrir VS Code

Al abrir la carpeta del espacio de trabajo en VS Code, la tarea «Arrancar el reporte de Jira» (`.vscode/tasks.json`) lanza `board.js startup`: en horario, si esta sesión no vigila, la abre y le manda con un `claude -p` de un solo turno la línea `Aviso del arranque: arranca el reporte. Eres la sesión de reporte registrada: ejecuta ahora .claude/commands/resumen-jira.md (regla de AGENTS.md).` Si llega ese `<cross-session-message>`, comprueba con `node {{WORKSPACE}}/board.js reporter` que `session` es tu nombre de `ListAgents` y haz los pasos 1 a 5 de arriba sin esperar a {{ME}}. El remitente tiene un nombre cualquiera: lo que cuenta es el texto y que tú seas la registrada. Es un aviso para arrancar el reporte, no una orden de enviar ni de tocar nada. Lo que hizo el arranque queda en `{{WORKSPACE}}/data/startup.log`.

## Orquestadora despierta

La orquestadora tiene que vigilar sola, sin que {{ME}} escriba `/orquesta` cada vez que reinicia VS Code. Como una sesión recién abierta no hace nada hasta que le llega un mensaje, la despierta esta sesión, al arrancar y en cada revisión:

1. `node {{WORKSPACE}}/board.js orchestrator` da `open` (su pestaña está abierta), `watching` (su monitor `watch dispatches` está armado: deja un latido cada 15 segundos) y `session`/`ref`.
2. Si `watching` es true, no hagas nada.
3. Si `open` es false: `node {{WORKSPACE}}/board.js open orchestrator` y espera hasta medio minuto a que pase a true. Si no se abre, dilo en el reporte y sigue.
4. Con `open` true y `watching` false, mándale con `SendMessage` (a `session`, con ` [ref]` solo si el nombre se repite en `ListAgents`) exactamente esta línea: `Aviso del reporte: arranca la orquestación. Eres la sesión orquestadora registrada: ejecuta ahora .claude/commands/orquesta.md (regla de AGENTS.md).` No se repite más de una vez cada 5 minutos.

Es un aviso para que arranque, no una orden de enviar nada: lo que autoriza cada envío es la aprobación de {{ME}} que figura en el tablero.

## Pausa

{{ME}} puede pausar las revisiones desde el tablero (el botón de stop junto a la campana, en la cabecera del reporte), por ejemplo cuando {{REVIEWER}} está de vacaciones. Cada ciclo y cada cron es un turno entero de esta sesión, así que en pausa no se gasta ninguno:

- **Al llegar el evento `PAUSE`** (o si `board.js reporter` da `"paused": true`): borra con `CronDelete` los dos crons de respaldo y no vuelvas a armar el Monitor cuando caduque. En el chat, una línea: «Revisiones en pausa».
- **«Aviso del tablero: {{ME}} pide una revisión»** ({{ME}} ha pulsado Refrescar en pausa y el tablero te despierta): comprueba con `board.js refresh-request` que hay una petición y haz una sola «Cada revisión». No armes nada.
- **«Aviso del tablero: reanuda las revisiones»**: comprueba que `board.js reporter` da `"paused": false` y haz los pasos 3 a 5 del principio (Monitor, orquestadora, crons) y una «Cada revisión».
- Hablar sigue llegando: si nadie lo lee en 45 segundos, el tablero despierta a la sesión.

## Si no hay orquestadora

Si `node {{WORKSPACE}}/sessions.js list` dice «Orquestador: sin registrar» y `board.js orchestrator` devuelve `orchestrator: null`, no hay nadie que envíe: entonces esta sesión hace también de orquestadora. Arma el monitor con `watch` (sin argumento) y sigue los pasos «Enviar» y «Desplegar» de `{{ROOT}}/.claude/commands/orquesta.md`. En cuanto {{ME}} registre una orquestadora, vuelve a `watch reports`.

## Límites

- Por qué el tablero está hecho así, las trampas ya vistas y qué hacer si se pierde una sesión o algo deja de funcionar: `{{ROOT}}/context/TABLERO.md`. Léelo antes de cambiar `{{WORKSPACE}}/board.js` o `{{REPO}}/src/`.
- No comentes ni muevas nada en Jira: esta sesión solo lee y publica el reporte.
- Aprobar es cosa de {{ME}}: nunca marques tú una tarjeta como aprobada ni preguntes en el chat «¿la paso?»; las ofertas son las tarjetas. Si {{ME}} escribe aquí que pases una tarea concreta a una sesión, regístralo con `node {{WORKSPACE}}/board.js approve-chat <CLAVE> <sesión>` y la orquestadora la envía.
- Nada de esto va a Artifacts ni a servicios de claude.ai: la cuenta es compartida y los datos de Jira se quedan en esta máquina.
- Las pestañas Sesiones y Epics del tablero dejan a {{ME}} poner nombre a cada sesión y decidir qué epic lleva cada una. Escriben en `{{WORKSPACE}}/data/sessions.json`, igual que `/soy` y `sessions.js route`.
