require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const { DIALOGS } = require("../src/sessions/host");

const answer = (text) => {
  const hit = DIALOGS.find(([re]) => re.test(text));
  if (!hit) return null;
  return typeof hit[1] === "function" ? hit[1](text) : hit[1];
};

test("a new MCP server with «Continue without» selected is answered with «Use this MCP server»", () => {
  const text = "NewMCPserverfoundin.mcp.json:playwright-firefoxMCPserversmayexecutecodeoraccesssystemresources.UsethisMCPserverUsethisandallfutureMCPserversinthisproject❯ContinuewithoutusingthisMCPserverEntertoconfirm·Esctocancel";
  assert.equal(answer(text), "\x1b[A\x1b[A\r");
});

test("the trust dialog on Windows, with «> No, exit» selected, moves down to «Yes» before confirming", () => {
  const text = "and27moreThesewillapplywithoutasking.Onlyproceedifyoutrustthisconfiguration.Securityguide>No,exitYes,ItrustthisfolderEntertoconfirm·Esctocancel";
  assert.equal(answer(text), "\x1b[B\r");
});

test("the trust dialog on macOS keeps working", () => {
  assert.equal(answer("Doyoutrustthisfolder?❯No,exitYes,ItrustthisfolderEntertoconfirm"), "\x1b[B\r");
  assert.equal(answer("Doyoutrustthisfolder?❯Yes,ItrustthisfolderNo,exitEntertoconfirm"), "\r");
});

test("the screen text of a stuck dialog keeps its words apart", () => {
  const { readable } = require("../src/sessions/host");
  const raw = "\x1b[1mNew\x1b[1CMCP\x1b[1Cserver\x1b[1Cfound\x1b[0m\r\n\x1b[2C❯\x1b[1CContinue\x1b[1Cwithout\r\n───────\r\nEnter\x1b[1Cto\x1b[1Cconfirm";
  assert.equal(readable(raw), "New MCP server found\n❯ Continue without\nEnter to confirm");
});

test("the board keeps one notice per stuck session, tells only the first time and clears it", () => {
  const stuck = require("../src/features/stuck");
  assert.equal(stuck.report({ conversation: "c1", name: "Tablero", text: "pregunta" }), true);
  assert.equal(stuck.report({ conversation: "c1", name: "Tablero", text: "pregunta" }), false);
  assert.deepEqual(stuck.list().map((x) => x.name), ["Tablero"]);
  stuck.report({ conversation: "c1", cleared: true });
  assert.deepEqual(stuck.list(), []);
});

test("the autocompact tip between turns gets one Esc, and the same tip is not answered twice", () => {
  const { lateDialog } = require("../src/sessions/host");
  const sent = [];
  const tip = "\r\n  Tip: Enable autocompact at 80% to keep long sessions going\r\n  Enter to enable · Esc not now\r\n";
  const s = { name: "x", buffer: "", total: 0, pty: { write: (k) => sent.push(k) } };
  const feed = (d) => {
    s.buffer += d;
    s.total += d.length;
  };
  feed("some output" + tip);
  assert.equal(lateDialog(s), true);
  assert.equal(lateDialog(s), false);
  feed("\r\n> working on it");
  assert.equal(lateDialog(s), false);
  feed(tip);
  assert.equal(lateDialog(s), true);
});

test("a native prompt is found even when a long diff is redrawn after it", () => {
  const { promptIn } = require("../src/sessions/host");
  const dialog = "Edit file\r.claude/commands/x.md\r Do you want to make this edit to x.md?\r ❯ 1. Yes\r2. Yes, and allow\r   3. No\r\r Esc to cancel · Tab to amend\r";
  const redraw = Array.from({ length: 80 }, (_, i) => ` ${i} - una línea larga del diff que se redibuja debajo del cuadro\r`).join("");
  const found = promptIn(dialog + redraw);
  assert.equal(found && found.question, "Do you want to make this edit to x.md?");
  assert.equal(promptIn(dialog + redraw + "⏺ Update(.claude/commands/x.md)\r"), null);
  assert.equal(promptIn(redraw), null);
});

test("a native prompt is still found after a resize repaints the screen and the pending dot blinks", () => {
  const { promptIn } = require("../src/sessions/host");
  const before = "⏺ Cambio cada fila del listado a tres líneas\r⏺ Bash(grep -n 'Factura' e2e/smoke.mjs)\r";
  const dialog = "Bash command\r grep -n 'Factura' e2e/smoke.mjs\r Do you want to proceed?\r ❯ 1. Yes\r 2. No\r Esc to cancel · Tab to amend\r";
  const repaint = "Investigación inicial ⏺ Cambio cada fila del listado\r⎿ $ grep n 'Factura' e2e/smoke.mjs\r" + "⏺ ".repeat(40);
  const found = promptIn(before + dialog + repaint);
  assert.equal(found && found.question, "Do you want to proceed?");
  assert.equal(promptIn(before + dialog + repaint + "⎿ Tests 115 passed\r"), null);
  assert.equal(promptIn(before + dialog + "⎿ Interrupted · What should Claude do instead?\r"), null);
});

test("a native prompt is still found when the repaint names the pending tool in its running form", () => {
  const { promptIn } = require("../src/sessions/host");
  const before = "⏺ Running the read-only daily review\r⎿ $ npx tsx scripts/daily-review.ts\r";
  const dialog = "Bash command\r set -a && q 'select status from public.remittances'\r List pending/credited remittances, new movements and errors\r Do you want to proceed?\r ❯ 1. Yes\r 2. Yes, and switch to auto mode\r 3. No\r Esc to cancel · Tab to amend\r";
  const repaint = "Investigación inicial ⏺ Listing pending/credited remittances, new movements and errors\r⎿ $ set -a && q 'select status from public.remittances'\r" + "⏺ ".repeat(40);
  const found = promptIn(before + dialog + repaint);
  assert.equal(found && found.question, "Do you want to proceed?");
  assert.equal(promptIn(before + dialog + repaint + "⏺ Si alguna parte la devuelve el banco, la factura sale como devuelta\r"), null);
});

test("the new project trust dialog is accepted", () => {
  assert.equal(answer("Is this a project you trust? ❯ 1. Yes, proceed 2. No, exit"), "\r");
});

const term = (cols = 100, rows = 40) => {
  const { emulator, screenLines, promptOnScreen } = require("../src/sessions/host");
  const t = emulator(cols, rows);
  return {
    t,
    feed: (d) => new Promise((r) => t.write(d, r)),
    prompt: () => promptOnScreen(screenLines(t)),
  };
};
const at = (row, text) => `\x1b[${row};1H\x1b[2K${text}`;
const rows = (from, lines) => lines.map((l, i) => at(from + i, l)).join("");
const FULLSCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const INPUT_BOX = (row) => rows(row, ["─".repeat(60), "❯ ", "─".repeat(60), "  ⏵⏵ accept edits on (shift+tab to cycle)"]);
const bashDialog = (command, extra = []) => ["─".repeat(80), " Bash command", "", `   ${command}`, ...extra.map((x) => `   ${x}`), "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"];

test("on screen: a pending Bash prompt is found with its command as context", async () => {
  const s = term();
  await s.feed(FULLSCREEN + rows(1, ["⏺ Bash(grep -n 'Factura' e2e/smoke.mjs)"]) + rows(30, bashDialog("grep -n 'Factura' e2e/smoke.mjs")));
  const found = s.prompt();
  assert.equal(found && found.question, "Do you want to proceed?");
  assert.match(found.text, /^Bash command grep -n 'Factura' e2e\/smoke\.mjs Do you want to proceed\? ❯ 1\. Yes 2\. No Esc to cancel/);
});

test("on screen: a resize repaint with the pending dot blinking keeps the prompt pending until it is answered", async () => {
  const s = term();
  const transcript = ["⏺ Cambio cada fila del listado a tres líneas", "⏺ Bash(grep -n 'Factura' e2e/smoke.mjs)"];
  await s.feed(FULLSCREEN + rows(1, transcript) + rows(30, bashDialog("grep -n 'Factura' e2e/smoke.mjs")));
  s.t.resize(80, 40);
  const repaint = rows(1, ["Investigación inicial ⏺ Cambio cada fila del listado", "  Bash(grep -n 'Factura' e2e/smoke.mjs)", "  ⎿ $ grep n 'Factura' e2e/smoke.mjs"]) + rows(30, bashDialog("grep -n 'Factura' e2e/smoke.mjs"));
  const blinks = Array.from({ length: 40 }, (_, i) => at(2, `${i % 2 ? " " : "⏺"} Bash(grep -n 'Factura' e2e/smoke.mjs)`)).join("");
  await s.feed("\x1b[2J\x1b[H" + repaint + blinks);
  assert.equal(s.prompt() && s.prompt().question, "Do you want to proceed?");
  await s.feed("\x1b[30;1H\x1b[J" + rows(30, ["  ⎿ Tests 115 passed"]) + INPUT_BOX(36));
  assert.equal(s.prompt(), null);
});

test("on screen: a repaint naming the pending tool in its -ing form does not answer the prompt", async () => {
  const s = term(120, 40);
  const dialog = bashDialog("set -a && q 'select status from public.remittances'", ["List pending/credited remittances, new movements and errors"]);
  await s.feed(FULLSCREEN + rows(1, ["⏺ Running the read-only daily review", "  ⎿ $ npx tsx scripts/daily-review.ts"]) + rows(28, dialog));
  await s.feed("\x1b[2J\x1b[H" + rows(1, ["Investigación inicial", "⏺ Listing pending/credited remittances, new movements and errors", "  ⎿ $ set -a && q 'select status from public.remittances'"]) + rows(28, dialog) + "⏺ ".repeat(40));
  assert.equal(s.prompt() && s.prompt().question, "Do you want to proceed?");
  await s.feed("\x1b[1;1H\x1b[J" + rows(1, ["⏺ Si alguna parte la devuelve el banco, la factura sale como devuelta"]) + INPUT_BOX(36));
  assert.equal(s.prompt(), null);
});

test("on screen: an edit prompt is found when a long diff is redrawn after it in the byte stream", async () => {
  const s = term(100, 40);
  const head = rows(8, ["─".repeat(80), " Edit file", " .claude/commands/x.md"]);
  const question = rows(33, [" Do you want to make this edit to x.md?", " ❯ 1. Yes", "   2. Yes, allow all edits during this session (shift+tab)", "   3. No", "", " Esc to cancel · Tab to amend"]);
  const diff = Array.from({ length: 80 }, (_, i) => at(11 + (i % 21), ` ${i} - una línea larga del diff que se redibuja debajo del cuadro`)).join("");
  await s.feed(FULLSCREEN + head + question + diff);
  const found = s.prompt();
  assert.equal(found && found.question, "Do you want to make this edit to x.md?");
  assert.match(found.text, /^Edit file \.claude\/commands\/x\.md/);
  await s.feed("\x1b[8;1H\x1b[J" + rows(8, ["⏺ Update(.claude/commands/x.md)", "  ⎿ Updated .claude/commands/x.md with 3 additions"]) + INPUT_BOX(36));
  assert.equal(s.prompt(), null);
  const only = term();
  await only.feed(FULLSCREEN + diff);
  assert.equal(only.prompt(), null);
});

test("on screen: an answered prompt followed by tool output is no longer pending, also in the normal buffer", async () => {
  const s = term(100, 30);
  const history = Array.from({ length: 60 }, (_, i) => `línea ${i} del historial`).join("\r\n");
  const dialog = bashDialog("npm test");
  await s.feed(history + "\r\n" + dialog.join("\r\n"));
  assert.equal(s.prompt() && s.prompt().question, "Do you want to proceed?");
  await s.feed(`\x1b[${dialog.length - 1}A\r\x1b[J⏺ Bash(npm test)\r\n  ⎿ ℹ tests 266\r\n  ⎿ ℹ pass 266\r\n`);
  assert.equal(s.prompt(), null);
});

test("on screen: an interrupted prompt is not pending", async () => {
  const s = term();
  await s.feed(FULLSCREEN + rows(30, bashDialog("rm -rf pruebas/X-1")));
  assert.ok(s.prompt());
  await s.feed("\x1b[30;1H\x1b[J" + rows(30, ["⏺ Bash(rm -rf pruebas/X-1)", "  ⎿ Interrupted · What should Claude do instead?"]) + INPUT_BOX(36));
  assert.equal(s.prompt(), null);
});

test("on screen: a question wrapped over two rows on a narrow terminal is joined", async () => {
  const s = term(34, 30);
  await s.feed(FULLSCREEN + rows(20, [" Edit file", " Do you want to make this edit", " to a-long-file-name.md?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"]));
  assert.equal(s.prompt() && s.prompt().question, "Do you want to make this edit to a-long-file-name.md?");
});

test("on screen: a real Bash prompt with a long «don't ask again» option wrapped over several rows is found", async () => {
  const s = term(60, 40);
  const lines = ["─".repeat(60), " Bash command", "", "   curl -s -A \"Mozilla/5.0\" \"https://query1.finance.yahoo.", "   com/v8/finance/chart/DRAM.DE?range=10d&interval=1d\"", "   Fetch DRAM.DE daily price range for recent days", "", " This command requires approval", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don’t ask again for: curl -s -A", "   \"Mozilla/5.0\" \"https://query1.finance.yahoo.com/v8/fin", "   ance/chart/DRAM.DE?range=10d&interval=1d\" and every", "   other command that starts the same way in this folder", "   3. Yes, and switch to auto mode · auto mode handles", "   these prompts for you", "   4. No", "", " Esc to cancel · Tab to amend"];
  await s.feed(FULLSCREEN + rows(40 - lines.length + 1, lines));
  const found = s.prompt();
  assert.equal(found && found.question, "Do you want to proceed?");
  assert.match(found.text, /^Bash command curl -s/);
});

test("on screen: the question quoted in the transcript without the dialog footer is not a prompt", async () => {
  const s = term();
  await s.feed(FULLSCREEN + rows(1, ["⏺ El cuadro decía «Do you want to proceed?» con:", "  1. Yes", "  2. No"]) + INPUT_BOX(36));
  assert.equal(s.prompt(), null);
});
