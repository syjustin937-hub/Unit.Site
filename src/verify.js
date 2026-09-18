// -----------------------------------------------------------------------------
// Access verification.
//  1) The bot only works inside the fixed server (GUILD_ID).
//  2) A member may only use the commands when their Discord custom status
//     contains the required server invite (e.g. discord.gg/A5P6aJp2wk).
// -----------------------------------------------------------------------------

const { guildId, requiredInvite, inviteUrl, ownerId } = require("./config");

/** Normalise an invite string so "discord.gg/x", ".com/invite/x" all match. */
function normaliseInvite(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^discord(app)?\.com\/invite\//, "discord.gg/")
    .replace(/^discord\.gg\//, "discord.gg/")
    .trim();
}

const REQUIRED = normaliseInvite(requiredInvite);
const REQUIRED_CODE = REQUIRED.split("/").pop();

/** Is this guild the one the bot is locked to? */
function isAllowedGuild(id) {
  if (!guildId) return true; // not configured -> no lock
  return String(id) === String(guildId);
}

/** Read the member's custom status text (needs the Presence intent). */
function customStatusOf(member) {
  const activities = member?.presence?.activities || [];
  const custom = activities.find((a) => a.type === 4 || a.name === "Custom Status");
  if (!custom) return "";
  return [custom.state, custom.details, custom.name].filter(Boolean).join(" ");
}

/**
 * @returns {{ok:boolean, reason?:"no_presence"|"missing_status", status:string}}
 */
function checkCustomStatus(member) {
  if (!REQUIRED_CODE) return { ok: true, status: "" };
  if (ownerId && member?.id === ownerId) return { ok: true, status: "" };

  const presence = member?.presence;
  const status = customStatusOf(member);
  const text = String(status).toLowerCase().replace(/\s+/g, "");

  if (text.includes(REQUIRED_CODE.toLowerCase())) return { ok: true, status };
  if (!presence) return { ok: false, reason: "no_presence", status };
  return { ok: false, reason: "missing_status", status };
}

module.exports = {
  isAllowedGuild,
  checkCustomStatus,
  customStatusOf,
  requiredInvite: REQUIRED || requiredInvite,
  inviteUrl,
};
