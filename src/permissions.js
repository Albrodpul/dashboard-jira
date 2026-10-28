const path = require("path");
const os = require("os");
const config = require("./config");
const { load, mutate, now } = require("./data");
const { loadRoutes } = require("./sessions");

const ORDER_HOURS = 6;
const WAIT_MINUTES = 55;
const REPO = path.join(__dirname, "..");
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^\/([a-z])\//i, "$1:/").toLowerCase();
const EDITABLE = [config.root, REPO, path.join(os.homedir(), ".claude"), os.tmpdir()].map((p) => norm(p).replace(/\/$/, "") + "/");
const SECRET_FILE = /(^|\/)\.env(\.[\w-]+)?$|\.(pem|key|p12|pfx)$|(^|\/)\.mcp\.json$|(^|\/)credentials(\.json)?$/i;

const READ_WORDS = new Set("seq xargs env printenv cscript wscript claude pip pip3 cd ls pwd cat head tail wc grep egrep fgrep rg find sed awk sort uniq cut tr diff cmp comm echo printf test [ true false sleep date basename dirname realpath readlink stat file du df which where whoami type jq nl tee touch mkdir cp mv rm rmdir ln node npm npx yarn pnpm php composer python python3 py pytest vendor/bin/phpunit tasklist netstat set export source . robocopy cmd tar unzip zip gzip base64 sha256sum md5sum iconv dos2unix clear exit".split(" "));
const GIT_READ = new Set("ls-remote for-each-ref reflog name-rev symbolic-ref check-ignore cherry pull status diff log show branch rev-parse rev-list worktree add fetch blame ls-files ls-tree grep remote config shortlog describe merge-base cat-file switch restore mv rm".split(" "));
const GIT_PROTECTED = new Set("commit push merge tag rebase reset stash clean cherry-pick revert am".split(" "));
const GH_READ = /^gh\s+(pr|issue|run|release|workflow|repo)\s+(view|list|diff|checks|status|watch)\b/;
const GH_PROTECTED = /^gh\s+(pr\s+merge|release\s+create|variable|secret|api\b.*-X\s*(POST|PUT|PATCH|DELETE)|workflow\s+run)/i;
const SHELL_WORDS = new Set("then fi do done else elif esac case in function select until local declare readonly unset shift wait trap read true false : !".split(" "));
const PS_WORDS = new Set("foreach for if else elseif while do try catch finally switch { } ( ) % ? start-sleep sleep param return break continue".split(" "));
const PROTECTED_WORDS = new Set("aws ssh scp sftp sam eb terraform kubectl".split(" "));

const JIRA_READ = /^mcp__jira__(get|search|lookup|fetch|atlassianUserInfo)/;
const JIRA_ON_TASK = /^mcp__jira__(editJiraIssue|transitionJiraIssue)$/;
const ALWAYS_TOOLS = new Set("Read Grep Glob Agent Task Skill TaskStop TaskOutput SendMessage ListAgents ToolSearch WebSearch WebFetch AskUserQuestion ScheduleWakeup CronCreate CronDelete CronList PushNotification EnterWorktree ExitWorktree EnterPlanMode ExitPlanMode TodoWrite ReportFindings ListMcpResourcesTool ReadMcpResourceTool ReadMcpResourceDirTool LSP".split(" "));

function segments(command) {
  const text = String(command).replace(/\\\r?\n/g, " ").replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<$2$3");
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        cur += ch + text[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if ((ch === "$" && text[i + 1] === "(") || ch === "\x60") {
      out.push(cur);
      cur = "";
      if (ch === "$") i++;
      continue;
    }
    if (ch === ")" && !/\(\s*$/.test(cur)) {
      out.push(cur);
      cur = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && text[i + 1] !== ">" && text[i - 1] !== ">")) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function words(segment) {
  let s = segment.replace(/^(\(|\{)\s*/, "");
  s = s.replace(/^(function\s+)?[A-Za-z_][\w-]*\s*\(\)\s*\{?\s*/, "");
  while (/^(then|do|else|elif|\{|\}|!)\s+/.test(s)) s = s.replace(/^(then|do|else|elif|\{|\}|!)\s+/, "");
  while (/^[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s+/.test(s)) s = s.replace(/^[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s+/, "");
  s = s.replace(/^(timeout\s+\S+|time|nice|nohup|exec|command)\s+/, "");
  const first = (s.split(/\s+/)[0] || "").replace(/^["']|["']$/g, "");
  return { rest: s, cmd: path.basename(first.replace(/\\/g, "/")).replace(/\.(exe|cmd|bat)$/i, "").toLowerCase(), raw: first };
}

const DB_WRITE = /(^|[;\n("'`]|\s-e\s*["']?)\s*(insert|update|delete|alter|drop|truncate|create|replace\s+into|grant|revoke|rename\s+table|load\s+data|set\s+global)\b/im;

function sqlOf(rest, cwd, whole) {
  const file = (/<\s*("[^"]+"|'[^']+'|\S+\.sql)/.exec(rest) || [])[1];
  if (!file) return rest;
  try {
    return rest + "\n" + require("fs").readFileSync(path.resolve(cwd || config.root, file.replace(/["']/g, "")), "utf8");
  } catch (e) {
    return rest + "\n" + (whole || "");
  }
}

function inRepo(p, repo) {
  return norm(p).startsWith(norm(repo).replace(/\/$/, "") + "/") || norm(p) === norm(repo).replace(/\/$/, "");
}

function classifySegment(segment, cwd) {
  const { rest, cmd, raw } = words(segment);
  if (!cmd) return { kind: "allow" };
  if (/^["']/.test(rest) || /^[A-Za-z_][\w-]*\s*\(\)\s*\{?\s*$/.test(rest) || /^[A-Za-z_]\w*=/.test(rest)) return { kind: "allow" };
  if (SHELL_WORDS.has(cmd)) return { kind: "allow" };
  if (cmd === "git") {
    const m = /^git\s+(?:(?:-C\s+("[^"]+"|\S+)|-c\s+\S+|--no-pager)\s+)*([\w-]+)/.exec(rest);
    const sub = m ? m[2] : "";
    const where = m && m[1] ? m[1].replace(/"/g, "") : cwd;
    const after = m ? rest.slice(m[0].length) : "";
    if (GIT_PROTECTED.has(sub) || (sub === "checkout" && /^\s*(--(\s|$)|\.(\s|$)|-f\b)/.test(after))) {
      if (["commit", "push", "pull"].includes(sub) && inRepo(where, REPO)) return { kind: "allow" };
      return { kind: "protected", key: `git ${sub}`, git: ["commit", "push", "merge", "tag"].includes(sub) ? sub : null, label: `git ${sub}` };
    }
    if (sub === "checkout") return { kind: "allow" };
    if (GIT_READ.has(sub)) return { kind: "allow" };
    return { kind: "ask", key: `git ${sub}`, label: `git ${sub}` };
  }
  if (cmd === "gh") {
    if (GH_PROTECTED.test(rest)) return { kind: "protected", key: "gh", git: /pr\s+merge/.test(rest) ? "merge" : null, label: rest.split(/\s+/).slice(0, 3).join(" ") };
    if (GH_READ.test(rest)) return { kind: "allow" };
    return { kind: "ask", key: `gh ${rest.split(/\s+/)[1] || ""}`.trim(), label: rest.split(/\s+/).slice(0, 3).join(" ") };
  }
  if (cmd === "ssh" && /\s-[A-Za-z]*[LN]/.test(rest) && !/\bmysql\b/.test(rest)) return { kind: "allow" };
  if (cmd === "ssh" && /\bmysql\b/.test(rest)) return DB_WRITE.test(sqlOf(rest, cwd, WHOLE.text)) ? { kind: "protected", key: "bd remota escritura", label: "escribir en una base de datos remota" } : { kind: "allow" };
  if (["ssh", "scp", "rsync", "sftp"].includes(cmd) && (config.trustedHosts || []).some((host) => rest.includes(host))) return { kind: "allow" };
  if (PROTECTED_WORDS.has(cmd)) return { kind: "protected", key: cmd, label: cmd };
  if (cmd === "mysql" || cmd === "mysqldump" || cmd === "mysqladmin") {
    const host = (/(?:-h\s*|--host[= ])(\S+)/.exec(rest) || [])[1];
    const port = (/(?:-P\s*|--port[= ])(\d+)/.exec(rest) || [])[1];
    const remote = (host && !/^(localhost|127\.0\.0\.1|::1)$/i.test(host.replace(/["']/g, ""))) || (port && port !== "3306");
    if (remote && (cmd !== "mysql" || DB_WRITE.test(sqlOf(rest, cwd, WHOLE.text)))) return { kind: "protected", key: "bd remota escritura", label: `${cmd} con escritura contra ${host || "el puerto " + port}` };
    return { kind: "allow" };
  }
  if (cmd === "node" && /^node\s+\S*jira-write/.test(rest)) {
    const m = /jira-write(?:\.js)?\s+([\w-]+)\s+([A-Z][A-Z0-9]+-\d+)/.exec(rest);
    if (m && !/comment|mention/.test(m[1])) return { kind: "protected", key: "jira-write", jiraKey: m[2], label: `${m[1] === "assign" ? "asignarse" : "mover"} ${m[2]} en Jira` };
    return { kind: "protected", key: "jira-write", label: m ? `comentar en ${m[2]} en Jira` : "escribir en Jira" };
  }
  if (cmd === "curl" || cmd === "wget") {
    const url = (/(https?:\/\/[^\s"']+)/.exec(rest) || [])[1] || "";
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url + "/")) return { kind: "allow" };
    return { kind: "ask", key: `${cmd} ${url.replace(/^https?:\/\/([^/]+).*/, "$1")}`, label: `${cmd} a ${url.replace(/^https?:\/\/([^/]+).*/, "$1")}` };
  }
  if (cmd === "taskkill") return /\/IM\b/i.test(rest) ? { kind: "ask", key: "taskkill /IM", label: "taskkill por nombre (mata los procesos de todas las sesiones)" } : { kind: "allow" };
  if (cmd === "bash" || cmd === "sh") {
    const script = rest.split(/\s+/)[1] || "";
    if (!script || script.startsWith("-")) return { kind: "allow" };
    return inRepo(path.resolve(cwd || config.root, script), config.root) || inRepo(path.resolve(cwd || config.root, script), REPO) ? { kind: "allow" } : { kind: "ask", key: `bash ${path.basename(script)}`, label: `bash ${script}` };
  }
  if (cmd === "npm" && /\bnpm\s+publish\b/.test(rest)) return { kind: "ask", key: "npm publish", label: "npm publish" };
  if (READ_WORDS.has(cmd)) return { kind: "allow" };
  if (raw.startsWith("$") || PS_WORDS.has(cmd) || /^[-)(<>]|[()]/.test(raw)) return { kind: "allow" };
  if (cmd === "powershell" || cmd === "pwsh") {
    const m = /-(?:Command|c)\s+("([^"]*)"|'([^']*)'|(.*))$/is.exec(rest);
    const inner = m ? m[2] || m[3] || m[4] || "" : "";
    return inner ? classifyCommand(inner, cwd) : { kind: "allow" };
  }
  if (/^(invoke-restmethod|invoke-webrequest|irm|iwr)$/.test(cmd)) {
    const url = (/(https?:\/\/[^\s"']+)/.exec(rest) || [])[1] || "";
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url + "/") ? { kind: "allow" } : { kind: "ask", key: `${cmd} ${url.replace(/^https?:\/\/([^/]+).*/, "$1")}`, label: `${cmd} a ${url.replace(/^https?:\/\/([^/]+).*/, "$1")}` };
  }
  if (/^(get|select|where|foreach|sort|measure|format|out|write|test|join|split|resolve|convertfrom|convertto|new|copy|move|remove|rename|set|add|group|compare|import|export|clear|expand|compress)-[a-z]+$/.test(cmd) && !/^(set-executionpolicy|new-service|remove-service)$/.test(cmd)) return { kind: "allow" };
  if (raw.startsWith("./") || raw.startsWith("../") || /^[a-z]:[\\/]/i.test(raw) || raw.startsWith("/")) {
    const target = path.resolve(cwd || config.root, raw);
    if (inRepo(target, config.root) || inRepo(target, REPO) || /xampp\/(mysql|php)\/bin/i.test(norm(target))) return { kind: "allow" };
  }
  return { kind: "ask", key: cmd, label: cmd };
}

const WHOLE = { text: "" };

function expandVars(command) {
  const vars = {};
  for (const m of String(command).matchAll(/(?:^|[;&|\n]\s*)([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|]+)/g)) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  return String(command).replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, k) => (k in vars ? vars[k] : all));
}

function classifyCommand(command, cwd) {
  command = expandVars(command);
  WHOLE.text = command;
  const parts = [];
  const defined = new Set([...command.matchAll(/(?:^|[\n;&|]\s*)(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/g)].map((m) => m[1].toLowerCase()));
  let where = cwd;
  for (const seg of segments(command)) {
    if (/^([A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s*)+$/.test(seg)) continue;
    const cd = /^cd\s+(?:\/d\s+)?("[^"]+"|'[^']+'|\S+)\s*$/i.exec(seg);
    if (cd) {
      where = path.resolve(where || config.root, cd[1].replace(/["']/g, "").replace(/^\/([a-z])\//i, "$1:/"));
      continue;
    }
    const c = classifySegment(seg, where);
    parts.push(c.kind === "ask" && defined.has(c.key) ? { kind: "allow" } : c);
  }
  return parts.find((p) => p.kind === "protected") || parts.find((p) => p.kind === "ask") || { kind: "allow" };
}

function classify(tool, input, cwd) {
  input = input || {};
  if (tool === "Bash" || tool === "PowerShell" || tool === "Monitor") return input.command ? classifyCommand(input.command, cwd) : { kind: "allow" };
  if (["Read", "Grep", "Glob"].includes(tool)) {
    const p = input.file_path || input.path || "";
    return p && SECRET_FILE.test(norm(p)) ? { kind: "ask", key: `${tool} secreto`, label: `leer ${path.basename(p)} (puede tener secretos)` } : { kind: "allow" };
  }
  if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) {
    const p = norm(input.file_path || input.notebook_path || "");
    if (SECRET_FILE.test(p)) return { kind: "ask", key: `${tool} secreto`, label: `editar ${path.basename(p)}` };
    return EDITABLE.some((root) => p.startsWith(root)) ? { kind: "allow" } : { kind: "ask", key: `${tool} fuera`, label: `editar fuera de los repos: ${p}` };
  }
  if (ALWAYS_TOOLS.has(tool)) return { kind: "allow" };
  if (JIRA_READ.test(tool) || /^mcp__playwright__/.test(tool) || /^mcp__sentry__(?!update_issue)/.test(tool) || tool === "mcp__claude-vscode__getDiagnostics") return { kind: "allow" };
  if (JIRA_ON_TASK.test(tool)) return { kind: "protected", key: tool, jiraKey: input.issueIdOrKey || input.issueKey || null, label: tool === "mcp__jira__transitionJiraIssue" ? "mover una tarea en Jira" : "editar una tarea en Jira" };
  if (/^mcp__jira__/.test(tool)) return { kind: "protected", key: tool, label: "escribir en Jira" };
  if (tool === "mcp__sentry__update_issue") return { kind: "protected", key: tool, label: "cambiar un error en Sentry" };
  if (/^Artifact/.test(tool)) return { kind: "ask", key: tool, label: "publicar en claude.ai (la cuenta es compartida)" };
  return { kind: "ask", key: tool, label: tool };
}

function areaOf(conversation) {
  const r = loadRoutes();
  for (const [id, a] of Object.entries(r.areas || {})) if (a.conversation === conversation) return { id, name: a.title || id };
  for (const [role, name] of [["reporter", "Reporte"], ["orchestrator", "Orquestadora"], ["followUp", "Seguimiento"], ["board", "Tablero"]]) if (r[role] && r[role].conversation === conversation) return { id: role, name };
  return null;
}

function liveName(conversation) {
  try {
    const live = (require("./sessions").liveSessions() || []).find((s) => s.conversation === conversation);
    return live ? `${live.title || live.name} (sin registrar)` : null;
  } catch (e) {
    return null;
  }
}

function hasOrder(c, area, d) {
  if (!area) return false;
  const recent = (iso) => iso && Date.now() - new Date(iso).getTime() < ORDER_HOURS * 3600000;
  if (c.git) return d.deployments.some((x) => x.area === area.id && ["approved", "sent"].includes(x.status) && recent(x.sentAt || x.at));
  if (c.jiraKey) {
    const t = d.tasks[String(c.jiraKey).toUpperCase()];
    return !!t && t.area === area.id && ["sent", "waiting", "partial", "done"].includes(t.status);
  }
  return false;
}

function detailOf(tool, input) {
  if (input && input.command) return String(input.command);
  if (input && (input.file_path || input.notebook_path)) return String(input.file_path || input.notebook_path);
  return JSON.stringify(input || {}).slice(0, 1500);
}

function check({ session_id: conversation, tool_name: tool, tool_input: input, cwd }) {
  const c = classify(tool, input, cwd);
  if (c.kind === "allow") return { decision: "allow" };
  const d = load();
  if (c.kind === "ask" && (d.permissionRules || []).some((r) => r.key === c.key)) return { decision: "allow" };
  const area = areaOf(conversation);
  if (c.kind === "protected" && hasOrder(c, area, d)) return { decision: "allow" };
  const id = "perm-" + now().replace(/[^0-9]/g, "").slice(0, 17) + Math.floor(Math.random() * 90 + 10);
  mutate((x) => {
    x.permissions = [{ id, conversation, area: area && area.id, areaName: area ? area.name : liveName(conversation), tool, label: c.label, key: c.key, protected: c.kind === "protected", detail: detailOf(tool, input).slice(0, 1500), input: JSON.stringify(input || {}).length < 30000 ? input : null, cwd: cwd || null, status: "pending", at: now() }, ...(x.permissions || [])].slice(0, 100);
  });
  require("./push")
    .sendPush("permission", true, `${area ? area.name : "Una sesión"} pide permiso: ${c.label}`)
    .catch(() => {});
  return { decision: "wait", id, waitMinutes: WAIT_MINUTES };
}

function expire(d) {
  for (const p of d.permissions || []) if (p.status === "pending" && Date.now() - new Date(p.at).getTime() > (WAIT_MINUTES + 2) * 60000) Object.assign(p, { status: "expired", decidedAt: now() });
}

function poll(id) {
  const p = (load().permissions || []).find((x) => x.id === id);
  if (!p) return { status: "missing" };
  if (p.status === "pending" && Date.now() - new Date(p.at).getTime() > WAIT_MINUTES * 60000) {
    mutate((d) => expire(d));
    return { status: "expired" };
  }
  if (p.status === "pending" && recheck(p)) return { status: "allowed", reason: null };
  return { status: p.status, reason: p.reason || null };
}

function recheck(p) {
  const input = p.input || (p.detail.length < 1500 && ["Bash", "PowerShell", "Monitor"].includes(p.tool) ? { command: p.detail } : null);
  if (!input) return false;
  const c = classify(p.tool, input, p.cwd);
  const d = load();
  const passes = c.kind === "allow" || (c.kind === "ask" && (d.permissionRules || []).some((r) => r.key === c.key)) || (c.kind === "protected" && hasOrder(c, p.area ? { id: p.area } : null, d));
  if (!passes) return false;
  mutate((x) => {
    const q = (x.permissions || []).find((y) => y.id === p.id);
    if (q && q.status === "pending") Object.assign(q, { status: "allowed", reason: "Ya no hacía falta: el filtro corregido lo deja pasar solo", decidedAt: now(), auto: true });
  });
  return true;
}

function decide(id, decision, reason) {
  return mutate((d) => {
    const p = (d.permissions || []).find((x) => x.id === id);
    if (!p || p.status !== "pending") return false;
    const always = decision === "always" && !p.protected;
    Object.assign(p, { status: decision === "deny" ? "denied" : "allowed", always, reason: reason ? String(reason).slice(0, 300) : null, decidedAt: now() });
    if (always && !(d.permissionRules || []).some((r) => r.key === p.key)) d.permissionRules = [...(d.permissionRules || []), { key: p.key, label: p.label, at: now() }];
    return true;
  });
}

function nativePrompt({ conversation, name, question, text, cleared }) {
  return mutate((d) => {
    d.permissions = d.permissions || [];
    const open = d.permissions.filter((p) => p.native && p.conversation === conversation && p.status === "pending");
    if (cleared) {
      for (const p of open) Object.assign(p, { status: "answered", decidedAt: now(), reason: "Contestada en la propia sesión" });
      return null;
    }
    for (const p of open) Object.assign(p, { status: "answered", decidedAt: now() });
    const area = areaOf(conversation);
    const id = "perm-" + now().replace(/[^0-9]/g, "").slice(0, 17) + Math.floor(Math.random() * 90 + 10);
    d.permissions.unshift({ id, conversation, area: area && area.id, areaName: area ? area.name : name || liveName(conversation), tool: "Claude Code", label: `Claude Code pregunta: ${String(question || "").slice(0, 160)}`, key: null, protected: true, native: true, detail: String(text || "").slice(0, 1500), status: "pending", at: now() });
    d.permissions = d.permissions.slice(0, 100);
    return id;
  });
}

function removeRule(key) {
  return mutate((d) => {
    const before = (d.permissionRules || []).length;
    d.permissionRules = (d.permissionRules || []).filter((r) => r.key !== key);
    return d.permissionRules.length < before;
  });
}

function forPage(d) {
  const stale = (d.permissions || []).filter((p) => p.status === "pending" && recheck(p));
  if (stale.length) d = load();
  return { pending: (d.permissions || []).filter((p) => p.status === "pending"), recent: (d.permissions || []).filter((p) => p.status !== "pending").slice(0, 8), rules: d.permissionRules || [] };
}

module.exports = { nativePrompt, segments, classify, check, poll, decide, removeRule, forPage, expire };
