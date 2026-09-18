// Persistent history / statistics / favorites store (plain JSON files).
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data");

function file(name) {
  return path.join(DIR, name);
}

function read(name, fallback) {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(file(name))) return fallback;
    return JSON.parse(fs.readFileSync(file(name), "utf8") || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function write(name, data) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2), "utf8");
}

/* ------------------------------- history -------------------------------- */
// history.json -> { [guildId]: [ { id, userId, url, service, provider, success, seconds, at } ] }

const HISTORY_LIMIT = 60;

function addHistory(guildId, entry) {
  const all = read("history.json", {});
  const list = all[guildId] || [];
  list.unshift({ ...entry, at: Date.now() });
  all[guildId] = list.slice(0, HISTORY_LIMIT);
  write("history.json", all);
  return all[guildId];
}

function getHistory(guildId, { userId = null, limit = 10 } = {}) {
  const all = read("history.json", {});
  const list = all[guildId] || [];
  return (userId ? list.filter((x) => x.userId === userId) : list).slice(0, limit);
}

function clearHistory(guildId, userId = null) {
  const all = read("history.json", {});
  if (!userId) all[guildId] = [];
  else all[guildId] = (all[guildId] || []).filter((x) => x.userId !== userId);
  write("history.json", all);
}

/* -------------------------------- stats --------------------------------- */
// stats.json -> { total, success, failed, totalSeconds, services:{}, providers:{ name:{ok,fail,seconds} }, days:{ "YYYY-MM-DD": n } }

const EMPTY_STATS = {
  total: 0,
  success: 0,
  failed: 0,
  totalSeconds: 0,
  services: {},
  providers: {},
  days: {},
};

function getStats() {
  return { ...EMPTY_STATS, ...read("stats.json", {}) };
}

function bumpStats({ service, provider, success, seconds }) {
  const s = getStats();
  const day = new Date().toISOString().slice(0, 10);
  s.total += 1;
  if (success) s.success += 1;
  else s.failed += 1;
  s.totalSeconds += Number(seconds) || 0;
  if (service) s.services[service] = (s.services[service] || 0) + 1;
  if (provider) {
    const p = s.providers[provider] || { ok: 0, fail: 0, seconds: 0 };
    if (success) p.ok += 1;
    else p.fail += 1;
    p.seconds += Number(seconds) || 0;
    s.providers[provider] = p;
  }
  s.days[day] = (s.days[day] || 0) + 1;
  write("stats.json", s);
  return s;
}

function resetStats() {
  write("stats.json", EMPTY_STATS);
  return getStats();
}

/* ------------------------------ favorites ------------------------------- */
// favorites.json -> { [userId]: [ { url, note, at } ] }

const FAV_LIMIT = 20;

function getFavorites(userId) {
  const all = read("favorites.json", {});
  return all[userId] || [];
}

function addFavorite(userId, url, note = "") {
  const all = read("favorites.json", {});
  const list = all[userId] || [];
  if (list.some((x) => x.url === url)) return { ok: false, reason: "exists", list };
  if (list.length >= FAV_LIMIT) return { ok: false, reason: "full", list };
  list.push({ url, note, at: Date.now() });
  all[userId] = list;
  write("favorites.json", all);
  return { ok: true, list };
}

function removeFavorite(userId, index) {
  const all = read("favorites.json", {});
  const list = all[userId] || [];
  if (index < 0 || index >= list.length) return { ok: false, reason: "missing", list };
  list.splice(index, 1);
  all[userId] = list;
  write("favorites.json", all);
  return { ok: true, list };
}

/* ------------------------------- feedback ------------------------------- */

function addFeedback(entry) {
  const list = read("feedback.json", []);
  list.unshift({ ...entry, at: Date.now() });
  write("feedback.json", list.slice(0, 200));
  return list;
}

module.exports = {
  addHistory,
  getHistory,
  clearHistory,
  getStats,
  bumpStats,
  resetStats,
  getFavorites,
  addFavorite,
  removeFavorite,
  addFeedback,
  FAV_LIMIT,
};
