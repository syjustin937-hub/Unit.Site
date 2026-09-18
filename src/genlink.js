// Key-system link generator (a!g-<service>)
//
// Talks to the genlink panel API and enforces per-user rate limits:
//   - 1 link per minute
//   - 5 links per day
// The bot owner (OWNER_ID) is exempt from both limits.

const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.GENLINK_BASE_URL || "http://de3.bot-hosting.net:20622";
const ORIGIN = process.env.GENLINK_ORIGIN || BASE_URL;

const COOLDOWN_MS = Number(process.env.GENLINK_COOLDOWN || 60_000); // 1 link / minute
const DAILY_LIMIT = Number(process.env.GENLINK_DAILY_LIMIT || 5); // 5 links / user / day
const DAY_MS = 24 * 60 * 60 * 1000;

/** service key -> pretty name. Keys are the values the API expects. */
const SERVICES = {
  delta: "Delta (Android)",
  "delta-ios": "Delta (iOS)",
  arceus: "Arceus X",
  ntthub: "NTT Hub",
  panda: "Panda",
  workink: "Work.ink",
};

/** Friendly aliases -> real service key. */
const ALIASES = {
  deltax: "delta",
  "delta-x": "delta",
  android: "delta",
  deltaandroid: "delta",
  "delta-android": "delta",
  ios: "delta-ios",
  deltaios: "delta-ios",
  arceusx: "arceus",
  "arceus-x": "arceus",
  ntt: "ntthub",
  "ntt-hub": "ntthub",
  "work-ink": "workink",
  workink: "workink",
  "work.ink": "workink",
};

function resolveService(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return null;
  if (SERVICES[key]) return key;
  if (ALIASES[key] && SERVICES[ALIASES[key]]) return ALIASES[key];
  return null;
}

/* ------------------------------ usage store ------------------------------ */

const FILE = path.join(__dirname, "..", "data", "genlink.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeAll(data) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

function usageOf(userId) {
  const all = readAll();
  const entry = all[userId] || { last: 0, windowStart: 0, count: 0 };
  if (Date.now() - entry.windowStart >= DAY_MS) {
    entry.windowStart = 0;
    entry.count = 0;
  }
  return entry;
}

/**
 * Check the limits without consuming anything.
 * @returns {{ok:true,remaining:number}|{ok:false,reason:"cooldown",retryMs:number}|{ok:false,reason:"daily",resetMs:number}}
 */
function checkLimit(userId, isOwner = false) {
  if (isOwner) return { ok: true, remaining: Infinity };
  const entry = usageOf(userId);
  const now = Date.now();

  const since = now - (entry.last || 0);
  if (since < COOLDOWN_MS) return { ok: false, reason: "cooldown", retryMs: COOLDOWN_MS - since };

  if (entry.count >= DAILY_LIMIT) {
    return { ok: false, reason: "daily", resetMs: Math.max(0, entry.windowStart + DAY_MS - now) };
  }

  return { ok: true, remaining: DAILY_LIMIT - entry.count };
}

/** Record one successful generation. Returns links left for today. */
function consume(userId, isOwner = false) {
  if (isOwner) return Infinity;
  const all = readAll();
  const entry = usageOf(userId);
  const now = Date.now();
  if (!entry.windowStart) entry.windowStart = now;
  entry.last = now;
  entry.count = (entry.count || 0) + 1;
  all[userId] = entry;
  writeAll(all);
  return Math.max(0, DAILY_LIMIT - entry.count);
}

function remaining(userId, isOwner = false) {
  if (isOwner) return Infinity;
  const entry = usageOf(userId);
  return Math.max(0, DAILY_LIMIT - (entry.count || 0));
}

/* --------------------------------- API ---------------------------------- */

async function apiFetch(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first URL out of an arbitrary API response shape. */
function pickLink(data) {
  if (!data || typeof data !== "object") return null;
  const direct =
    data.link || data.url || data.result || data.generated || data.short || data.shortlink;
  if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct;
  for (const value of Object.values(data)) {
    if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    if (value && typeof value === "object") {
      const nested = pickLink(value);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Generate a key-system link for a service.
 * @returns {Promise<{ok:true,link:string,raw:any}|{ok:false,error:string}>}
 */
async function generate(service) {
  const key = resolveService(service);
  if (!key) return { ok: false, error: "unknown_service" };

  const headers = { Origin: ORIGIN, Accept: "application/json" };

  let tokenData;
  try {
    const tokenResponse = await apiFetch(`${BASE_URL}/api/genlink-panel/token`, { headers });
    tokenData = await tokenResponse.json();
  } catch (err) {
    return { ok: false, error: `token request failed: ${err.message || err}` };
  }

  if (!tokenData || !tokenData.success || !tokenData.token) {
    return { ok: false, error: tokenData?.message || tokenData?.error || "could not get a token" };
  }

  let result;
  try {
    const generateResponse = await apiFetch(`${BASE_URL}/api/genlink-panel/generate`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenData.token, service: key }),
    });
    result = await generateResponse.json();
  } catch (err) {
    return { ok: false, error: `generate request failed: ${err.message || err}` };
  }

  const link = pickLink(result);
  if (!link) {
    return { ok: false, error: result?.message || result?.error || "the API returned no link" };
  }

  return { ok: true, link, raw: result, service: key, name: SERVICES[key] };
}

module.exports = {
  SERVICES,
  ALIASES,
  resolveService,
  generate,
  checkLimit,
  consume,
  remaining,
  COOLDOWN_MS,
  DAILY_LIMIT,
};
