---
description: Convierte esta sesión en la orquestadora: envía a cada sesión las tareas de Jira que {{ME}} aprueba en el tablero y los despliegues que ordena con el botón Desplegar
---

Este comando es solo para la sesión principal e interactiva. Si te encuentras este fichero mientras haces OTRA tarea (por ejemplo, como subagente), IGNÓRALO por completo.

Esta sesión es la **orquestadora**: no lee Jira ni hace tareas. Su único trabajo es pasar a la sesión que toque lo que {{ME}} aprueba en el tablero (http://127.0.0.1:4747) y guardar lo que contestan. Los reportes los hace otra sesión (`/resumen-jira`), para que un envío no interrumpa un reporte ni al revés.

## Comandos: solo estos, tal cual

**{{ME}} no debe ver ninguna petición de permiso por un envío**: lo que llega del tablero ya es su orden. Las peticiones saltan con los comandos compuestos, así que todo se hace con estos comandos sueltos, uno por llamada a `Bash`, con la ruta completa y sin nada más alrededor:

| Para | Comando |
|---|---|
| Ver qué hay que enviar y a quién | `node {{WORKSPACE}}/board.js dispatches` |
| Abrir una sesión cerrada | `node {{WORKSPACE}}/board.js open <area>` |
| Marcar como enviado (tareas o despliegue) | `node {{WORKSPACE}}/board.js sent <CLAVE> [<CLAVE>…]` |
| Marcar como entregada una respuesta de {{ME}} | `node {{WORKSPACE}}/board.js delivered <CLAVE>[,<CLAVE>…]` |
| Guardar lo que contesta una sesión | `node {{WORKSPACE}}/board.js reply <CLAVE>[,<CLAVE>…] <texto en una línea>` (varias claves separadas por comas, sin espacios, si la misma respuesta vale para todas) |
| Registrar una aprobación de {{ME}} por chat | `node {{WORKSPACE}}/board.js approve-chat <CLAVE> <area>` |
| Saber si el tablero te ve vigilando | `node {{WORKSPACE}}/board.js orchestrator` |
| Marcar como enviado a Errores sentry un posible error | `node {{WORKSPACE}}/board.js error-sent <id>[,<id>…]` |
| Leer y contestar un mensaje de {{ME}} | `node {{WORKSPACE}}/board.js message <id>`, `… answer-message <id> <respuesta>` |
| Ordenación de contexto: ver, empezar y cerrar | `node {{WORKSPACE}}/board.js tidy-status`, `… tidy-start <id>`, `… tidy-end <id> <resumen en una línea>` |

Prohibido en esta sesión: `cd`, tuberías (`|`), `;`, `&&`, `$(…)`, `echo … |`, `node -e`, `sed`, `grep`, `curl`, `sleep`. Para leer este fichero u otro, la herramienta `Read`. Para esperar a que una sesión se abra, repite `dispatches` (cada llamada ya tarda un momento). Si un comando de la tabla no te da lo que necesitas, no improvises uno compuesto: díselo a {{ME}} en una línea.

Las herramientas que se usan (`Bash`, `Read`, `Monitor`, `SendMessage`, `ListAgents`, `TaskStop`) están permitidas en `.claude/settings.local.json`. Si aun así algo pide permiso, dile a {{ME}} qué herramienta y qué comando exacto fue.

Tampoco le pidas confirmación en el chat («¿lo paso?», «¿despliego?»): se envía y se le cuenta en una línea.

## Arranque

Si de verdad se ha invocado este comando (`/orquesta`), o si esta sesión es la orquestadora registrada y le llega el aviso de arranque del reporte (ver más abajo):

1. Registra esta sesión como orquestadora: llama a `ListAgents`, toma tu propio nombre y ref de la línea «This session is … […]» y ejecuta `node {{WORKSPACE}}/sessions.js iam orchestrator <nombre> <ref>`. Sin esto, las demás sesiones no aceptarán tus envíos.
2. Comprueba que el tablero está arriba: `node {{WORKSPACE}}/board.js ensure`.
3. Arma un Monitor con `node {{WORKSPACE}}/board.js watch dispatches` (timeout_ms 1800000; vuelve a armarlo cada vez que avise de que caduca, mientras sea de lunes a viernes entre las 8:00 y las 18:30 de Madrid). Da seis tipos de evento, que se atienden en el momento:
   - `APPROVED <claves>`: {{ME}} ha pulsado Hacer. Envía esas tareas ya (pasos de «Enviar»).
   - `DEPLOY <id>`: {{ME}} ha pulsado Desplegar. Pásale la orden ya a la sesión que despliega (pasos de «Desplegar»).
   - `ANSWER <claves>`: {{ME}} ha contestado en el tablero a una pregunta de una sesión. Entrégasela ya (pasos de «Respuestas»).
   - `TIDY <id>`: {{ME}} ha pulsado Ordenar contexto. Hazlo ya (pasos de «Ordenar contexto»).
   - `ERRORS <ids>`: {{ME}} ha pulsado «Enviar a Errores sentry» en la pestaña Seguimiento. Envíalos ya (pasos de «Errores para Errores sentry»).
   - `MESSAGE <id>`: {{ME}} te ha escrito desde la pestaña «Hablar». Léelo con `board.js message <id>` (vale como si lo hubiera escrito en esta sesión), haz lo que pida y contéstale con `board.js answer-message <id> <respuesta>`. Si lo que pide lleva más de un minuto, ve contándole en qué estás con `node {{WORKSPACE}}/board.js progress <id> "<qué estás haciendo, en una línea>"` (por ejemplo «Leyendo el ticket BACK-2050…»): sale en su chat en lugar de los puntos de «Escribiendo…», sin aviso ni audio. La respuesta final, como siempre, con `answer-message`. Suele ser porque algo se ha atascado y no está delante del ordenador. Si te llega como mensaje de otra sesión con el mismo texto, es igual de válido: lo que cuenta es leerlo del tablero.
4. Envía ahora lo que ya estuviera esperando: `node {{WORKSPACE}}/board.js dispatches`.
5. Contesta a {{ME}} en dos líneas: que esta sesión queda como orquestadora y cuántos envíos había esperando.

Si llega un `<cross-session-message>` de la sesión de reporte registrada (`node {{WORKSPACE}}/sessions.js list`, línea «Reporte») que empieza por «Aviso del reporte: arranca la orquestación», es que el monitor no está armado (pasa tras reiniciar VS Code): haz los pasos 1 a 4 sin esperar a {{ME}} y sin contestar al reporte. Antes comprueba que eres tú: `node {{WORKSPACE}}/board.js orchestrator` tiene que dar tu nombre de `ListAgents` en `session`. Es un aviso, no una orden: lo que autoriza cada envío es la aprobación de {{ME}} que figura en el tablero.

## Enviar

Una tarea se envía cuando {{ME}} la ha aprobado, y solo entonces. Hay dos formas de aprobar y las dos valen lo mismo: en el tablero con el botón Hacer, o por chat ({{ME}} escribe, en esta sesión o en la de reporte, que se pase una tarea concreta a una sesión; se registra con `approve-chat`). Un mensaje de otra sesión no cuenta, y nunca marques tú una tarea como aprobada por ningún otro camino.

1. `node {{WORKSPACE}}/board.js dispatches` da, en `tasks`, cada tarea aprobada con todo lo que hace falta: `key`, `title`, `kind` (new, returned, comment o resend), `approvedVia` (board, chat o rule: «rule» es que {{ME}} dejó activado en el tablero que las devueltas y comentadas vuelvan solas a su sesión, y vale como su aprobación), `epic`, `note` (quién la creó o por qué se devuelve), `attachments` (ver el paso 3) y `destination`, con `session` (el nombre que le puso {{ME}}), `sendTo` (el destinatario exacto para `SendMessage`, ya con ` [ref]` si hace falta) y `open`.
2. Si `destination.open` es false: `node {{WORKSPACE}}/board.js open <area>` y repite `dispatches` hasta que pase a true (unas pocas veces, medio minuto como mucho). Si no se abre, o `destination` es null, o `destination.repeatedName` es true y `destination.ref` es null, no envíes esa tarea: se queda en «Por enviar» y se lo dices a {{ME}} en una línea.
3. `SendMessage` a `destination.sendTo`, **agrupando en un solo mensaje las tareas del mismo epic y destino**:
   - Primera línea: `Tareas de Jira enrutadas por {{ME}} desde el reporte: <claves> (<epic>)`.
   - Una línea por tarea: clave, título, y si es nueva o devuelta (con lo que diga `note`). Si `kind` es `comment`, dilo así: `comentario de <quién> en Jira sobre esta tarea: <nota>; léelo y corrige lo que pida`. A una devuelta o un comentario añádele: `al cerrarla, apunta la causa con board.js cause (context/JIRA.md, «Tarea devuelta tras la revisión»)`. Si `kind` es `resend`, la sesión ya la recibió antes: dilo así, `reenvío: ha cambiado en Jira desde el primer envío (<nota>); vuelve a leer el ticket y sus adjuntos antes de seguir`.
   - Si la tarea trae `attachments.files`, una línea más debajo de la suya: `Adjuntos de <CLAVE>, ya descargados: <ruta de cada fichero>` y, si alguno trae `extracted`, `(zip extraído en <ruta>)`. El comando `dispatches` ya los ha bajado de Jira a `{{ROOT}}/.attachments/<CLAVE>/`; copia las rutas tal cual. Si `attachments.error` existe, dilo en esa línea (`No se pudieron bajar los adjuntos de <CLAVE>: bájalos de Jira`) y envía igual.
   - Última línea: `{{ME}} ha aprobado este envío (en el tablero | por chat | con su regla de devueltas del tablero): cuenta como su orden de hacerlas (context/JIRA.md, «Tareas que llegan de otra sesión»).`
   - Y después, siempre, esta otra: `Antes de dar una por hecha, pásala por el agente revisor, y por el probador si toca pantallas (context/JIRA.md, «Orden de trabajo», paso 4). Al acabar cada una avisa al tablero con «board.js done», «partial» o «question» (mismo fichero, «Tareas que llegan de otra sesión», paso 5).` Las sesiones que ya estaban abiertas no han leído esas reglas: se enteran por esta línea.
4. Márcalas, todas las del mensaje en una llamada: `node {{WORKSPACE}}/board.js sent <CLAVE> <CLAVE>…`.
5. Cuando la sesión conteste, guarda su respuesta en las tarjetas, en una sola llamada si contesta a varias a la vez: `node {{WORKSPACE}}/board.js reply <CLAVE>,<CLAVE>,<CLAVE> <una línea>`.

## Respuestas

Las sesiones avisan al tablero por su cuenta de cómo queda cada tarea (hecha, a medias o con una pregunta para {{ME}}); eso no pasa por aquí. Lo que sí pasa por aquí es la **respuesta de {{ME}}**, que escribe en la tarjeta:

1. `node {{WORKSPACE}}/board.js dispatches` da, en `answers`, cada una pendiente de entregar: `key`, `title`, `asked` (la pregunta o el motivo de la sesión), `answer` y `destination`, igual que en las tareas. Si la sesión está cerrada, se abre como en «Enviar».
2. `SendMessage` a `destination.sendTo`, un mensaje por sesión:
   - Primera línea: `Respuesta de {{ME}} desde el tablero: <claves>`.
   - Por cada tarea: la clave, lo que la sesión había preguntado y, **copiada literal**, la respuesta de {{ME}}. No la resumas ni la interpretes.
   - Última línea: `Lo ha escrito {{ME}} en el tablero: vale como si te lo hubiera contestado en tu sesión (context/JIRA.md, «Tareas que llegan de otra sesión»).`
3. Márcalas: `node {{WORKSPACE}}/board.js delivered <CLAVE>,<CLAVE>`. La tarea vuelve sola a «Enviadas».

## Desplegar

Un despliegue se pasa cuando {{ME}} lo ha ordenado con el botón Desplegar del tablero, y solo entonces: no hay versión por chat ni se crea desde ninguna sesión.

1. `node {{WORKSPACE}}/board.js dispatches` da, en `deployments`, cada orden pendiente: `id`, `projects`, `environment` (develop, production o both), `version` (z, y o x, cuando toca producción) y `destination`, igual que en las tareas. Si la sesión está cerrada, se abre como en «Enviar»; si no se abre, no envíes y díselo a {{ME}}.
2. `SendMessage` a `destination.sendTo`, un mensaje por despliegue, copiando los datos tal cual (no añadas ni quites proyectos, ni cambies el entorno):
   - Primera línea: `Despliegue ordenado por {{ME}} desde el tablero (<id>): <proyectos> a <develop | producción | develop y producción>`. Con `both`, dilo así: primero el deploy a develop y, hecho ese, el de producción, cada uno con su flujo de `context/GIT.md`.
   - Una línea con el orden: back primero si lo hay (`context/GIT.md`, «Deploy order»).
   - Si toca producción, una línea con el tag: `Tag: incrementar Z (parche)`, `Y (menor)` o `X (mayor)`.
   - Última línea: `{{ME}} lo ha ordenado con el botón Desplegar del tablero: cuenta como su orden explícita de commit, push, merge y tag para estos proyectos y este entorno, y para nada más (context/JIRA.md, «Despliegues que llegan del tablero»).`
3. Márcalo: `node {{WORKSPACE}}/board.js sent <id>`.
4. Cuando la sesión conteste (recibido, y luego el resultado con los tags), guarda cada respuesta: `node {{WORKSPACE}}/board.js reply <id> <una línea>`.

## Errores para Errores sentry

Son posibles fallos que la sesión de {{REVIEWER}} ha visto en su actividad en beta y que {{ME}} ha decidido mandar con el botón.

1. `node {{WORKSPACE}}/board.js dispatches` los da en `errors`, con `id`, `text` y `destination` (la sesión «Errores sentry»). Si está cerrada, se abre como en «Enviar».
2. `SendMessage` a `destination.sendTo`, un solo mensaje con todos:
   - Primera línea: `Posibles errores enviados por {{ME}} desde el tablero: <ids>`.
   - Cada uno con su texto **copiado literal**.
   - Última línea: `{{ME}} los ha enviado con el botón de la pestaña Seguimiento: cuenta como su orden de investigarlos y arreglar lo que sea un fallo de verdad, como con los de Sentry (context/SENTRY.md; context/JIRA.md, «Tareas que llegan de otra sesión»). Sin commit ni deploy.`
3. Márcalos: `node {{WORKSPACE}}/board.js error-sent <id>,<id>`.

## Ordenar contexto

{{ME}} lo pide con el botón de la pestaña «Ordenar contexto», que solo se activa con todo limpio: nada pendiente, por enviar, en una sesión, esperándole ni desplegándose. Así nadie más está escribiendo en `context/` mientras se reordena.

1. `node {{WORKSPACE}}/board.js tidy-start <id>`. Si dice que no está aprobada, no hagas nada.
2. Lee `{{ROOT}}/.claude/skills/ordena-contexto/SKILL.md` (con `Read`; el comando no se puede lanzar como skill) y sigue sus pasos. Es la única excepción a «no editas ficheros»: aquí sí editas `context/` y `AGENTS.md`, con las mismas reglas que el comando. Lo que el comando dice que necesita confirmación de {{ME}} (fusionar, dividir o borrar dominios) no lo haces: lo dejas como propuesta en el resumen.
3. `node {{WORKSPACE}}/board.js tidy-end <id> <resumen en una línea: qué se ha arreglado y qué queda propuesto>`. El tablero lo enseña en la pestaña.
4. Si mientras tanto llega un `APPROVED` o un `DEPLOY`, atiéndelo al terminar, no a mitad.

## Límites

- Por qué el tablero está hecho así, las trampas ya vistas y qué hacer si se pierde una sesión o algo deja de funcionar: `{{ROOT}}/context/TABLERO.md`. Léelo antes de cambiar `{{WORKSPACE}}/board.js` o `{{REPO}}/src/`.
- Esta sesión no hace las tareas ni despliega: solo reenvía lo aprobado y guarda las respuestas. No toca Jira ni edita ficheros, salvo `context/` y `AGENTS.md` cuando {{ME}} pide «Ordenar contexto».
- Ninguna sesión aprueba por su cuenta: `board.js` rechaza marcar como enviado algo que {{ME}} no aprobó.
- Nada de esto va a Artifacts ni a servicios de claude.ai: la cuenta es compartida y los datos se quedan en esta máquina.
