const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { DATA_DIR, load } = require("./data");
const config = require("./config");

const SPEECH_DIR = path.join(DATA_DIR, "speech");
const LOCAL = path.join(process.env.LOCALAPPDATA || "", "piper");
const PIPER_BIN = config.voice.piperBin || path.join(LOCAL, "piper", "piper.exe");
const PIPER_VOICE = config.voice.piperVoice || path.join(LOCAL, "es_ES-davefx-medium.onnx");
const FFMPEG = config.voice.ffmpeg || "ffmpeg";
const ROUTE = /^\/api\/speech\/(msg-\d{17})\/(\d{1,2})\.mp3$/;
const running = new Map();

const speechAvailable = () => fs.existsSync(PIPER_BIN) && fs.existsSync(PIPER_VOICE);

function speakable(text) {
  return String(text)
    .replace(/`+/g, "")
    .replace(/\*\*?|__/g, "")
    .replace(/https?:\/\/\S+/g, "el enlace")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function run(bin, args, input) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(bin, args, { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    if (input !== undefined) child.stdin.end(input);
  });
}

async function synthesize(text, file) {
  const wav = `${file}.${process.pid}.wav`;
  try {
    await run(PIPER_BIN, ["-m", PIPER_VOICE, "-f", wav, "-q"], speakable(text));
    await run(FFMPEG, ["-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "48k", file]);
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

function replyText(id, index) {
  const m = load().messages.find((x) => x.id === id);
  if (!m) return null;
  const replies = m.replies || (m.reply ? [{ text: m.reply }] : []);
  return replies[index] ? replies[index].text : null;
}

function serveSpeech(res, url) {
  const match = ROUTE.exec(url);
  if (!match || !speechAvailable()) return res.writeHead(404).end();
  const [, id, n] = match;
  const text = replyText(id, Number(n));
  if (!text) return res.writeHead(404).end();
  fs.mkdirSync(SPEECH_DIR, { recursive: true });
  const file = path.join(SPEECH_DIR, `${id}-${n}.mp3`);
  const send = () => {
    res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "max-age=86400" });
    fs.createReadStream(file).pipe(res);
  };
  if (fs.existsSync(file)) return send();
  if (!running.has(file)) running.set(file, synthesize(text, file).finally(() => running.delete(file)));
  running
    .get(file)
    .then(send)
    .catch(() => res.writeHead(500).end());
}

module.exports = { speechAvailable, serveSpeech };
