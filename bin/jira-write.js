// Writes to Jira with the API token from the workspace .env.
//
//   node jira-write.js assign  KEY-1234                      assigns it to you (jira.me in board.config.json)
//   node jira-write.js start   KEY-1234                      transitions.start
//   node jira-write.js todo    KEY-1234                      transitions.todo
//   node jira-write.js block   KEY-1234                      transitions.block
//   node jira-write.js sprint  KEY-1234                      moves it to the active sprint unless it is already there
//   node jira-write.js comment KEY-1234 'line 1||line 2'
//   node jira-write.js mention KEY-1234 <accountId> '<Name>' 'line 1||line 2'
//   node jira-write.js edit-comment KEY-1234 <commentId> 'line 1||line 2'
//   node jira-write.js edit-mention KEY-1234 <commentId> <accountId> '<Name>' 'line 1||line 2'
//   node jira-write.js create PROJ task.md parent=PROJ-1 priority=Low labels=a,b blocks=OTHER-1 [sprint=no] [type=Story]
//                                                             creates the issue from a .md (see issueFromMarkdown) and moves it to the active sprint
//
// «||» separates paragraphs: a shell argument can't carry reliable line breaks.
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const credentials = config.credentials();
const auth = 'Basic ' + Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64');
const base = `https://${credentials.site}/rest/api/3`;
const agile = `https://${credentials.site}/rest/agile/1.0`;
const ME = config.jira.me.id;
const TRANSITIONS = config.jira.transitions;

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  console.log(method, url, res.status, (await res.text()).slice(0, 200));
}

async function get(url) {
  const res = await fetch(agile + url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function moveToActiveSprint(key) {
  const issue = await get(`/issue/${key}?fields=sprint`);
  if (issue.fields.sprint?.state === 'active') {
    console.log(key, 'ya está en el sprint activo', issue.fields.sprint.name);
    return;
  }
  const boards = await get(`/board?projectKeyOrId=${key.split('-')[0]}&type=scrum`);
  for (const board of boards.values) {
    const sprints = await get(`/board/${board.id}/sprint?state=active`);
    const sprint = sprints.values[0];
    if (!sprint) continue;
    const res = await fetch(`${agile}/sprint/${sprint.id}/issue`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issues: [key] }),
    });
    console.log(key, '→', sprint.name, res.status, (await res.text()).slice(0, 200));
    return;
  }
  console.error('No hay sprint activo en ningún tablero de', key.split('-')[0]);
  process.exit(1);
}

function doc(text, mention) {
  return {
    type: 'doc',
    version: 1,
    content: text.split('||').map((line, index) => ({
      type: 'paragraph',
      content: index === 0 && mention
        ? [{ type: 'mention', attrs: { id: mention.id, text: '@' + mention.name } }, { type: 'text', text: ' ' + line }]
        : [{ type: 'text', text: line }],
    })),
  };
}

function inline(text) {
  return text.split(/(`[^`]+`)/).filter(Boolean).map((part) => part.startsWith('`')
    ? { type: 'text', text: part.slice(1, -1), marks: [{ type: 'code' }] }
    : { type: 'text', text: part });
}

function item(text, children) {
  return { type: 'listItem', content: [{ type: 'paragraph', content: inline(text) }, ...children] };
}

// Minimal Markdown: «# title» (first line), «## section», paragraphs, «- » and «1. » lists, and one indented sublist level.
function issueFromMarkdown(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const summary = lines.shift().replace(/^#\s*/, '').trim();
  const content = [];
  let list = null;

  for (const line of lines) {
    const nested = line.match(/^\s{2,}-\s+(.*)$/);
    const bullet = line.match(/^-\s+(.*)$/);
    const ordered = line.match(/^\d+\.\s+(.*)$/);

    if (nested && list) {
      const parent = list.content[list.content.length - 1];
      let sublist = parent.content.find((node) => node.type === 'bulletList');
      if (!sublist) parent.content.push(sublist = { type: 'bulletList', content: [] });
      sublist.content.push(item(nested[1], []));
    } else if (bullet || ordered) {
      const type = bullet ? 'bulletList' : 'orderedList';
      if (!list || list.type !== type) content.push(list = { type, content: [] });
      list.content.push(item((bullet || ordered)[1], []));
    } else {
      list = null;
      if (line.startsWith('## ')) content.push({ type: 'heading', attrs: { level: 3 }, content: inline(line.slice(3).trim()) });
      else if (line.trim()) content.push({ type: 'paragraph', content: inline(line.trim()) });
    }
  }

  return { summary, description: { type: 'doc', version: 1, content } };
}

async function create(project, file, options) {
  const settings = Object.fromEntries(options.map((option) => option.split('=')));
  const issue = issueFromMarkdown(file);
  const res = await fetch(base + '/issue', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ fields: {
      project: { key: project },
      issuetype: { name: settings.type || config.jira.defaultIssueType || 'Historia' },
      summary: issue.summary,
      description: issue.description,
      priority: { name: settings.priority || 'Medium' },
      ...(settings.parent ? { parent: { key: settings.parent } } : {}),
      ...(settings.labels ? { labels: settings.labels.split(',') } : {}),
    } }),
  });
  const created = await res.json();
  console.log('create', res.status, created.key || JSON.stringify(created).slice(0, 400));
  if (!created.key) process.exit(1);

  if (settings.blocks) {
    await call('POST', '/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: settings.blocks }, inwardIssue: { key: created.key } });
  }
  if (settings.sprint !== 'no') await moveToActiveSprint(created.key);
}

const [, , action, key, ...rest] = process.argv;

(async () => {
  if (action === 'create') {
    await create(key, rest[0], rest.slice(1));
  } else if (action === 'assign') {
    await call('PUT', `/issue/${key}/assignee`, { accountId: ME });
  } else if (action === 'sprint') {
    await moveToActiveSprint(key);
  } else if (TRANSITIONS[action]) {
    await call('POST', `/issue/${key}/transitions`, { transition: { id: TRANSITIONS[action] } });
  } else if (action === 'comment') {
    await call('POST', `/issue/${key}/comment`, { body: doc(rest.join(' ')) });
  } else if (action === 'mention') {
    const [id, name, ...words] = rest;
    await call('POST', `/issue/${key}/comment`, { body: doc(words.join(' '), { id, name }) });
  } else if (action === 'edit-comment') {
    const [commentId, ...words] = rest;
    await call('PUT', `/issue/${key}/comment/${commentId}`, { body: doc(words.join(' ')) });
  } else if (action === 'edit-mention') {
    const [commentId, id, name, ...words] = rest;
    await call('PUT', `/issue/${key}/comment/${commentId}`, { body: doc(words.join(' '), { id, name }) });
  } else {
    console.error('Unknown action. See the header of this script.');
    process.exit(1);
  }
})();
