const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR } = require("./data");
const config = require("./config");

const VOICE_DIR = path.join(DATA_DIR, "voice");
const LOCAL = path.join(process.env.LOCALAPPDATA || "", "whisper");
const WHISPER_BIN = config.voice.whisperBin || path.join(LOCAL, "bin", "Release", "whisper-cli.exe");
const WHISPER_MODEL = config.voice.model || path.join(LOCAL, "ggml-small-q5_1.bin");
const MAX_BYTES = 15 * 1024 * 1024;
const ID = /^voice-\d{17}$/;
const recent = new Map();

const voiceAvailable = () => fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);

function transcribe(file) {
  return new Promise((resolve, reject) => {
    const args = ["-m", WHISPER_MODEL, "-f", file, "-l", config.voice.language || "es", "-nt", "-np", "-t", "6"];
    cp.execFile(WHISPER_BIN, args, { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) return reject(new Error("no se pudo transcribir la nota"));
      resolve(String(out).replace(/\s+/g, " ").trim());
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error("la nota es demasiado larga"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function handleVoice(req, res, send, createMessage) {
  if (!voiceAvailable()) return send(res, 503, { error: "Whisper no está instalado en este ordenador" });
  const to = new URL(req.url, "http://x").searchParams.get("to");
  if (!["reporter", "orchestrator", "board"].includes(to)) return send(res, 400, { error: "destino desconocido" });
  const body = await readBody(req);
  if (body.length < 44 || body.toString("ascii", 0, 4) !== "RIFF") return send(res, 400, { error: "audio no válido" });
  const hash = require("crypto").createHash("sha1").update(body).digest("hex");
  for (const [h, at] of recent) if (Date.now() - at > 30 * 60000) recent.delete(h);
  if (recent.has(hash)) return send(res, 200, { duplicate: true });
  recent.set(hash, Date.now());
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const id = "voice-" + new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  const file = path.join(VOICE_DIR, `${id}.wav`);
  fs.writeFileSync(file, body);
  const text = await transcribe(file);
  if (!text) return send(res, 422, { error: "No se ha entendido nada en la nota" });
  createMessage(res, { to, text, voice: id }, send);
}

function serveVoice(res, url) {
  const id = path.basename(url, ".wav");
  if (!ID.test(id)) return res.writeHead(404).end();
  const file = path.join(VOICE_DIR, `${id}.wav`);
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "audio/wav", "cache-control": "max-age=86400" });
  fs.createReadStream(file).pipe(res);
}

module.exports = { voiceAvailable, handleVoice, serveVoice };
