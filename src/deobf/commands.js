// Discord command wrappers for the deobfuscation system.
// Every command is a thin wrapper that only picks an endpoint key.
const { EmbedBuilder, AttachmentBuilder } = require("discord.js");
const { emoji, color, prefix } = require("../config");
const {
  deobfuscateFile,
  resolveSource,
  checkCooldown,
  SourceError,
  API_LABELS,
  DEOBF_GUILD_ID,
} = require("./index");

// command name -> endpoint key
const COMMANDS = {
  ms3: "ms3",
  promo: "promo",
  ib2: "ib2",
  luafuscate: "luafuscate",
  irv: "irv",
};

const DEOBF_COMMANDS = Object.keys(COMMANDS);

const ERRORS = {
  no_input: "No file or link provided. Attach a `.lua` / `.luau` / `.txt` file or pass a direct link.",
  bad_url: "That link is not a valid URL.",
  unreachable: "The link could not be reached.",
  download_timeout: "Timed out while downloading the file.",
  empty_file: "The file is empty.",
  bad_type: "Unsupported file type. Only `.lua`, `.luau` and `.txt` are allowed.",
  too_large: "The file is too large.",
  api_timeout: "The deobfuscation API timed out.",
  api_unreachable: "The deobfuscation API is unreachable.",
  api_invalid_response: "The API returned an invalid response.",
  api_empty_response: "The API returned an empty result.",
  api_no_code_field: "The API response did not contain `deobfuscated_code`.",
  api_empty_code: "The API returned an empty `deobfuscated_code`.",
  api_failed: "The API returned an error.",
  pastefy_no_key: "Pastefy is not configured.",
  busy: "The bot is handling too many requests right now. Try again in a moment.",
  unknown_method: "Unknown deobfuscation method.",
};

function reason(err) {
  const key = String(err?.message || "unknown");
  if (ERRORS[key]) return ERRORS[key];
  if (key.startsWith("http_")) return `The link returned HTTP ${key.slice(5)}.`;
  if (key.startsWith("api_http_")) return `The API returned HTTP ${key.slice(9)}.`;
  // API messages are safe text; never include stack traces or env values.
  return key.slice(0, 300);
}

const PASTE_ERRORS = {
  pastefy_no_key: "not configured",
  pastefy_timeout: "upload timed out",
  pastefy_unreachable: "upload failed (network)",
  pastefy_invalid_response: "invalid response",
};

function baseEmbed(title, desc) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();
}

async function handleDeobfCommand(message, args, command) {
  const type = COMMANDS[command];
  if (!type) return;

  // 1) Guild restriction — checked BEFORE any file handling or API call.
  if (!message.guild || message.guild.id !== DEOBF_GUILD_ID) {
    await message.reply({
      embeds: [
        baseEmbed(
          `${emoji.warn} Developer server only`,
          `The \`${prefix}${command}\` command can only be used inside the developer server.`,
        ),
      ],
      allowedMentions: { repliedUser: false, parse: [] },
    });
    return;
  }

  // 2) Cooldown
  const left = checkCooldown(message.author.id);
  if (left) {
    await message.reply({
      embeds: [baseEmbed(`${emoji.warn} Slow down`, `Please wait **${left}s** before using this command again.`)],
      allowedMentions: { repliedUser: false, parse: [] },
    });
    return;
  }

  const status = await message.reply({
    embeds: [baseEmbed(`${emoji.loading} Decrypting file...`, `Method: **${API_LABELS[type]}**`)],
    allowedMentions: { repliedUser: false, parse: [] },
  });

  let src;
  try {
    src = await resolveSource(message, args);
  } catch (err) {
    await status
      .edit({ embeds: [baseEmbed(`${emoji.false} Decryption failed.`, reason(err))] })
      .catch(() => {});
    return;
  }

  try {
    const out = await deobfuscateFile({ type, source: src.content, filename: src.name });

    const files = [];
    const buf = Buffer.from(out.code, "utf8");
    if (buf.byteLength <= 7.5 * 1024 * 1024) {
      files.push(new AttachmentBuilder(buf, { name: out.filename }));
    }

    const lines = [
      `**Method:** ${out.method}`,
      out.detected ? `**Detected:** ${out.detected}` : null,
      `**File:** \`${src.name}\``,
      `**Status:** Success`,
      `**Took:** ${out.seconds}s`,
      "",
      `**Pastefy:** ${out.paste ? out.paste.url : `_unavailable (${PASTE_ERRORS[out.pasteError] || "upload failed"})_`}`,
      out.paste ? `**Download:** ${out.paste.raw}` : null,
    ].filter((l) => l !== null);

    await status
      .edit({
        embeds: [baseEmbed(`${emoji.true} Decryption completed successfully.`, lines.join("\n"))],
        files,
      })
      .catch(async () => {
        // Discord upload failed (size / permissions) — retry without the file.
        await status
          .edit({
            embeds: [
              baseEmbed(
                `${emoji.true} Decryption completed successfully.`,
                `${lines.join("\n")}\n\n${emoji.warn} The result file could not be attached to Discord.`,
              ),
            ],
          })
          .catch(() => {});
      });
  } catch (err) {
    await status
      .edit({
        embeds: [
          baseEmbed(
            `${emoji.false} Decryption failed.`,
            `**Method:** ${API_LABELS[type]}\n**File:** \`${src.name}\`\n**Reason:** ${reason(err)}`,
          ),
        ],
      })
      .catch(() => {});
    if (!(err instanceof SourceError)) console.error(`[deobf] ${command} error:`, err.message);
  }
}

module.exports = { handleDeobfCommand, DEOBF_COMMANDS, COMMANDS };
