require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");
const config = require("../src/core/config");
const uploads = require("../src/server/uploads");

function serve() {
  const send = (res, code, body) => {
    if (res.headersSent) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => uploads.handleUpload(req, res, send));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/", method: "POST", headers: { "x-file-name": "video.mp4", "content-length": body.length, ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a 30 MB video is saved whole instead of cutting the connection", async () => {
  const server = await serve();
  const body = Buffer.alloc(30 * 1024 * 1024, 7);
  const r = await post(server.address().port, body);
  server.close();
  assert.equal(r.status, 200);
  const file = path.join(config.root, r.body.path);
  assert.equal(fs.statSync(file).size, body.length);
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test("an upload over the limit gets a clear 413", async () => {
  const server = await serve();
  const r = await post(server.address().port, Buffer.alloc(10), { "content-length": String((uploads.MAX_MB + 1) * 1024 * 1024) }).catch((e) => ({ error: e.code }));
  server.close();
  assert.equal(r.status, 413);
  assert.match(r.body.error, /pasa de/);
});
