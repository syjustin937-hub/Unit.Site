// Core deobfuscation service — shared by every command wrapper.
const leakd = require("./leakd");
const pastefy = require("./pastefy");
const { resolveSource, SourceError } = require("./source");
const {
  API_LABELS,
  WATERMARK,
  COOLDOWN_MS,
  MAX_CONCURRENT,
  DEOBF_GUILD_ID,
} = require("./config");

/* ----------------------------- anti spam ------------------------------ */

const cooldowns = new Map(); // userId -> timestamp
let running = 0;

function checkCooldown(userId) {
  const until = cooldowns.get(userId) || 0;
  const left = until - Date.now();
  if (left > 0) return Math.ceil(left / 1000);
  cooldowns.set(userId, Date.now() + COOLDOWN_MS);
  if (cooldowns.size > 1000) cooldowns.clear();
  return 0;
}

/* ----------------------------- watermark ------------------------------ */

/**
 * Removes ONE leading watermark comment line (if present) and prepends ours.
 */
function applyWatermark(code) {
  const text = String(code).replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const first = (lines[0] || "").trim();
  const isWatermark =
    /^--\[\[.*\]\]\s*$/.test(first) || (/^--/.test(first) && /(discord\.gg|leakd|deobfuscat|beautif|dump)/i.test(first));
  const body = isWatermark ? lines.slice(1).join("\n") : text;
  return `${WATERMARK}\n\n${body.replace(/^\s*\n/, "")}`;
}

/* ------------------------------ pipeline ------------------------------ */

/**
 * deobfuscateFile({ type, source, filename })
 * `source` is the raw lua code. Returns { code, filename, method, paste, detected, seconds }.
 */
async function deobfuscateFile({ type, source, filename }) {
  const started = Date.now();
  if (!API_LABELS[type]) throw new Error("unknown_method");
  if (!source || !source.trim()) throw new SourceError("empty_file");

  if (running >= MAX_CONCURRENT) throw new Error("busy");
  running += 1;
  try {
    const detectedPre = await leakd.detect(source);
    const res = await leakd.deobfuscate(type, source, filename);
    const detected = res.detection || detectedPre;
    const code = applyWatermark(res.code);

    let paste = null;
    let pasteError = null;
    if (pastefy.hasKey()) {
      try {
        paste = await pastefy.upload(`Deobfuscated - ${filename}`, code);
      } catch (err) {
        pasteError = err.message;
      }
    } else {
      pasteError = "pastefy_no_key";
    }

    const base = String(filename || "script.lua").replace(/\.[^.]+$/, "");
    return {
      code,
      filename: `${base}_deobfuscated.lua`,
      method: API_LABELS[type],
      detected,
      paste,
      pasteError,
      seconds: ((Date.now() - started) / 1000).toFixed(2),
    };
  } finally {
    running -= 1;
  }
}

module.exports = {
  deobfuscateFile,
  applyWatermark,
  resolveSource,
  checkCooldown,
  SourceError,
  API_LABELS,
  DEOBF_GUILD_ID,
  get concurrent() {
    return running;
  },
};
