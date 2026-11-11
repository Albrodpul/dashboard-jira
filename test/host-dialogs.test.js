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
