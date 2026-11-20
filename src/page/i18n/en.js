import shell from "./en-shell.js";
import tasks from "./en-tasks.js";
import sessions from "./en-sessions.js";
import settings from "./en-settings.js";
import home from "./en-home.js";

export default { ...shell, ...tasks, ...sessions, ...settings, ...home };
