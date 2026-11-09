const fs = require("fs");

const MAX_BYTES = 1024 * 1024;

function rotate(file, max = MAX_BYTES) {
  try {
    if (fs.statSync(file).size < max) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch (e) {
    return false;
  }
}

function rotateInPlace(file, max = MAX_BYTES) {
  try {
    if (fs.statSync(file).size < max) return false;
    fs.copyFileSync(file, `${file}.1`);
    fs.truncateSync(file, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function appendLog(file, text, max = MAX_BYTES) {
  rotate(file, max);
  try {
    fs.appendFileSync(file, text);
  } catch (e) {}
}

module.exports = { MAX_BYTES, rotate, rotateInPlace, appendLog };
