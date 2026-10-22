# Dashboard Jira

A local control tower for running several [Claude Code](https://claude.com/claude-code) sessions on a Jira backlog. It reads Jira, turns new and returned tickets into cards, and lets you decide from your desktop or your phone which AI session works on each one.

![Board: Jira cards waiting for approval, grouped by epic, next to the latest Jira report](docs/board.png)

## Why

When several AI coding sessions work in parallel (one per product area), someone has to watch Jira, decide what goes where, pass each session the ticket and its attachments, and collect the answers. Dashboard Jira does that plumbing. You keep the decisions: nothing is sent to a session until you approve it.

## How it works

1. **A reporter session reads Jira** every few minutes. It publishes a short report and creates a card for each new ticket, each ticket returned from review and each new comment on one of your tickets.
2. **You approve cards** on the board, from the browser or from your phone. Each card goes to the session that owns its epic.
3. **An orchestrator session delivers** the approved work, with the ticket's attachments already downloaded. Each session reports back `done`, `partial` or `question`, and you answer from the board.

It also has:
- one-click deploy orders;
- a chat with the sessions (voice notes transcribed locally with Whisper; replies spoken with Piper);
- push notifications;
- an hourly activity summary of a colleague;
- a "Learning" tab that tracks how often work comes back from review.

<img src="docs/talk.png" alt="Phone view: chat with the reporter session, with a progress line while it works" width="300">

Everything runs on your machine: a Node server on `127.0.0.1`, a SQLite file and your Jira API token in a local `.env`. Nothing is sent anywhere other than your own Jira. The interface is in Spanish.

## Quick start

```bash
git clone https://github.com/Albrodpul/dashboard-jira.git
node dashboard-jira/install.js C:/work/acme/board   # creates board.config.json and .env there
# fill in .env (Jira site, email, API token) and board.config.json (projects, root folder)
node C:/work/acme/board/board.js jira-setup        # prints the Jira ids the config needs
node dashboard-jira/install.js C:/work/acme/board   # renders the Claude Code slash commands
node C:/work/acme/board/board.js ensure            # http://127.0.0.1:4747
```

Then run `/resumen-jira` in one Claude Code session and `/orquesta` in another. The full walkthrough is below.

## Requirements

- Node 24 or later (uses the built-in `node:sqlite`, no npm dependencies)
- Claude Code (VS Code extension) for the sessions
- A Jira Cloud API token
- Windows is the tested platform (session opening relies on `vscode://` links and `cmd start`)

## Setting it up at a company

The code is the same everywhere. What changes from one company (one Jira) to another lives in a **workspace folder** you create for it, so you can have one per company and switch by pointing to another folder.

### 1. Clone and install into a new workspace

```bash
git clone https://github.com/Albrodpul/dashboard-jira.git
node dashboard-jira/install.js C:/work/acme/board
```

The first run creates `board.config.json` and `.env` from the examples and stops, because they are empty.

### 2. Jira credentials (`.env`)

Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> and fill in:

```dotenv
JIRA_SITE=your-company.atlassian.net
JIRA_EMAIL=you@your-company.com
JIRA_TOKEN=<the token>
```

The `.env` never leaves the workspace folder and is git-ignored.

### 3. Projects and root (`board.config.json`)

Set at least:

- `company`: the company name, used in texts.
- `root`: the folder you open in VS Code, where the Claude Code sessions live. The installer writes the slash commands into `<root>/.claude/commands/`.
- `jira.projects`: the project keys to watch, e.g. `["WEB", "API"]`.

### 4. Let Jira fill in the ids

With the credentials and the projects in place, ask Jira for the rest:

```bash
node C:/work/acme/board/board.js jira-setup WEB-123 "Reviewer Name"
```

- `WEB-123` is any ticket of yours that is in progress. It is used to list the transitions available from that state.
- `"Reviewer Name"` is the person who reviews your work. Their account id is looked up by name.

The output gives you:

| Output | Goes to |
|---|---|
| `me.id`, `me.name` | `jira.me` |
| `reviewerCandidates[].id`, `.name` | `jira.reviewer` (also set `mentions`: how people write their name in comments, e.g. `["@Ana López", "@Ana"]`) |
| `statuses` per project | `statuses.review` (the "in review" state), `statuses.returned` (states a ticket goes back to when the review fails), `statuses.inProgress`, `statuses.closed` |
| `transitionsFrom.transitions[].id` | `jira.transitions.start` / `todo` / `block`, used by `jira-write.js` |

Also set `statuses.rejectLabel`, the label reviewers add when they reject a ticket, if your team uses one. And set `jira.defaultIssueType`, the issue type `jira-write.js create` uses.

### 5. Optional parts

- `followUp`: colleagues whose activity a follow-up session can summarise. `hourly: true` means automatic, every hour; the others are on demand from the board. `environment` is `beta` or `production`. How the summary is built (which database, which table) is written in `templates/commands/seguimiento.md`; adapt it to your platform or leave the list empty.
- `deployProjects`: the projects the Deploy tab offers. Leave it empty if you don't deploy from the board.
- `errorsArea`: the id of the session that receives the possible errors found by the follow-up.
- `contextDomains`: the folder, relative to `root`, where sessions keep what they learn (`context/domains`). The Learning tab reads its "History" sections.
- `sessionModel`: the model for the sessions the board creates.

### 6. Install again

```bash
node dashboard-jira/install.js C:/work/acme/board
```

This time it renders `/resumen-jira`, `/orquesta`, `/soy` and `/seguimiento` into `<root>/.claude/commands/`. The templates refer to `AGENTS.md` and `context/*.md` in your root for your team's rules (how to take a ticket, how to deploy). Write those for your team, or edit the templates.

### 7. Start everything

1. `node C:/work/acme/board/board.js ensure`, then open <http://127.0.0.1:4747>.
2. In one Claude Code session, run `/resumen-jira`. That session becomes the reporter.
3. In another, run `/orquesta`. That session becomes the orchestrator.
4. In each working session, run `/soy <area>`. Then assign epics to areas in the Epics tab.
5. To start the reporter automatically when VS Code opens, add this task to `<root>/.vscode/tasks.json`:

   ```json
   {
     "version": "2.0.0",
     "tasks": [
       {
         "label": "Start the Jira reporter",
         "type": "process",
         "command": "node",
         "args": ["C:/work/acme/board/board.js", "startup"],
         "runOptions": { "runOn": "folderOpen" },
         "presentation": { "reveal": "never", "close": true },
         "problemMatcher": []
       }
     ]
   }
   ```

6. The sessions run board commands without asking, so allow `Bash` in `<root>/.claude/settings.local.json`.

### Voice notes (optional)

The Talk tab can send voice notes. They are transcribed on your computer with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT, free), and the session receives the text. Download `whisper-blas-bin-x64.zip` from its releases into `%LOCALAPPDATA%/whisper/bin`, and a model such as `ggml-small-q5_1.bin` into `%LOCALAPPDATA%/whisper`. To use other paths, set `voice.whisperBin` and `voice.model` in `board.config.json`. Without Whisper, the mic button falls back to the browser's dictation. Replies are turned into speech with [Piper](https://github.com/rhasspy/piper) (MIT, free, local): unzip `piper_windows_amd64.zip` into `%LOCALAPPDATA%/piper` and put a voice such as `es_ES-davefx-medium.onnx` (with its `.json`) next to it; `ffmpeg` must be on the PATH to encode MP3. The replies then play as real audio, which keeps playing with another app in front or the phone locked, and "Manos libres" keeps the page awake so new replies play on their own. Without Piper, replies are read with the browser's speech synthesis, which stops in the background. Paths can be changed with `voice.piperBin`, `voice.piperVoice` and `voice.ffmpeg`.

### Using the board from your phone

Keep the server on `127.0.0.1`. Expose it only inside your own tailnet with `tailscale serve`, never with `funnel`. Then add the tailnet host name to `data/board-hosts.txt`, so the server accepts it.

### Moving an existing workspace

Run `install.js` on the old workspace folder. Older data is migrated on the first start: the `datos/` folder, `tablero.config.json` and the Spanish field names. Add `--legacy-launchers` to also write `tablero.js` and `sesiones.js` for sessions that still call the old names.

## What a workspace holds

| File | What |
|---|---|
| `board.config.json` | Jira projects, your account id, the reviewer, status names, people to follow up, deploy targets |
| `.env` | `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| `data/` | SQLite database, session routes, push keys, logs |
| `board.js`, `sessions.js`, `jira-window.js`, `jira-write.js`, `jira.sh` | launchers written by the installer that call this repo |

## Use

```bash
node <workspace>/board.js ensure      # starts the board at http://127.0.0.1:4747
```

In Claude Code:

- `/resumen-jira` turns a session into the **reporter** (reads Jira, publishes a report, creates cards).
- `/orquesta` turns a session into the **orchestrator** (sends approved cards, deployments and your answers).
- `/soy <area>` registers a session as the one that owns an area; epics are routed to areas from the board.
- `/seguimiento` turns a session into the **follow-up** one (hourly activity summary of a colleague).

`node <workspace>/board.js` without arguments lists every command. The old Spanish command names (`informe`, `envios`, `hecha`…) still work as aliases.

## Security

- `.env`, `board.config.json` and `data/` are git-ignored; only the examples are committed.
- The server only listens on `127.0.0.1` and rejects requests whose `Host` or `Origin` is not local (extra hosts, e.g. a private Tailscale name, go in `data/board-hosts.txt`).
- `.githooks/pre-commit` runs [gitleaks](https://github.com/gitleaks/gitleaks) on staged changes with the rules in `.gitleaks.toml` (API tokens, Jira account ids, real Atlassian sites, e-mail addresses, private keys). Enable it once per clone:

  ```bash
  git config core.hooksPath .githooks
  ```

- CI runs the same scan over the whole history on every push.

## Layout

```
src/            server, CLI and modules (config, data, jira, sessions, state, api-*, watcher…)
src/page/       the web page (plain ES modules, no build step)
bin/            Jira window reader, Jira writer, sessions CLI, jira.sh
templates/      slash commands rendered by the installer
install.js      installer
```

## License

[MIT](LICENSE)
