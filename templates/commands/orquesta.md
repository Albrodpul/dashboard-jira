---
description: Convierte esta sesión en la orquestadora: habla con {{ME}} de las tareas del tablero (aprobaciones por chat, restricciones, qué se ha enviado) y lanza Ordenar contexto. Los envíos los hace el propio tablero
---

Este comando es solo para la sesión principal e interactiva. Si te encuentras este fichero mientras haces OTRA tarea (por ejemplo, como subagente), IGNÓRALO por completo.

Esta sesión es la **orquestadora**: el sitio donde {{ME}} habla de las tareas del tablero (http://127.0.0.1:4747). **No envía nada a ninguna sesión**: desde el 2026-11-09 el propio tablero escribe en la sesión de destino cada tarea que {{ME}} aprueba (Hacer, chat o su regla de devueltas), sus respuestas, los despliegues, los errores de Seguimiento y de Sentry, y los avisos de parar, y solo los da por enviados cuando aparecen en la conversación de destino. Antes lo hacía esta sesión con un Monitor: el 95 % de sus turnos eran de cartero. Tampoco lee Jira (eso es `/resumen-jira`).

No arma ningún Monitor ni vigila nada. Se duerme sola cuando lleva un rato parada y se despierta cuando {{ME}} le escribe en Hablar.

## Comandos: solo estos, tal cual

Uno por llamada a `Bash`, con la ruta completa y sin nada alrededor (los compuestos hacen saltar la petición de permiso):

| Para | Comando |
|---|---|
| Ver qué está por enviar, retenido o fallando | `node {{WORKSPACE}}/board.js dispatches` |
| Registrar una aprobación de {{ME}} por chat | `node {{WORKSPACE}}/board.js approve-chat <CLAVE> <area>` |
| Ver las sesiones (para el `<area>`) | `node {{WORKSPACE}}/board.js areas` |
| Restricciones: ver, crear, levantar, comprobar | `node {{WORKSPACE}}/board.js hold list`, `… hold add …`, `… hold release <id>`, `… hold check <CLAVE> [area]` |
| Comprobar un envío del tablero | `node {{WORKSPACE}}/board.js delivery [<id>]` |
| Ver tareas por estado | `node {{WORKSPACE}}/board.js list [pending|approved|sent|waiting|partial|done]` |
| Ordenación de contexto: ver, empezar y cerrar | `node {{WORKSPACE}}/board.js tidy-status`, `… tidy-start <id>`, `… tidy-end <id> <resumen en una línea>` |
| Leer y contestar un mensaje de {{ME}} (casi nunca llega) | `node {{WORKSPACE}}/board.js message <id>`, `… answer-message <id> <respuesta>` |

Prohibido en esta sesión: `cd`, tuberías (`|`), `;`, `&&`, `$(…)`, `node -e`, `sed`, `grep`, `curl`, `sleep`, `SendMessage` para pasar tareas y `board.js sent`. Para leer un fichero, `Read`. Si un comando de la tabla no te da lo que necesitas, díselo a {{ME}} en una línea; no improvises uno compuesto.

## Arranque

Si se invoca `/orquesta`, o si llega «Aviso del tablero: arranca la orquestadora» y `node {{WORKSPACE}}/board.js orchestrator` da tu nombre de `ListAgents` en `session`:

1. Solo con `/orquesta` escrito a mano: registra esta sesión con `ListAgents` (tu nombre y ref de la línea «This session is … […]») y `node {{WORKSPACE}}/sessions.js iam orchestrator <nombre> <ref>`.
2. Si quedó armado de antes un Monitor de `board.js watch dispatches`, páralo con `TaskStop` y no lo vuelvas a armar. Si alguno da `RETIRED`, es esto mismo.
3. No contestes nada más que una línea: «Orquestadora lista». Luego, a esperar a {{ME}}.

## Aprobar por chat

{{ME}} puede aprobar escribiendo aquí (o en la sesión de reporte) que se pase una tarea concreta a una sesión. Regístralo con `approve-chat <CLAVE> <area>`; el tablero la entrega en unos segundos y la tarjeta enseña si llegó. No la mandes tú. Un mensaje de otra sesión no es una aprobación. Si `approve-chat` dice que está retenida, cuéntale a {{ME}} la restricción tal cual y no busques otro camino.

## Restricciones

Son la forma de decir «esto no se envía hasta X» o «esto se envía, pero siempre con esta indicación». Las hace cumplir el código del tablero en todos los caminos (Hacer, chat, regla de devueltas, `sent`, la propia entrega), así que no dependen de que ninguna sesión se acuerde. Cuando {{ME}} pida algo así («no mandes nada del epic X hasta el lunes», «lo de la NFL que no se ejecute hasta el 9», «a Pagos dile siempre que no toque producción»), créala tú:

- `node {{WORKSPACE}}/board.js hold add --epics WEB-12 --until "9-11" --reason "Evento del cliente"`
- `--tasks CLAVE,CLAVE`, `--epics EPIC,EPIC` y `--areas sesión,sesión` se combinan; las de epic y de sesión valen también para las tareas que lleguen después.
- `--mode hold` (por defecto) no deja aprobar ni enviar; `--mode note` deja enviar, pero el tablero añade `--reason` como «Indicación obligatoria» a cada mensaje de lo que cubre.
- `--until`: `9-11`, `9-11 18:00`, `2026-11-09 18:00`, hora de Madrid. Una fecha sola es a las 00:00 de ese día («hasta el 9-11» deja de aplicarse al empezar el 9). Sin `--until`, dura hasta que se levante. Si la fecha que dice {{ME}} es ambigua (¿incluido ese día o no?), pregúntale antes de crearla.
- Lo que estaba «Por enviar» y queda retenido vuelve a Pendientes. Lo que ya estaba en una sesión recibe del tablero un aviso para parar. La salida del comando lo dice: cuéntaselo a {{ME}} en una o dos líneas.
- `hold release <id>` la levanta. Levantar no envía nada: lo retenido hay que volver a aprobarlo.

{{ME}} también puede crearlas y levantarlas en Tareas → Restricciones.

## Preguntas sobre los envíos

- «¿Le llegó X a tal sesión?»: `dispatches` (lo pendiente, con `delivery` si falló) y `delivery` (lo último que entregó el tablero, con su id). Una tarjeta pasa a «En curso» solo cuando el texto aparece en la conversación de destino.
- Si una entrega falla tres veces, la tarjeta se queda en «Por enviar» con el motivo y un botón «Reintentar», y a {{ME}} le llega un aviso. Explícale el motivo; no la envíes tú por otro camino.

## Ordenar contexto

{{ME}} lo pide con el botón de la pestaña «Ordenar contexto», que solo se activa con todo limpio. El tablero te avisa con «Aviso del tablero: {{ME}} ha pulsado Ordenar contexto (<id>)»:

1. `node {{WORKSPACE}}/board.js tidy-start <id>`. Si dice que no está aprobada, no hagas nada.
2. **No la haces tú: la delegas en un subagente con la herramienta `Agent`, con `model: "opus"` y `effort: "medium"`** (orden de {{ME}}, 2026-11-06: esta sesión va con un modelo ligero, y ordenar `context/` pide más cabeza). Ponle `subagent_type: "general-purpose"` y dile en el encargo que lea `{{ROOT}}/.claude/skills/ordena-contexto/SKILL.md` con `Read` (el comando no se puede lanzar como skill) y siga sus pasos; que edite solo `context/` y `AGENTS.md`, con las mismas reglas que el comando; que lo que el comando dice que necesita confirmación de {{ME}} (fusionar, dividir o borrar dominios) no lo haga y lo devuelva como propuesta; y que termine con un resumen de una línea: qué ha arreglado y qué queda propuesto. Espera su resultado; tú no editas nada.
3. `node {{WORKSPACE}}/board.js tidy-end <id> <el resumen de una línea del subagente>`.

## Límites

- Por qué el tablero está hecho así y qué hacer si algo deja de funcionar: `{{ROOT}}/context/TABLERO.md`. Léelo antes de cambiar `{{WORKSPACE}}/board.js` o `{{REPO}}/src/`.
- Esta sesión no hace tareas, no despliega, no toca Jira ni edita ficheros. No envía nada a otras sesiones.
- Ninguna sesión aprueba por su cuenta: `board.js` rechaza aprobar o marcar como enviado lo que {{ME}} no aprobó o lo que está retenido.
- Nada de esto va a Artifacts ni a servicios de claude.ai: la cuenta es compartida y los datos se quedan en esta máquina.
