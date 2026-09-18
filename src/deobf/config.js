// Central configuration for the deobfuscation system.
//
// To add a new obfuscator in the future you only need to add one entry here
// and one line in the COMMANDS map at the bottom — nothing else changes.

const API_BASE = (process.env.LEAKD_API_URL || "https://leakd.up.railway.app").replace(/\/+$/, "");

// command key -> API endpoint path
const API_ENDPOINTS = {
  ms3: "/moonsec",
  promo: "/prometheus",
  ib2: "/ironbrew2",
  luafuscate: "/luaobfuscator",
  irv: "/ironveil",
};

// command key -> human readable method name
const API_LABELS = {
  ms3: "MoonSec v3",
  promo: "Prometheus",
  ib2: "IronBrew2",
  luafuscate: "LuaObfuscator",
  irv: "IronVeil",
};

// Guild where the deobfuscation commands may be used (developer server only).
const DEOBF_GUILD_ID = process.env.DEOBFUSCATION_GUILD_ID || "1525537114287247582";

const WATERMARK = "--[[ This File Dumper By ZeoxLeak https://discord.gg/gKtKJa7fC ]]";

module.exports = {
  API_BASE,
  API_ENDPOINTS,
  API_LABELS,
  DEOBF_GUILD_ID,
  WATERMARK,

  // Limits
  MAX_FILE_BYTES: Number(process.env.DEOBF_MAX_FILE_BYTES || 8 * 1024 * 1024), // 8 MB input
  DOWNLOAD_TIMEOUT_MS: Number(process.env.DEOBF_DOWNLOAD_TIMEOUT || 30000),
  API_TIMEOUT_MS: Number(process.env.DEOBF_API_TIMEOUT || 180000),
  PASTEFY_TIMEOUT_MS: Number(process.env.PASTEFY_TIMEOUT || 30000),

  // Anti spam
  COOLDOWN_MS: Number(process.env.DEOBF_COOLDOWN || 15000),
  MAX_CONCURRENT: Number(process.env.DEOBF_MAX_CONCURRENT || 3),

  ALLOWED_EXTENSIONS: [".lua", ".luau", ".txt"],
};
