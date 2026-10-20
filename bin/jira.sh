#!/usr/bin/env bash
# Usage:
#   jira.sh <issue-key>              — Fetch a single issue with its comments (e.g. FRON-1658)
#   jira.sh search "<JQL>"           — Run a JQL query (e.g. "project=FRON AND sprint in openSprints()")
#
# Works whether or not the jira MCP server is up: it talks to the REST API directly with the
# API token, which is what the MCP entry cannot do (mcp-remote authenticates over OAuth and
# ignores the ATLASSIAN_* variables next to it).
#
# Reads credentials from the workspace .env through src/config.js (TOWER_WORKSPACE says which workspace).

# Resolve repo root (Windows-safe)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
TMPDIR_W="$(cd "${TEMP:-/tmp}" && pwd -W 2>/dev/null || pwd)"
TMPFILE="$TMPDIR_W/jira_tmp_$$.json"

# Read credentials once
eval "$(node -e "
  const k = require(process.argv[1]).credentials();
  console.log('SITE=' + JSON.stringify(k.site));
  console.log('EMAIL=' + JSON.stringify(k.email));
  console.log('TOKEN=' + JSON.stringify(k.token));
" "$REPO_ROOT/src/config.js")"

BASE_URL="https://$SITE/rest/api/3"
AUTH="$EMAIL:$TOKEN"

format_description() {
  node -e "
    const data = JSON.parse(require('fs').readFileSync('$TMPFILE','utf8'));
    const f = data.fields || {};
    console.log('Key:', data.key);
    console.log('Summary:', f.summary);
    console.log('Status:', (f.status||{}).name || 'N/A');
    console.log('Priority:', (f.priority||{}).name || 'N/A');
    if (f.parent) console.log('Parent:', f.parent.key, '-', f.parent.fields.summary);
    if (f.assignee) console.log('Assignee:', f.assignee.displayName);
    console.log();
    function ext(n,d=0){if(!n)return '';if(n.type==='text'){let t=n.text||'';(n.marks||[]).forEach(m=>{if(m.type==='strong')t='**'+t+'**';if(m.type==='code')t='\`'+t+'\`';if(m.type==='em')t='_'+t+'_';});return t}if(n.type==='heading')return'\n'+'#'.repeat((n.attrs||{}).level||1)+' '+(n.content||[]).map(c=>ext(c,d)).join('')+'\n';if(n.type==='paragraph')return(n.content||[]).map(c=>ext(c,d)).join('')+'\n';if(n.type==='bulletList')return(n.content||[]).map(c=>ext(c,d)).join('');if(n.type==='listItem')return'  '.repeat(d)+'- '+(n.content||[]).map(c=>ext(c,d+1)).join('');if(n.type==='orderedList')return(n.content||[]).map(c=>ext(c,d)).join('');if(n.type==='table'){let rows=n.content||[],r='';rows.forEach((row,i)=>{let cells=row.content||[];let rt=cells.map(cell=>(cell.content||[]).map(c=>ext(c)).join('').trim()).join(' | ');r+='| '+rt+' |\n';if(i===0)r+='|'+cells.map(()=>'---').join('|')+'|\n'});return r+'\n'}if(n.type==='codeBlock')return'\n\`\`\`\n'+(n.content||[]).map(c=>ext(c,d)).join('')+'\n\`\`\`\n';if(n.type==='hardBreak')return'\n';if(n.type==='inlineCard')return(n.attrs||{}).url||'';return(n.content||[]).map(c=>ext(c,d)).join('')}
    if (f.description) { console.log('Description:'); console.log(ext(f.description)); }
    const comments = ((f.comment||{}).comments)||[];
    if (comments.length) {
      console.log('Comments (' + comments.length + '):');
      comments.forEach(c => {
        const who = (c.author||{}).displayName || 'unknown';
        const when = (c.created||'').slice(0,16).replace('T',' ');
        console.log();
        console.log('--- ' + who + ' @ ' + when + ' ---');
        console.log(ext(c.body).trim());
      });
    }
  "
}

format_search() {
  node -e "
    const data = JSON.parse(require('fs').readFileSync('$TMPFILE','utf8'));
    console.log('Results:', data.total || (data.issues||[]).length);
    console.log();
    (data.issues || []).forEach(issue => {
      const f = issue.fields || {};
      const status = (f.status||{}).name || '';
      const priority = (f.priority||{}).name || '';
      const assignee = f.assignee ? f.assignee.displayName : 'Unassigned';
      console.log(issue.key + ' [' + status + '] [' + priority + '] ' + f.summary + ' (' + assignee + ')');
    });
  "
}

if [ "$1" = "search" ]; then
  shift
  JQL="$*"
  ENCODED_JQL=$(node -e "process.stdout.write(encodeURIComponent('$JQL'))")
  curl -s -u "$AUTH" "${BASE_URL}/search/jql?jql=${ENCODED_JQL}&maxResults=50&fields=summary,status,priority,assignee" -o "$TMPFILE"
  format_search
else
  ISSUE_KEY="$1"
  curl -s -u "$AUTH" "$BASE_URL/issue/$ISSUE_KEY?fields=summary,description,status,priority,assignee,parent,sprint,comment" -o "$TMPFILE"
  format_description
fi

# Cleanup
rm -f "$TMPFILE"
