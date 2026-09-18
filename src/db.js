// Simple JSON-file storage. Every guild has fully independent settings.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "guilds.json");

function ensure() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "{}", "utf8");
}

function readAll() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
  } catch {
    return {};
  }
}

function writeAll(data) {
  ensure();
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), "utf8");
}

const DEFAULTS = {
  bypassChannel: null,
  logsChannel: null,
  requiredRole: null,
  language: "en",

  // Send a link (no command) inside the bypass room -> bot deletes it and bypasses it.
  autoBypass: true,
  // Delete the user's link message when auto bypass runs.
  autoDelete: true,
  // Maintenance mode: only administrators may use the bot.
  maintenance: false,
  // Domain allow list. When it has entries, ONLY those domains are accepted.
  whitelist: [],
  // Blocked domains.
  blacklist: [],
  // Blocked user ids.
  blockedUsers: [],
  // Allowed user ids (bypass the required role check).
  allowedUsers: [],
};

function getGuild(guildId) {
  const all = readAll();
  return { ...DEFAULTS, ...(all[guildId] || {}) };
}

function setGuild(guildId, patch) {
  const all = readAll();
  all[guildId] = { ...DEFAULTS, ...(all[guildId] || {}), ...patch };
  writeAll(all);
  return all[guildId];
}

/** Drop every cached read (used by `a!reload`). */
function reload() {
  return readAll();
}

module.exports = { getGuild, setGuild, reload, DEFAULTS };
