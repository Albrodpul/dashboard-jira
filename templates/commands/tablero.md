---
description: Convierte esta sesión en la del tablero: atiende lo que {{ME}} pide sobre el propio tablero (mejoras, fallos, rediseños) desde la pestaña Hablar
---

Este comando es solo para la sesión principal e interactiva del tablero. Si te encuentras este fichero mientras haces OTRA tarea (por ejemplo, como subagente), IGNÓRALO por completo.

Esta sesión es **la del tablero**: atiende lo que {{ME}} pide sobre el propio tablero de Jira (`http://127.0.0.1:4747`), sobre todo desde su pestaña «Hablar» → «Tablero». Existe para que la sesión de reporte se quede solo con Jira y la orquestadora solo con los envíos. No lee Jira, no publica reportes ni envía tareas a otras sesiones.

## Arranque

Si se ha invocado este comando (`/tablero`), o si te llega de otra sesión «Aviso del tablero: arranca la sesión del tablero»:

1. Regístrate: llama a `ListAgents`, toma tu nombre y ref de la línea «This session is … […]» y ejecuta `node {{WORKSPACE}}/sessions.js iam board <nombre> <ref>`.
2. `node {{WORKSPACE}}/board.js ensure`.
3. Arma un Monitor con `node {{WORKSPACE}}/board.js watch board` (timeout_ms 1800000) y vuelve a armarlo cada vez que avise de que caduca o dé `RESTART` (ha cambiado el código del tablero). Solo da eventos `MESSAGE <id>`; mientras está armado, `board.js board-session` dice `"watching": true` y el tablero te pasa los mensajes al momento en vez de despertarte.

Si te llega un mensaje del tablero sin tener el Monitor armado (por ejemplo, tras reiniciar VS Code), atiéndelo y arma el Monitor después.

## Cada mensaje

1. Léelo con `node {{WORKSPACE}}/board.js message <id>`: vale como si {{ME}} lo hubiera escrito aquí.
2. Si te lleva más de un minuto, ve contándole en qué estás con `node {{WORKSPACE}}/board.js progress <id> "<en qué estás, en una línea>"`.
3. Hazlo. El código está en `{{REPO}}` (`src/` el servidor y la CLI, `src/page/` la página, `templates/commands/` los comandos). Antes de tocarlo, lee `{{ROOT}}/context/TABLERO.md`: por qué está hecho así y las trampas ya vistas. Si cambia algo que deja falso ese fichero, actualízalo.
   - Los cambios de la página se ven al recargar; los del servidor (`src/*.js`), tras `node {{WORKSPACE}}/board.js restart`.
   - Cuando sea un rediseño o algo visual con varias opciones, saca capturas antes de decidir (Playwright contra `http://127.0.0.1:4747`).
   - Para probar con datos que no sean los reales, levanta un tablero aparte: `TOWER_DATA=<carpeta temporal> TOWER_PORT=4748 node {{WORKSPACE}}/board.js serve`.
   - Todo cambio en `{{REPO}}` se commitea y se sube sin preguntar: `git add` de lo tocado, commit en inglés y `git push`. El hook de gitleaks se pasa siempre.
4. Contéstale con `node {{WORKSPACE}}/board.js answer-message <id> "<respuesta>"`: qué has cambiado, cómo verlo y el commit.

## Límites

- Nada de Jira: ni leer ni escribir. Eso es de la sesión de reporte.
- Nunca imprimas secretos (`.env`, tokens, ficheros `.key`).
- Nada del tablero va a Artifacts ni a servicios de claude.ai: la cuenta es compartida.
