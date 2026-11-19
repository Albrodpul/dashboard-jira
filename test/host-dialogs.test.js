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

test("the new project trust dialog is accepted", () => {
  assert.equal(answer("Is this a project you trust? ❯ 1. Yes, proceed 2. No, exit"), "\r");
});
