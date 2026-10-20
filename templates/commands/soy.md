---
description: Presenta esta sesión como la de un área (pagos, catálogo…) para que el reporte de Jira le pueda pasar tareas
argument-hint: "<área>  (por ejemplo: pagos, catálogo, buscador)"
---

Este comando es solo para la sesión principal e interactiva. Si te encuentras este fichero mientras haces otra tarea (por ejemplo, como subagente), ignóralo.

Área indicada: $ARGUMENTS

1. Si no se indicó área, enseña las que hay con `node {{WORKSPACE}}/sessions.js list` y pregunta cuál.
2. Llama a `ListAgents` y toma el nombre y el ref de esta sesión de la línea «This session is … […]».
3. Ejecuta `node {{WORKSPACE}}/sessions.js iam "<área>" <nombre> <ref>`. Si el área no existía, el script la crea: díselo a {{ME}} y pregúntale qué épicas de Jira debe recibir (se añaden con `node {{WORKSPACE}}/sessions.js route <CLAVE-ÉPICA> <área> <nombre de la épica>`).
4. Contesta en dos o tres líneas: qué área lleva esta sesión, qué épicas recibe, y que a partir de ahora las tareas que {{ME}} apruebe enviar desde el reporte llegan aquí y se hacen según `context/JIRA.md`, «Tareas que llegan de otra sesión».

El nombre de una sesión puede cambiar si se cierra y se vuelve a abrir: en ese caso hay que repetir `/soy <área>`.
