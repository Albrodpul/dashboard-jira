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
