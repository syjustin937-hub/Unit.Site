const { PermissionFlagsBits } = require("discord.js");
const { getGuild } = require("./db");
const { t } = require("./i18n");
const { emoji, prefix } = require("./config");
const { container, payload } = require("./ui");
const { checkCustomStatus, requiredInvite } = require("./verify");

function isAdmin(member) {
  return !!member?.permissions?.has(PermissionFlagsBits.Administrator);
}

function deny(message, lang, text) {
  return message.reply(
    payload([container([`### ${emoji.false} ${t(lang, "error_title")}`, text])], {
      allowedMentions: { repliedUser: false, parse: [] },
    }),
  );
}

/**
 * Returns true when the member may run the command.
 */
async function checkAccess(message, commandName) {
  const settings = getGuild(message.guild.id);
  const lang = settings.language;

  // Blacklisted users can never use the bot.
  if (settings.blockedUsers.includes(message.author.id) && !isAdmin(message.member)) {
    await deny(message, lang, `${emoji.warn} ${t(lang, "blocked_user")}`);
    return false;
  }

  // Custom status verification: the member must advertise the server invite.
  const verified = checkCustomStatus(message.member);
  if (!verified.ok) {
    await deny(
      message,
      lang,
      [
        `${emoji.warn} ${t(lang, verified.reason === "no_presence" ? "verify_no_presence" : "verify_required")}`,
        "",
        `${emoji.ticket} \`${requiredInvite}\``,
        `-# ${t(lang, "verify_how")}`,
      ].join("\n"),
    );
    return false;
  }

  const adminCommands = [
    "setup",
    "settings",
    "set-br",
    "set-channel",
    "set-logs",
    "set-role",
    "set-lug",
    "auto",
    "whitelist",
    "blacklist",
    "maintenance",
    "reload",
    "broadcast",
  ];

  // Maintenance mode: admins only.
  if (settings.maintenance && !adminCommands.includes(commandName) && !isAdmin(message.member)) {
    await deny(message, lang, `${emoji.warn} ${t(lang, "maint_active")}`);
    return false;
  }

  if (adminCommands.includes(commandName)) {
    if (!isAdmin(message.member)) {
      await deny(message, lang, `${emoji.warn} ${t(lang, "admin_only")}`);
      return false;
    }
    return true;
  }

  if (["bypass", "tools", "v0"].includes(commandName)) {
    if (settings.bypassChannel && message.channel.id !== settings.bypassChannel) {
      await deny(
        message,
        lang,
        `${emoji.warn} ${t(lang, "wrong_channel")} <#${settings.bypassChannel}>`,
      );
      return false;
    }
    if (
      settings.requiredRole &&
      !settings.allowedUsers.includes(message.author.id) &&
      !message.member.roles.cache.has(settings.requiredRole)
    ) {
      await deny(
        message,
        lang,
        `${emoji.warn} ${t(lang, "missing_role")} <@&${settings.requiredRole}>`,
      );
      return false;
    }
  }
  return true;
}

/** Domain allow/block check shared by commands and auto bypass. */
function checkDomain(settings, hostname) {
  const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
  const hit = (list) => list.some((d) => host === d || host.endsWith("." + d));
  if (settings.blacklist.length && hit(settings.blacklist)) return "blocked_domain";
  if (settings.whitelist.length && !hit(settings.whitelist)) return "not_whitelisted";
  return null;
}

module.exports = { checkAccess, isAdmin, deny, checkDomain, prefix };
