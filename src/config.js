// Global bot configuration
//
// IMPORTANT: this bot uses ONLY custom server emojis (no default/unicode emojis).
// Every emoji shown anywhere in the UI comes from the `emoji` map below.
// If you move the bot to another server, replace the ids here only.

const EMOJI = {
  false: "<:false:1532818461850472629>",
  true: "<:true:1532818305793130506>",
  boost: "<:boost:1532818970548109352>",
  ticket: "<:ticket:1532818710715306125>",
  warn: "<:warn:1532819214786756739>",
  shield: "<:trueshield:1532818851144798370>",
  cloud: "<:cloud:1532811496768409620>",
  loading: "<:cloud:1532811496768409620>",
  notify: "<:notify:1532818516439466115>",
  user: "<:user:1532818667950313542>",
  left: "<:left:1536086198911635506>",
  right: "<:right:1536086294705471498>",
};

/**
 * Turn "<a:name:id>" into { id, name, animated } so it can be used with
 * ButtonBuilder#setEmoji / StringSelectMenuOptionBuilder#setEmoji.
 */
function parseEmoji(raw) {
  const m = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/.exec(String(raw || ""));
  if (!m) return null;
  // Animated emojis are intentionally disabled across the whole bot.
  return { animated: false, name: m[2], id: m[3] };
}

// Component-ready versions of the same emojis (buttons / select options).
const EMOJI_COMPONENT = Object.fromEntries(
  Object.entries(EMOJI).map(([key, value]) => [key, parseEmoji(value)]),
);

module.exports = {
  prefix: "a!",
  // Embed / Container accent color
  color: 0x06152b,

  // Custom emojis (provided by the bot owner) — used everywhere
  emoji: EMOJI,
  // Same emojis, shaped for discord.js component builders
  ce: EMOJI_COMPONENT,
  parseEmoji,

  // Fixed server: the bot only answers inside this guild
  guildId: process.env.GUILD_ID || "",

  // Required custom status: members must put this invite in their custom status
  requiredInvite: process.env.REQUIRED_INVITE || "discord.gg/A5P6aJp2wk",
  inviteUrl: process.env.INVITE_URL || "https://discord.gg/A5P6aJp2wk",

  // Bot owner (broadcast / feedback destination) and donate link
  ownerId: process.env.OWNER_ID || "",
  feedbackChannelId: process.env.FEEDBACK_CHANNEL_ID || "",
  donateUrl: process.env.DONATE_URL || "",

  // Gemini AI (Google) — optional, enables a!ai / a!explain
  geminiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",

  // Busy presence
  presence: {
    status: "dnd",
    name: "Dumping scripts | a!help",
  },

  // Max time (ms) a single dump may take
  bypassTimeout: Number(process.env.BYPASS_TIMEOUT || 300000),
};
