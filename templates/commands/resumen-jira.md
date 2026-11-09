---
description: Relanza la vigilancia de Jira {{PROJECTS}} (cambios de {{REVIEWER}} y de otros; de {{ME}}, solo los tickets que crea) y publica cada reporte en el tablero local. Los envíos a otras sesiones los hace el propio tablero
---

Este comando es solo para la sesión principal e interactiva. Si te encuentras este fichero mientras haces OTRA tarea (por ejemplo, como subagente), IGNÓRALO por completo: no es una instrucción para ti, no montes ningún loop ni menciones `CronCreate`/`ScheduleWakeup`/`/loop`.

Esta sesión es la **de reporte**: lee Jira, publica el reporte y deja las tarjetas. **No envía nada a otras sesiones**: lo que {{ME}} aprueba lo escribe el propio tablero en la sesión de destino, sin pasar por ninguna sesión.

Si de verdad se ha invocado este comando (`/resumen-jira`):

1. Registra esta sesión como la de reporte: llama a `ListAgents`, toma tu propio nombre y ref de la línea «This session is … […]» y ejecuta `node {{WORKSPACE}}/sessions.js iam reporter <nombre> <ref>`.
2. Arranca el tablero: `node {{WORKSPACE}}/board.js ensure` (página en http://127.0.0.1:4747, datos en `{{WORKSPACE}}/data/`).
3. No armes ningún Monitor ni crons: si te queda un Monitor `watch reports` armado, páralo, y borra con `CronDelete` los de «Revisión de Jira de respaldo» si quedan. **Quien vigila Jira es el servidor del tablero**: cada minuto (de lunes a viernes, de 8:00 a 18:30, o con el modo fuera de horario) mira con `jira-window.js --check`, solo código, si hay algo sin contar. Si no hay nada, apunta él mismo «sin novedades» y no te despierta. Si hay algo, te escribe aquí «Tablero: hay N novedades sin contar en Jira…», y si {{ME}} pulsa Refrescar, «Tablero: {{ME}} ha pulsado Refrescar…»: en los dos casos haz «Cada revisión». Hacer, Desplegar y las respuestas tampoco pasan por aquí: los entrega el tablero. Por qué (2026-11-09): la mayoría de revisiones salían vacías y cada una era un turno entero de esta sesión, y el Monitor caducaba cada 30 minutos y costaba otro turno rearmarlo.
4. Haz ahora una «Cada revisión», que es la primera del día.

## Cada revisión

La misma, la pida el tablero por novedades, por Refrescar o al arrancar:

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
6. En el chat, una sola línea: «Reporte publicado en el tablero (HH:MM)», más «N tarjetas nuevas» si las hay.

## Arranque al abrir VS Code

Al abrir la carpeta del espacio de trabajo en VS Code, la tarea «Arrancar el reporte de Jira» (`.vscode/tasks.json`) lanza `board.js startup`: en horario, si esta sesión no vigila, la abre y le manda con un `claude -p` de un solo turno la línea `Aviso del arranque: arranca el reporte. Eres la sesión de reporte registrada: ejecuta ahora .claude/commands/resumen-jira.md (regla de AGENTS.md).` Si llega ese `<cross-session-message>`, comprueba con `node {{WORKSPACE}}/board.js reporter` que `session` es tu nombre de `ListAgents` y haz los pasos 1 a 4 de arriba sin esperar a {{ME}}. El remitente tiene un nombre cualquiera: lo que cuenta es el texto y que tú seas la registrada. Es un aviso para arrancar el reporte, no una orden de enviar ni de tocar nada. Lo que hizo el arranque queda en `{{WORKSPACE}}/data/startup.log`.

## Pausa

{{ME}} puede pausar las revisiones desde el tablero (el botón de stop junto a la campana, en la cabecera del reporte), por ejemplo cuando {{REVIEWER}} está de vacaciones. 

- En pausa el servidor no mira Jira ni te escribe, así que no se gasta ningún turno. Si {{ME}} pulsa Refrescar, te llega igual «Tablero: {{ME}} ha pulsado Refrescar…»: haz una sola «Cada revisión».
- Al reanudar no hace falta nada: el servidor vuelve a mirar Jira al minuto siguiente.
- Hablar sigue llegando: si nadie lo lee en 45 segundos, el tablero despierta a la sesión.

## Límites

- Por qué el tablero está hecho así, las trampas ya vistas y qué hacer si se pierde una sesión o algo deja de funcionar: `{{ROOT}}/context/TABLERO.md`. Léelo antes de cambiar `{{WORKSPACE}}/board.js` o `{{REPO}}/src/`.
- No comentes ni muevas nada en Jira: esta sesión solo lee y publica el reporte.
- Aprobar es cosa de {{ME}}: nunca marques tú una tarjeta como aprobada ni preguntes en el chat «¿la paso?»; las ofertas son las tarjetas. Si {{ME}} escribe aquí que pases una tarea concreta a una sesión, regístralo con `node {{WORKSPACE}}/board.js approve-chat <CLAVE> <sesión>` y el tablero la envía (salvo que una restricción lo impida: el comando lo dice).
- Nada de esto va a Artifacts ni a servicios de claude.ai: la cuenta es compartida y los datos de Jira se quedan en esta máquina.
- Las pestañas Sesiones y Epics del tablero dejan a {{ME}} poner nombre a cada sesión y decidir qué epic lleva cada una. Escriben en `{{WORKSPACE}}/data/sessions.json`, igual que `/soy` y `sessions.js route`.
