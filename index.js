require("dotenv").config();

const { Client, GatewayIntentBits, Partials, ActivityType, MessageFlags } = require("discord.js");
const { prefix, emoji, ce, presence, ownerId, feedbackChannelId, donateUrl } = require("./src/config");
const { getGuild, setGuild } = require("./src/db");
const { t } = require("./src/i18n");
const { detect, SERVICES } = require("./src/services");
const { runBypass, backendStatus, testAll } = require("./src/backend");
const { checkAccess, checkDomain, isAdmin } = require("./src/permissions");
const { isAllowedGuild, checkCustomStatus, customStatusOf, requiredInvite, inviteUrl } = require("./src/verify");
const store = require("./src/store");
const apis = require("./src/apis");
const panels = require("./src/panels");
const { payload, container } = require("./src/ui");
const { handleDeobfCommand, DEOBF_COMMANDS } = require("./src/deobf/commands");
const { getContent } = require("./src/content");
const ai = require("./src/ai");
const genlink = require("./src/genlink");

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("[bot] Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel],
});

const START = Date.now();

if (!process.env.GUILD_ID) {
  console.warn("[bot] WARNING: GUILD_ID is empty — the single-server lock is disabled. Set it in .env.");
}

// messageId -> { url, userId, result }
const LAST = new Map();
function remember(messageId, data) {
  LAST.set(messageId, data);
  if (LAST.size > 500) LAST.delete(LAST.keys().next().value);
}

const noPing = { allowedMentions: { repliedUser: false, parse: [] } };

client.once("clientReady", onReady);
client.once("ready", onReady); // fallback for older discord.js builds

let readyDone = false;
function onReady() {
  if (readyDone) return;
  readyDone = true;
  console.log(`[bot] Logged in as ${client.user.tag} in ${client.guilds.cache.size} servers`);
  // Enforce the single-server lock on startup.
  for (const guild of client.guilds.cache.values()) {
    if (!isAllowedGuild(guild.id)) {
      console.log(`[bot] leaving unauthorised guild ${guild.id}`);
      guild.leave().catch(() => {});
    }
  }
  client.user.setPresence({
    status: presence.status,
    activities: [{ name: presence.name, type: ActivityType.Watching }],
  });
}

// The bot is locked to one server: leave everything else.
client.on("guildCreate", async (guild) => {
  if (isAllowedGuild(guild.id)) return;
  console.log(`[bot] leaving unauthorised guild ${guild.id}`);
  await guild.leave().catch(() => {});
});

/* ------------------------------- logging -------------------------------- */

async function sendLog(guild, lang, data) {
  const settings = getGuild(guild.id);
  if (!settings.logsChannel) return;
  const channel = guild.channels.cache.get(settings.logsChannel);
  if (!channel || !channel.isTextBased()) return;
  try {
    await channel.send(
      payload([
        container([
          `### ${data.success ? emoji.true : emoji.false} ${t(lang, "log_title")}`,
          "---",
          [
            `${emoji.user} **${t(lang, "log_user")}:** <@${data.userId}> (\`${data.userId}\`)`,
            `${emoji.cloud} **${t(lang, "service")}:** ${data.service}`,
            data.provider ? `${emoji.boost} **${t(lang, "provider")}:** ${data.provider}` : null,
            `${emoji.ticket} **${t(lang, "original")}:** \`${panels.truncate(data.url, 200)}\``,
            `${emoji.notify} **${t(lang, "log_status")}:** ${data.success ? t(lang, "success") : t(lang, "failed")}`,
            `${emoji.shield} **${t(lang, "took")}:** ${data.seconds}${t(lang, "seconds")}`,
          ]
            .filter(Boolean)
            .join("\n"),
          "---",
          `\`\`\`\n${panels.truncate(data.result, 900)}\n\`\`\``,
        ]),
      ]),
    );
  } catch (err) {
    console.error("[bot] log error:", err.message);
  }
}

/* ------------------------------- commands ------------------------------- */

const KNOWN = [
  "bypass",
  "get",
  "check",
  "supported",
  "verify",
  "apis",
  "test-apis",
  "setup",
  "settings",
  "set-br",
  "set-logs",
  "set-role",
  "set-lug",
  "help",
  "status",
  "ping",
  "stats",
  "logs",
  "history",
  "fav",
  "favorite",
  "whitelist",
  "blacklist",
  "maintenance",
  "reload",
  "broadcast",
  "feedback",
  "donate",
  "auto",
  "set-channel",
  "detect",
  "ai",
  "gemini",
  "explain",
  ...DEOBF_COMMANDS,
];

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Auto bypass: inside the bypass room a bare link is enough (no command).
    if (!message.content?.startsWith(prefix)) {
      await maybeAutoBypass(message);
      return;
    }

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = (args.shift() || "").toLowerCase();
    if (!command) return;

    if (!message.guild) {
      await message.reply(
        payload([container([`${emoji.warn} ${t("en", "guild_only")}`])], noPing),
      );
      return;
    }

    if (!isAllowedGuild(message.guild.id)) {
      await message.reply(
        payload([container([`${emoji.warn} ${t("en", "wrong_guild")}`])], noPing),
      );
      return;
    }

    // a!g-<service>  (link generator) — dynamic command name
    const isGen = command === "g" || command.startsWith("g-");
    if (!isGen && !KNOWN.includes(command)) return;

    const settings = getGuild(message.guild.id);
    const lang = settings.language;

    // Verification (fixed server + custom status) runs BEFORE every command,
    // including the deobfuscation / dumper ones.
    if (!(await checkAccess(message, command))) return;

    // Deobfuscation commands (developer server only) — handled separately.
    if (DEOBF_COMMANDS.includes(command)) {
      await handleDeobfCommand(message, args, command);
      return;
    }

    if (isGen) {
      await cmdGenlink(message, command.slice(2), args, lang);
      return;
    }

    switch (command) {
      case "bypass":
        await cmdBypass(message, args, lang);
        break;
      case "get":
        await cmdGet(message, args, lang);
        break;
      case "check":
        await cmdCheck(message, args, lang);
        break;
      case "detect":
        await cmdDetect(message, args, lang);
        break;
      case "ai":
      case "gemini":
        await cmdAi(message, args, lang);
        break;
      case "explain":
        await cmdExplain(message, args, lang);
        break;
      case "supported":
        await message.reply({ ...panels.supportedPanel(lang, 0, message.author.id), ...noPing });
        break;
      case "apis":
        await message.reply({ ...panels.apisPanel(lang, message.author.id), ...noPing });
        break;
      case "test-apis":
        await cmdTestApis(message, lang);
        break;
      case "verify":
        await cmdVerify(message, lang);
        break;
      case "setup":
        await message.reply({
          ...panels.setupPanel(message.guild.id, message.author.id),
          ...noPing,
        });
        break;
      case "settings":
        await message.reply({ ...panels.settingsPanel(message.guild.id), ...noPing });
        break;
      case "set-channel":
      case "set-br":
        await cmdSetChannel(message, lang, "bypassChannel", t(lang, "bypass_room"));
        break;
      case "set-logs":
        await cmdSetChannel(message, lang, "logsChannel", t(lang, "logs_room"));
        break;
      case "set-role":
        await cmdSetRole(message, lang);
        break;
      case "set-lug":
        await cmdSetLang(message, args, lang);
        break;
      case "help":
        await message.reply({ ...panels.helpPanel(lang, message.author.id), ...noPing });
        break;
      case "status":
        await cmdStatus(message, lang);
        break;
      case "ping":
        await cmdPing(message, lang);
        break;
      case "stats":
        await message.reply({ ...panels.statsPanel(lang, store.getStats(), message.author.id), ...noPing });
        break;
      case "logs":
        await message.reply({
          ...panels.logsPanel(lang, store.getHistory(message.guild.id, { limit: 10 }), message.author.id),
          ...noPing,
        });
        break;
      case "history":
        await message.reply({
          ...panels.historyPanel(
            lang,
            store.getHistory(message.guild.id, { userId: message.author.id, limit: 10 }),
            message.author.id,
          ),
          ...noPing,
        });
        break;
      case "fav":
      case "favorite":
        await cmdFav(message, args, lang);
        break;
      case "whitelist":
      case "blacklist":
        await cmdList(message, args, lang, command);
        break;
      case "maintenance":
        await cmdMaintenance(message, args, lang);
        break;
      case "auto":
        await cmdAuto(message, args, lang);
        break;
      case "reload":
        await cmdReload(message, lang);
        break;
      case "broadcast":
        await cmdBroadcast(message, lang);
        break;
      case "feedback":
        await cmdFeedback(message, lang);
        break;
      case "donate":
        await message.reply({ ...panels.donatePanel(lang, donateUrl, message.author.id), ...noPing });
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("[bot] command error:", err);
  }
});


/* --------------------------- a!g-<service> link --------------------------- */

function humanMs(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    return `${h}h ${Math.floor((total % 3600) / 60)}m`;
  }
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function genServicesLine() {
  return Object.entries(genlink.SERVICES)
    .map(([key, name]) => `\`${prefix}g-${key}\` — ${name}`)
    .join("\n");
}

async function cmdGenlink(message, rawService, args, lang) {
  const isOwner = ownerId && message.author.id === ownerId;
  const wanted = rawService || args[0] || "";
  const service = genlink.resolveService(wanted);

  if (!service) {
    await message.reply(
      payload(
        [
          container([
            `### ${emoji.warn} ${t(lang, "gen_title")}`,
            wanted ? t(lang, "gen_unknown") : null,
            "---",
            `${emoji.ticket} **${t(lang, "gen_usage")}:** \`${prefix}g-delta\``,
            `${emoji.cloud} **${t(lang, "gen_services")}:**\n${genServicesLine()}`,
          ]),
        ],
        noPing,
      ),
    );
    return;
  }

  const limit = genlink.checkLimit(message.author.id, isOwner);
  if (!limit.ok) {
    const lines =
      limit.reason === "cooldown"
        ? [
            `### ${emoji.warn} ${t(lang, "gen_title")}`,
            t(lang, "gen_cooldown"),
            `-# ${t(lang, "gen_cooldown_wait")} ${humanMs(limit.retryMs)}`,
          ]
        : [
            `### ${emoji.warn} ${t(lang, "gen_title")}`,
            t(lang, "gen_daily").replace("{n}", String(genlink.DAILY_LIMIT)),
            `-# ${t(lang, "gen_daily_reset")} ${humanMs(limit.resetMs)}`,
          ];
    await message.reply(payload([container(lines)], noPing));
    return;
  }

  const waiting = await message.reply(
    payload(
      [container([`### ${emoji.loading} ${t(lang, "gen_title")}`, t(lang, "gen_working")])],
      noPing,
    ),
  );

  const result = await genlink.generate(service);

  if (!result.ok) {
    await waiting.edit(
      payload([
        container([
          `### ${emoji.false} ${t(lang, "gen_title")}`,
          t(lang, "gen_failed"),
          `-# ${panels.truncate(String(result.error || ""), 300)}`,
        ]),
      ]),
    );
    return;
  }

  const left = genlink.consume(message.author.id, isOwner);
  const leftText = isOwner ? t(lang, "gen_unlimited") : `${left}/${genlink.DAILY_LIMIT}`;

  await waiting.edit(
    payload([
      container([
        `### ${emoji.true} ${t(lang, "gen_title")}`,
        "---",
        `${emoji.notify} **${t(lang, "gen_service")}:** ${result.name}`,
        `${emoji.ticket} **${t(lang, "gen_link")}:** ${result.link}`,
        `${emoji.user} **${t(lang, "gen_left")}:** ${leftText}`,
        "---",
        panels.row(panels.linkBtn(result.link, t(lang, "gen_open"))),
        `-# ${t(lang, "requested_by")} ${message.author.tag || message.author.username}`,
      ]),
    ]),
  );
}

/* ----------------------------- a!detect <link> ---------------------------- */

async function cmdDetect(message, args, lang) {
  const raw = args[0] || panels.firstUrl(message.content);
  if (!raw) {
    await message.reply(payload([container([`${emoji.warn} \`${prefix}detect <link>\``])], noPing));
    return;
  }

  const { url, service } = detect(raw);
  if (!url) {
    await message.reply(
      payload([container([`### ${emoji.false} ${t(lang, "detect_title")}`, t(lang, "bad_url")])], noPing),
    );
    return;
  }

  const lines = [
    `### ${service ? emoji.true : emoji.warn} ${t(lang, "detect_title")}`,
    "---",
    `${emoji.ticket} **${t(lang, "original")}:** \`${panels.truncate(url.href, 200)}\``,
    `${emoji.cloud} **${t(lang, "domain")}:** \`${url.hostname.replace(/^www\./, "")}\``,
    `${emoji.notify} **${t(lang, "service")}:** ${service ? service.name : "—"}`,
    "---",
    service ? `${emoji.true} ${t(lang, "detect_supported")}` : `${emoji.warn} ${t(lang, "detect_unsupported")}`,
    service ? `-# ${prefix}get ${panels.truncate(url.href, 120)}` : null,
  ].filter(Boolean);

  await message.reply(payload([container(lines)], noPing));
}

/* --------------------------- a!ai / a!explain ---------------------------- */

async function aiReply(message, lang, title, run) {
  if (!ai.isEnabled()) {
    await message.reply(payload([container([`${emoji.warn} ${t(lang, "ai_off")}`])], noPing));
    return;
  }

  const status = await message.reply(
    payload([container([`### ${emoji.cloud} ${t(lang, "ai_thinking")}`])], noPing),
  );

  try {
    const answer = await run();
    const body = String(answer);
    if (body.length > 3500) {
      await status
        .edit(payload([container([`### ${emoji.true} ${title}`, "---", panels.truncate(body, 3400)])]))
        .catch(() => {});
      await message
        .reply({
          files: [{ attachment: Buffer.from(body, "utf8"), name: "gemini-answer.md" }],
          allowedMentions: { repliedUser: false, parse: [] },
        })
        .catch(() => {});
      return;
    }
    await status.edit(payload([container([`### ${emoji.true} ${title}`, "---", body])])).catch(() => {});
  } catch (err) {
    await status
      .edit(payload([container([`### ${emoji.false} ${t(lang, "ai_title")}`, "---", ai.aiReason(err)])]))
      .catch(() => {});
  }
}

async function cmdAi(message, args, lang) {
  const question = args.join(" ").trim();
  if (!question) {
    await message.reply(
      payload([container([`${emoji.warn} \`${prefix}ai <question>\``, `-# ${t(lang, "ai_usage")}`])], noPing),
    );
    return;
  }
  await aiReply(message, lang, `${t(lang, "ai_title")} — ${ai.MODEL}`, () => ai.ask(question));
}

async function fetchAttachmentText(message) {
  let attachment = message.attachments?.first();
  if (!attachment && message.reference?.messageId) {
    const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    attachment = ref?.attachments?.first();
  }
  if (!attachment) return null;
  const res = await fetch(attachment.url).catch(() => null);
  if (!res || !res.ok) return null;
  const text = await res.text().catch(() => "");
  if (!text.trim()) return null;
  return { name: attachment.name || "script.lua", text };
}

async function cmdExplain(message, args, lang) {
  const file = await fetchAttachmentText(message);
  const inline = args.join(" ").trim();
  if (!file && !inline) {
    await message.reply(
      payload(
        [container([`${emoji.warn} \`${prefix}explain\` + attach a file, or reply to one.`])],
        noPing,
      ),
    );
    return;
  }
  await aiReply(message, lang, `${t(lang, "ai_title")} — ${file ? file.name : "code"}`, () =>
    ai.explainScript(file ? file.text : inline, file ? file.name : "snippet.lua"),
  );
}

/* ------------------------------ a!get <link> ----------------------------- */

async function cmdGet(message, args, lang) {
  const raw = args[0];
  if (!raw) {
    await message.reply(
      payload([container([`${emoji.warn} \`${prefix}get <link>\``])], noPing),
    );
    return;
  }

  const started = Date.now();
  const status = await message.reply(
    payload([container([`### ${emoji.loading} ${t(lang, "loading_title")}`, `\`${panels.truncate(raw, 200)}\``])], noPing),
  );

  let lastEdit = 0;
  const onStep = (msg) => {
    const now = Date.now();
    if (now - lastEdit < 3000) return;
    lastEdit = now;
    status
      .edit(
        payload([
          container([
            `### ${emoji.loading} ${t(lang, "loading_title")}`,
            `\`${panels.truncate(raw, 200)}\``,
            "---",
            `${emoji.cloud} ${panels.truncate(msg, 200)}`,
          ]),
        ]),
      )
      .catch(() => {});
  };

  const out = await getContent(raw, onStep).catch((err) => ({ success: false, error: err.message }));
  const seconds = ((Date.now() - started) / 1000).toFixed(2);

  if (!out.success) {
    await status
      .edit(
        payload([
          container([
            `### ${emoji.false} ${t(lang, "error_title")}`,
            "---",
            `${emoji.ticket} \`${panels.truncate(raw, 200)}\``,
            `\`\`\`\n${panels.truncate(String(out.error || "failed"), 900)}\n\`\`\``,
            `${emoji.shield} ${t(lang, "took")}: ${seconds}${t(lang, "seconds")}`,
          ]),
        ]),
      )
      .catch(() => {});
    return;
  }

  const buffer = Buffer.isBuffer(out.buffer) ? out.buffer : Buffer.from(String(out.content ?? ""), "utf8");
  const kind = out.isScript
    ? "Roblox / Lua script"
    : out.isBinary
      ? "File"
      : "Text content";
  const lines = [
    `### ${emoji.true} ${kind}`,
    "---",
    `${emoji.ticket} **Link:** \`${panels.truncate(out.source, 200)}\``,
    out.bypassed ? `${emoji.boost} **Bypassed to:** \`${panels.truncate(out.bypassed, 200)}\`` : null,
    out.target ? `${emoji.cloud} **Source file:** \`${panels.truncate(out.target, 200)}\`` : null,
    out.contentType ? `${emoji.notify} **Type:** \`${panels.truncate(out.contentType, 80)}\`` : null,
    `${emoji.cloud} **Size:** ${(buffer.length / 1024).toFixed(1)} KB`,
    `${emoji.shield} **${t(lang, "took")}:** ${seconds}${t(lang, "seconds")}`,
  ].filter(Boolean);

  await status.edit(payload([container(lines)])).catch(() => {});
  await message
    .reply({
      files: [{ attachment: buffer, name: out.filename }],
      allowedMentions: { repliedUser: false, parse: [] },
    })
    .catch(async () => {
      await message.reply(
        payload([container([`${emoji.warn} could not attach the file (too large)`])], noPing),
      );
    });
}

/* -------------------------------- bypass -------------------------------- */


async function performBypass({ lang, url, service, userId, edit, guild }) {
  const started = Date.now();
  let lastEdit = 0;
  let tick = 1;

  const onStep = (msg) => {
    const now = Date.now();
    if (now - lastEdit < 3000) return;
    lastEdit = now;
    tick += 1;
    edit(panels.loadingPanel(lang, url, service, msg, tick)).catch(() => {});
  };

  const outcome = await runBypass(service, url, onStep);
  const seconds = ((Date.now() - started) / 1000).toFixed(2);

  const finalPayload = outcome.success
    ? panels.successPanel(lang, url, service, outcome.result, seconds, outcome.provider, userId)
    : panels.errorPanel(lang, url, service, outcome.result, seconds, userId);

  const sent = await edit(finalPayload).catch(() => null);
  if (sent?.id) remember(sent.id, { url, userId, service: service.id, result: outcome.result });

  store.bumpStats({
    service: service.name,
    provider: outcome.provider,
    success: outcome.success,
    seconds,
  });
  if (guild) {
    store.addHistory(guild.id, {
      userId,
      url,
      service: service.name,
      provider: outcome.provider,
      success: outcome.success,
      seconds,
    });
    await sendLog(guild, lang, {
      userId,
      service: service.name,
      provider: outcome.provider,
      url,
      success: outcome.success,
      result: outcome.result,
      seconds,
    });
  }
  return outcome;
}

async function cmdBypass(message, args, lang) {
  const raw = args[0];
  if (!raw) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), `${t(lang, "no_url")}\n\`${prefix}bypass <url>\``),
      ...noPing,
    });
    return;
  }

  const { url, service } = detect(raw);
  if (!url) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), t(lang, "bad_url")),
      ...noPing,
    });
    return;
  }
  const blocked = checkDomain(getGuild(message.guild.id), url.hostname);
  if (blocked) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), t(lang, blocked)),
      ...noPing,
    });
    return;
  }
  if (!service) {
    await message.reply({
      ...panels.errorPanel(lang, url.href, null, t(lang, "unsupported"), undefined, message.author.id),
      ...noPing,
    });
    return;
  }

  const reply = await message.reply({
    ...panels.loadingPanel(lang, url.href, service, null, 1),
    ...noPing,
  });

  await performBypass({
    lang,
    url: url.href,
    service,
    userId: message.author.id,
    guild: message.guild,
    edit: (p) => reply.edit(p).then(() => reply),
  });
}

async function cmdCheck(message, args, lang) {
  const raw = args[0];
  if (!raw) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), `${t(lang, "no_url")}\n\`${prefix}check <url>\``),
      ...noPing,
    });
    return;
  }
  const { url, service } = detect(raw);
  if (!url) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "check_title"), t(lang, "bad_url")),
      ...noPing,
    });
    return;
  }

  const providers = apis.providersFor(url.href).map((p) => p.name);
  const body = [
    `${emoji.ticket} **${t(lang, "original")}:** \`${panels.truncate(url.href, 180)}\``,
    `${emoji.cloud} **${t(lang, "domain")}:** \`${url.hostname}\``,
    `${emoji.boost} **${t(lang, "service")}:** ${service ? service.name : "—"}`,
    `${emoji.notify} **${t(lang, "providers")}:** ${providers.length ? providers.map((p) => `\`${p}\``).join(", ") : "—"}`,
    "",
    service || providers.length
      ? `${emoji.true} ${t(lang, "supported_yes")}`
      : `${emoji.false} ${t(lang, "supported_no")}`,
  ].join("\n");

  const rows =
    service || providers.length
      ? [
          panels.row(
            panels.btn(`chk:go:${message.author.id}`, t(lang, "help_bypass"), 1, { emoji: ce.boost }),
            panels.btn(`nav:supported:${message.author.id}`, t(lang, "supported_btn"), 2, { emoji: ce.cloud }),
          ),
        ]
      : [panels.row(panels.btn(`nav:supported:${message.author.id}`, t(lang, "supported_btn"), 2, { emoji: ce.cloud }))];

  const reply = await message.reply({
    ...panels.simplePanel(service ? emoji.shield : emoji.warn, t(lang, "check_title"), body, rows),
    ...noPing,
  });
  remember(reply.id, { url: url.href, userId: message.author.id, service: service?.id });
}

async function cmdVerify(message, lang) {
  let member = message.member;
  try {
    member = await message.guild.members.fetch({ user: message.author.id, force: true });
  } catch {
    /* keep the cached member */
  }

  const out = checkCustomStatus(member);
  const current = customStatusOf(member);
  const body = out.ok
    ? [
        `${emoji.true} ${t(lang, "verify_ok")}`,
        "",
        `${emoji.ticket} \`${requiredInvite}\``,
      ].join("\n")
    : [
        `${emoji.warn} ${t(lang, out.reason === "no_presence" ? "verify_no_presence" : "verify_required")}`,
        "",
        `${emoji.ticket} \`${requiredInvite}\``,
        `${emoji.user} **${t(lang, "verify_current")}:** \`${panels.truncate(current || "—", 120)}\``,
        `-# ${t(lang, "verify_how")}`,
      ].join("\n");

  await message.reply({
    ...panels.simplePanel(out.ok ? emoji.true : emoji.warn, t(lang, "verify_title"), body, [
      panels.row(panels.linkBtn(inviteUrl, "Discord")),
    ]),
    ...noPing,
  });
}


/* ------------------------------- test-apis ------------------------------- */

async function cmdTestApis(message, lang) {
  const reply = await message.reply({ ...panels.testRunningPanel(lang), ...noPing });
  const report = await testAll();
  await reply.edit(panels.testPanel(lang, report, message.author.id)).catch(() => {});
}

/* ------------------------------- settings ------------------------------- */

async function cmdSetChannel(message, lang, key, label) {
  const channel = message.mentions.channels.first();
  if (!channel) {
    await message.reply({
      ...panels.simplePanel(
        emoji.warn,
        t(lang, "error_title"),
        `${t(lang, "usage")}: \`${prefix}${key === "bypassChannel" ? "set-br" : "set-logs"} #channel\``,
      ),
      ...noPing,
    });
    return;
  }
  setGuild(message.guild.id, { [key]: channel.id });
  await message.reply({
    ...panels.simplePanel(emoji.true, t(lang, "saved"), `${label}: <#${channel.id}>`),
    ...noPing,
  });
}

async function cmdSetRole(message, lang) {
  const role = message.mentions.roles.first();
  if (!role) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), `${t(lang, "usage")}: \`${prefix}set-role @role\``),
      ...noPing,
    });
    return;
  }
  setGuild(message.guild.id, { requiredRole: role.id });
  await message.reply({
    ...panels.simplePanel(emoji.true, t(lang, "saved"), `${t(lang, "required_role")}: <@&${role.id}>`),
    ...noPing,
  });
}

async function cmdSetLang(message, args, lang) {
  const value = (args[0] || "").toLowerCase();
  const map = { en: "en", english: "en", ar: "ar", arabic: "ar", عربي: "ar" };
  const next = map[value];
  if (!next) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), `${t(lang, "usage")}: \`${prefix}set-lug <en|ar>\``),
      ...noPing,
    });
    return;
  }
  setGuild(message.guild.id, { language: next });
  await message.reply({
    ...panels.simplePanel(emoji.true, t(next, "lang_changed"), next === "ar" ? "العربية" : "English"),
    ...noPing,
  });
}

function statusBody(lang, backends) {
  const uptimeSec = Math.floor((Date.now() - START) / 1000);
  const d = Math.floor(uptimeSec / 86400);
  const h = Math.floor((uptimeSec % 86400) / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const dot = (ok) => (ok ? `${emoji.true} ${t(lang, "online")}` : `${emoji.false} ${t(lang, "offline")}`);

  return [
    `${emoji.cloud} **${t(lang, "latency")}:** \`${Math.max(0, Math.round(client.ws.ping))}ms\``,
    `${emoji.shield} **${t(lang, "backend")}:** \`${apis.BASE}\``,
    `${emoji.cloud} **${t(lang, "apis_title")}:** ${dot(backends.apis)}`,
    `${emoji.notify} **${t(lang, "uptime")}:** \`${d}d ${h}h ${m}m ${s}s\``,
    `${emoji.user} **${t(lang, "servers")}:** \`${client.guilds.cache.size}\``,
    `${emoji.boost} **Services:** \`${SERVICES.length}\` • **${t(lang, "total_domains")}:** \`${apis.allDomains().length}\``,
  ].join("\n");
}

async function cmdStatus(message, lang) {
  const backends = await backendStatus();
  await message.reply({
    ...panels.simplePanel(emoji.boost, t(lang, "status_title"), statusBody(lang, backends), [
      panels.navRow(message.author.id),
    ]),
    ...noPing,
  });
}


/* ---------------------------- auto bypass ------------------------------- */

async function maybeAutoBypass(message) {
  if (!message.guild) return;
  if (!isAllowedGuild(message.guild.id)) return;
  if (!checkCustomStatus(message.member).ok) return;
  const settings = getGuild(message.guild.id);
  if (!settings.autoBypass || !settings.bypassChannel) return;
  if (message.channel.id !== settings.bypassChannel) return;

  const lang = settings.language;
  const raw = panels.firstUrl(message.content);
  if (!raw) return;

  if (settings.blockedUsers.includes(message.author.id)) return;
  if (settings.maintenance && !isAdmin(message.member)) return;
  if (
    settings.requiredRole &&
    !settings.allowedUsers.includes(message.author.id) &&
    !message.member?.roles?.cache?.has(settings.requiredRole)
  ) {
    return;
  }

  const { url, service } = detect(raw);
  if (!url) return;

  const blocked = checkDomain(settings, url.hostname);
  if (blocked) {
    await message.channel
      .send(panels.simplePanel(emoji.warn, t(lang, "error_title"), t(lang, blocked)))
      .catch(() => {});
    if (settings.autoDelete) await message.delete().catch(() => {});
    return;
  }

  // Delete the raw link message, then post the bypass panel.
  if (settings.autoDelete) await message.delete().catch(() => {});

  if (!service) {
    await message.channel
      .send(
        panels.errorPanel(lang, url.href, null, t(lang, "unsupported"), undefined, message.author.id),
      )
      .catch(() => {});
    return;
  }

  const sent = await message.channel
    .send({
      ...panels.loadingPanel(lang, url.href, service, `${t(lang, "requested_by")} <@${message.author.id}>`, 1),
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  if (!sent) return;

  await performBypass({
    lang,
    url: url.href,
    service,
    userId: message.author.id,
    guild: message.guild,
    edit: (p) => sent.edit(p).then(() => sent),
  });
}

/* ------------------------------- utility -------------------------------- */

async function cmdPing(message, lang) {
  const started = Date.now();
  const reply = await message.reply({
    ...panels.simplePanel(emoji.loading, t(lang, "ping_title"), t(lang, "loading_desc")),
    ...noPing,
  });
  const msgMs = Date.now() - started;

  let apiMs = null;
  try {
    const checks = await apis.testApis();
    const done = checks.filter((c) => c.ok || c.degraded);
    if (done.length) apiMs = Math.round(done.reduce((a, c) => a + c.ms, 0) / done.length);
  } catch {
    apiMs = null;
  }

  await reply
    .edit(
      panels.pingPanel(
        lang,
        { ws: Math.max(0, Math.round(client.ws.ping)), msg: msgMs, api: apiMs },
        message.author.id,
      ),
    )
    .catch(() => {});
}

async function cmdFav(message, args, lang) {
  const sub = (args.shift() || "list").toLowerCase();
  const userId = message.author.id;

  if (sub === "add") {
    const { url } = detect(args[0] || "");
    if (!url) {
      await message.reply({
        ...panels.simplePanel(emoji.warn, t(lang, "fav_title"), `${t(lang, "bad_url")}\n\`${prefix}fav add <url>\``),
        ...noPing,
      });
      return;
    }
    const out = store.addFavorite(userId, url.href, args.slice(1).join(" "));
    const notice = out.ok
      ? t(lang, "fav_added")
      : out.reason === "exists"
        ? t(lang, "fav_exists")
        : t(lang, "fav_full");
    await message.reply({ ...panels.favoritesPanel(lang, out.list, userId, notice), ...noPing });
    return;
  }

  if (sub === "del" || sub === "remove") {
    const index = Number(args[0]) - 1;
    const out = store.removeFavorite(userId, index);
    await message.reply({
      ...panels.favoritesPanel(lang, out.list, userId, out.ok ? t(lang, "fav_removed") : t(lang, "list_missing")),
      ...noPing,
    });
    return;
  }

  await message.reply({ ...panels.favoritesPanel(lang, store.getFavorites(userId), userId), ...noPing });
}

async function cmdList(message, args, lang, kind) {
  const sub = (args.shift() || "list").toLowerCase();
  const settings = getGuild(message.guild.id);
  const domainKey = kind === "whitelist" ? "whitelist" : "blacklist";
  const userKey = kind === "whitelist" ? "allowedUsers" : "blockedUsers";

  if (sub === "list") {
    await message.reply({ ...panels.listPanel(lang, kind, settings, message.author.id), ...noPing });
    return;
  }

  const mention = message.mentions.users.first();
  const value = mention
    ? mention.id
    : String(args[0] || "")
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .toLowerCase();

  if (!value) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "error_title"), `${t(lang, "usage")}: \`${prefix}${kind} add <domain|@user>\``),
      ...noPing,
    });
    return;
  }

  const key = mention ? userKey : domainKey;
  const list = [...settings[key]];
  let notice;

  if (sub === "add") {
    if (list.includes(value)) notice = t(lang, "list_exists");
    else {
      list.push(value);
      notice = `${t(lang, "list_added")}: \`${value}\``;
    }
  } else if (sub === "remove" || sub === "del") {
    if (!list.includes(value)) notice = t(lang, "list_missing");
    else {
      list.splice(list.indexOf(value), 1);
      notice = `${t(lang, "list_removed")}: \`${value}\``;
    }
  } else {
    notice = `${t(lang, "usage")}: \`${prefix}${kind} add|remove|list\``;
  }

  const updated = setGuild(message.guild.id, { [key]: list });
  await message.reply({ ...panels.listPanel(lang, kind, updated, message.author.id, notice), ...noPing });
}

async function cmdMaintenance(message, args, lang) {
  const settings = getGuild(message.guild.id);
  const value = (args[0] || "").toLowerCase();
  const next = value === "on" ? true : value === "off" ? false : !settings.maintenance;
  setGuild(message.guild.id, { maintenance: next });
  await message.reply({
    ...panels.simplePanel(
      next ? emoji.warn : emoji.true,
      t(lang, "maint_title"),
      next ? t(lang, "maint_on") : t(lang, "maint_off"),
    ),
    ...noPing,
  });
}

async function cmdAuto(message, args, lang) {
  const settings = getGuild(message.guild.id);
  const value = (args[0] || "").toLowerCase();
  const next = value === "on" ? true : value === "off" ? false : !settings.autoBypass;
  setGuild(message.guild.id, { autoBypass: next });
  await message.reply({
    ...panels.simplePanel(
      next ? emoji.true : emoji.warn,
      t(lang, "auto_title"),
      [next ? t(lang, "auto_on") : t(lang, "auto_off"), `-# ${t(lang, "auto_desc")}`].join("\n"),
    ),
    ...noPing,
  });
}

async function cmdReload(message, lang) {
  const before = Date.now();
  Object.keys(require.cache)
    .filter((k) => k.includes("/src/i18n") || k.includes("/src/config") || k.includes("/src/db"))
    .forEach((k) => delete require.cache[k]);
  require("./src/db").reload();
  await message.reply({
    ...panels.simplePanel(
      emoji.true,
      t(lang, "reload_title"),
      `${t(lang, "reload_done")}\n-# ${Date.now() - before}ms`,
    ),
    ...noPing,
  });
}

async function cmdBroadcast(message, lang) {
  if (!ownerId || message.author.id !== ownerId) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "broadcast_title"), t(lang, "broadcast_owner")),
      ...noPing,
    });
    return;
  }
  const text = message.content.split(/\s+/).slice(1).join(" ").trim();
  if (!text) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "broadcast_title"), t(lang, "broadcast_usage")),
      ...noPing,
    });
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const guild of client.guilds.cache.values()) {
    const settings = getGuild(guild.id);
    const channelId = settings.logsChannel || settings.bypassChannel;
    const channel = channelId ? guild.channels.cache.get(channelId) : null;
    if (!channel?.isTextBased()) {
      failed += 1;
      continue;
    }
    try {
      await channel.send(panels.broadcastPanel(settings.language, text, message.author.tag));
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  await message.reply({
    ...panels.simplePanel(
      emoji.true,
      t(lang, "broadcast_title"),
      `${t(lang, "broadcast_done")}\n${emoji.true} **${t(lang, "broadcast_sent")}:** \`${sent}\`\n${emoji.false} **${t(lang, "broadcast_failed")}:** \`${failed}\``,
    ),
    ...noPing,
  });
}

async function cmdFeedback(message, lang) {
  const text = message.content.split(/\s+/).slice(1).join(" ").trim();
  if (!text) {
    await message.reply({
      ...panels.simplePanel(emoji.warn, t(lang, "feedback_title"), `${t(lang, "feedback_usage")}\n\`${prefix}feedback <text>\``),
      ...noPing,
    });
    return;
  }

  store.addFeedback({ userId: message.author.id, guildId: message.guild.id, text });

  const body = [
    `${emoji.user} **${t(lang, "feedback_from")}:** <@${message.author.id}> (\`${message.author.id}\`)`,
    `${emoji.cloud} **${t(lang, "feedback_server")}:** ${message.guild.name} (\`${message.guild.id}\`)`,
    "---",
    `\`\`\`\n${panels.truncate(text, 1500)}\n\`\`\``,
  ].join("\n");
  const out = panels.simplePanel(emoji.notify, t(lang, "feedback_title"), body);

  if (feedbackChannelId) {
    const channel = client.channels.cache.get(feedbackChannelId);
    if (channel?.isTextBased()) await channel.send(out).catch(() => {});
  }
  if (ownerId) {
    const owner = await client.users.fetch(ownerId).catch(() => null);
    if (owner) await owner.send(out).catch(() => {});
  }

  await message.reply({
    ...panels.simplePanel(emoji.true, t(lang, "feedback_title"), t(lang, "feedback_sent")),
    ...noPing,
  });
}

/* ----------------------------- interactions ----------------------------- */

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isMessageComponent()) return;
    const [scope, action, owner] = interaction.customId.split(":");
    const lang = interaction.guild ? getGuild(interaction.guild.id).language : "en";
    const userId = interaction.user.id;

    if (scope === "noop") {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    /* --------------------------- navigation --------------------------- */
    if (scope === "nav") {
      if (action === "help") {
        await interaction.reply({ ...panels.helpPanel(lang, userId), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      } else if (action === "supported") {
        await interaction.reply({ ...panels.supportedPanel(lang, 0, userId), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      } else if (action === "verify") {
        const m = await interaction.guild.members.fetch({ user: userId, force: true }).catch(() => interaction.member);
        const out = checkCustomStatus(m);
        await interaction.reply({
          content: out.ok ? t(lang, "verify_ok") : `${t(lang, "verify_required")}  ${requiredInvite}`,
          flags: MessageFlags.Ephemeral,
        });
      } else if (action === "apis") {
        await interaction.reply({ ...panels.apisPanel(lang, userId), flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
      } else if (action === "status") {
        const backends = await backendStatus();
        await interaction.reply({
          ...panels.simplePanel(emoji.boost, t(lang, "status_title"), statusBody(lang, backends)),
          flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
      }
      return;
    }

    /* ----------------------------- results ----------------------------- */
    if (scope === "res" || scope === "chk") {
      const stored = LAST.get(interaction.message.id);
      if (owner && owner !== userId) {
        await interaction.reply({ content: t(lang, "only_requester"), flags: MessageFlags.Ephemeral });
        return;
      }

      if (action === "del") {
        await interaction.message.delete().catch(() => {});
        return;
      }

      if (action === "raw") {
        await interaction.reply({
          content: `\`\`\`\n${panels.truncate(stored?.result || t(lang, "no_result"), 1800)}\n\`\`\``,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (action === "retry" || action === "go") {
        if (!stored?.url) {
          await interaction.reply({ content: t(lang, "no_result"), flags: MessageFlags.Ephemeral });
          return;
        }
        const { url, service } = detect(stored.url);
        if (!url || !service) {
          await interaction.reply({ content: t(lang, "unsupported"), flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.update(panels.loadingPanel(lang, url.href, service, null, 1));
        await performBypass({
          lang,
          url: url.href,
          service,
          userId,
          guild: interaction.guild,
          edit: (p) => interaction.editReply(p).then(() => interaction.message),
        });
      }
      return;
    }

    /* --------------------------- stats/logs ---------------------------- */
    if (scope === "stats" || scope === "logs" || scope === "hist" || scope === "fav") {
      if (owner && owner !== userId) {
        await interaction.reply({ content: t(lang, "not_yours"), flags: MessageFlags.Ephemeral });
        return;
      }
      const guildId = interaction.guild?.id;

      if (scope === "stats") {
        if (action === "reset") store.resetStats();
        await interaction.update(panels.statsPanel(lang, store.getStats(), userId));
        return;
      }
      if (scope === "logs") {
        await interaction.update(panels.logsPanel(lang, store.getHistory(guildId, { limit: 10 }), userId));
        return;
      }
      if (scope === "hist") {
        if (action === "clear") store.clearHistory(guildId, userId);
        if (action === "go") {
          const items = store.getHistory(guildId, { userId, limit: 10 });
          const target = items[Number(interaction.values[0])];
          const { url, service } = detect(target?.url || "");
          if (!url || !service) {
            await interaction.reply({ content: t(lang, "unsupported"), flags: MessageFlags.Ephemeral });
            return;
          }
          await interaction.update(panels.loadingPanel(lang, url.href, service, null, 1));
          await performBypass({
            lang,
            url: url.href,
            service,
            userId,
            guild: interaction.guild,
            edit: (p) => interaction.editReply(p).then(() => interaction.message),
          });
          return;
        }
        await interaction.update(
          panels.historyPanel(lang, store.getHistory(guildId, { userId, limit: 10 }), userId),
        );
        return;
      }
      // favorites
      const favs = store.getFavorites(userId);
      if (action === "del") {
        const out = store.removeFavorite(userId, Number(interaction.values[0]));
        await interaction.update(panels.favoritesPanel(lang, out.list, userId, t(lang, "fav_removed")));
        return;
      }
      if (action === "go") {
        const target = favs[Number(interaction.values[0])];
        const { url, service } = detect(target?.url || "");
        if (!url || !service) {
          await interaction.reply({ content: t(lang, "unsupported"), flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.update(panels.loadingPanel(lang, url.href, service, null, 1));
        await performBypass({
          lang,
          url: url.href,
          service,
          userId,
          guild: interaction.guild,
          edit: (p) => interaction.editReply(p).then(() => interaction.message),
        });
        return;
      }
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    /* ---------------------------- test-apis ---------------------------- */
    if (scope === "test") {
      if (owner && owner !== userId) {
        await interaction.reply({ content: t(lang, "not_yours"), flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.update(panels.testRunningPanel(lang));
      const report = await testAll();
      await interaction.editReply(panels.testPanel(lang, report, userId)).catch(() => {});
      return;
    }

    /* ---------------------------- supported ---------------------------- */
    if (scope === "sup") {
      if (action === "page") {
        await interaction.deferUpdate().catch(() => {});
        return;
      }
      let page;
      if (action === "pick") page = Number(interaction.values[0]);
      else page = Number(owner) + (action === "next" ? 1 : -1);
      const safe = Math.min(Math.max(page || 0, 0), SERVICES.length - 1);
      await interaction.update(panels.supportedPanel(lang, safe, userId));
      return;
    }

    /* ------------------------------ setup ------------------------------ */
    if (scope !== "setup") return;

    if (owner && owner !== userId) {
      await interaction.reply({ content: t(lang, "not_yours"), flags: MessageFlags.Ephemeral });
      return;
    }
    if (!interaction.memberPermissions?.has("Administrator")) {
      await interaction.reply({ content: t(lang, "admin_only"), flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "br") {
      setGuild(interaction.guild.id, { bypassChannel: interaction.values[0] });
    } else if (action === "logs") {
      setGuild(interaction.guild.id, { logsChannel: interaction.values[0] });
    } else if (action === "role") {
      setGuild(interaction.guild.id, { requiredRole: interaction.values[0] });
    } else if (action === "lang") {
      setGuild(interaction.guild.id, { language: interaction.values[0] });
    } else if (action === "reset") {
      setGuild(interaction.guild.id, {
        bypassChannel: null,
        logsChannel: null,
        requiredRole: null,
      });
    } else if (action === "view") {
      await interaction.reply({
        ...panels.settingsPanel(interaction.guild.id),
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    await interaction.update(panels.setupPanel(interaction.guild.id, interaction.user.id));
  } catch (err) {
    console.error("[bot] interaction error:", err);
  }
});

process.on("unhandledRejection", (err) => console.error("[bot] unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[bot] uncaught exception:", err));

client.login(TOKEN);
