const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ChannelType,
} = require("discord.js");
const { emoji, ce, prefix } = require("./config");
const { container, payload } = require("./ui");
const { t } = require("./i18n");
const { SERVICES } = require("./services");
const apis = require("./apis");
const { getGuild } = require("./db");

/* ------------------------------- helpers -------------------------------- */

function truncate(value, max) {
  const str = String(value ?? "");
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function firstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s"'`<>)\]]+/);
  if (!match) return null;
  try {
    const u = new URL(match[0]);
    return u.href.length <= 512 ? u.href : null;
  } catch {
    return null;
  }
}

function row(...components) {
  return new ActionRowBuilder().addComponents(...components.filter(Boolean));
}

function btn(id, label, style = ButtonStyle.Secondary, extra = {}) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (extra.emoji) b.setEmoji(extra.emoji);
  if (extra.disabled) b.setDisabled(true);
  return b;
}

/** Discord limits link-button URLs to 512 chars and http(s)/discord schemes. */
function safeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  let href;
  try {
    href = new URL(raw).href;
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(href)) return null;
  return href.length <= 512 ? href : null;
}

/** Returns null when the URL is unusable, so rows/containers can skip it. */
function linkBtn(url, label) {
  const href = safeUrl(url);
  if (!href) return null;
  return new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setURL(href)
    .setLabel(truncate(label || "Open", 80));
}

/** Shared nav bar shown at the bottom of most panels. */
function navRow(userId) {
  return row(
    btn(`nav:help:${userId}`, "Help", ButtonStyle.Secondary, { emoji: ce.notify }),
    btn(`nav:supported:${userId}`, "Supported", ButtonStyle.Secondary, { emoji: ce.cloud }),
    btn(`nav:status:${userId}`, "Status", ButtonStyle.Secondary, { emoji: ce.ticket }),
  );
}

/* ----------------------------- setup panel ----------------------------- */

function setupComponents(userId) {
  return [
    row(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup:br:${userId}`)
        .setPlaceholder("Bypass Room")
        .addChannelTypes(ChannelType.GuildText),
    ),
    row(
      new ChannelSelectMenuBuilder()
        .setCustomId(`setup:logs:${userId}`)
        .setPlaceholder("Logs Room")
        .addChannelTypes(ChannelType.GuildText),
    ),
    row(
      new RoleSelectMenuBuilder()
        .setCustomId(`setup:role:${userId}`)
        .setPlaceholder("Required Role"),
    ),
    row(
      new StringSelectMenuBuilder()
        .setCustomId(`setup:lang:${userId}`)
        .setPlaceholder("Language / اللغة")
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel("English").setValue("en").setEmoji(ce.cloud),
          new StringSelectMenuOptionBuilder().setLabel("العربية").setValue("ar").setEmoji(ce.shield),
        ),
    ),
    row(
      btn(`setup:reset:${userId}`, "Reset", ButtonStyle.Danger, { emoji: ce.warn }),
      btn(`setup:view:${userId}`, "Current Settings", ButtonStyle.Success, { emoji: ce.shield }),
    ),
  ];
}

function setupPanel(guildId, userId) {
  const s = getGuild(guildId);
  const lang = s.language;
  return payload([
    container([
      `### ${emoji.shield} ${t(lang, "setup_title")}`,
      t(lang, "setup_desc"),
      "---",
      settingsLines(s, lang),
      "---",
      ...setupComponents(userId),
    ]),
  ]);
}

function settingsLines(s, lang) {
  return [
    `${emoji.right} **${t(lang, "auto_room")}:** ${s.autoBypass ? t(lang, "enabled") : t(lang, "disabled")}`,
    `${emoji.warn} **${t(lang, "maint_title")}:** ${s.maintenance ? t(lang, "enabled") : t(lang, "disabled")}`,
    `${emoji.ticket} **${t(lang, "bypass_room")}:** ${s.bypassChannel ? `<#${s.bypassChannel}>` : t(lang, "any_channel")}`,
    `${emoji.notify} **${t(lang, "logs_room")}:** ${s.logsChannel ? `<#${s.logsChannel}>` : t(lang, "not_set")}`,
    `${emoji.user} **${t(lang, "required_role")}:** ${s.requiredRole ? `<@&${s.requiredRole}>` : t(lang, "everyone")}`,
    `${emoji.cloud} **${t(lang, "language")}:** ${s.language === "ar" ? "العربية" : "English"}`,
  ].join("\n");
}

function settingsPanel(guildId) {
  const s = getGuild(guildId);
  const lang = s.language;
  return payload([
    container([`### ${emoji.boost} ${t(lang, "settings_title")}`, "---", settingsLines(s, lang)]),
  ]);
}

/* ------------------------------- bypass -------------------------------- */

const BAR = 12;
function progressBar(step) {
  const filled = Math.min(BAR, Math.max(1, step % (BAR + 1)));
  return "▰".repeat(filled) + "▱".repeat(BAR - filled);
}

function loadingPanel(lang, url, service, step, tick = 1) {
  return payload([
    container([
      `### ${emoji.loading} ${t(lang, "loading_title")}`,
      `-# ${t(lang, "loading_desc")}`,
      "---",
      [
        `${emoji.cloud} **${t(lang, "service")}:** ${service.name}`,
        `${emoji.ticket} **${t(lang, "original")}:** \`${truncate(url, 180)}\``,
        step ? `${emoji.notify} **${t(lang, "provider")}:** \`${truncate(step, 120)}\`` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "---",
      `\`${progressBar(tick)}\``,
      row(btn("noop:loading", "Working...", ButtonStyle.Secondary, { disabled: true, emoji: ce.loading })),
    ]),
  ]);
}

function resultRows(lang, userId, url, result) {
  const out = firstUrl(result);
  const original = firstUrl(url);
  const buttons = [];
  if (out) buttons.push(linkBtn(out, t(lang, "open_link")));
  if (original) buttons.push(linkBtn(original, t(lang, "open_original")));
  const rows = [];
  if (buttons.length) rows.push(row(...buttons));
  rows.push(
    row(
      btn(`res:retry:${userId}`, t(lang, "retry"), ButtonStyle.Primary, { emoji: ce.boost }),
      btn(`res:raw:${userId}`, t(lang, "raw"), ButtonStyle.Secondary, { emoji: ce.ticket }),
      btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false }),
    ),
  );
  return rows;
}

function successPanel(lang, url, service, result, seconds, provider, userId = "0") {
  return payload([
    container([
      `### ${emoji.true} ${t(lang, "success_title")}`,
      "---",
      [
        `${emoji.cloud} **${t(lang, "service")}:** ${service.name}`,
        provider ? `${emoji.boost} **${t(lang, "provider")}:** ${provider}` : null,
        `${emoji.ticket} **${t(lang, "original")}:** \`${truncate(url, 180)}\``,
        `${emoji.shield} **${t(lang, "took")}:** ${seconds}${t(lang, "seconds")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "---",
      `${emoji.boost} **${t(lang, "result")}:**\n\`\`\`\n${truncate(result, 1500)}\n\`\`\``,
      ...resultRows(lang, userId, url, result),
    ]),
  ]);
}

function errorPanel(lang, url, service, reason, seconds, userId = "0") {
  return payload([
    container([
      `### ${emoji.false} ${t(lang, "error_title")}`,
      "---",
      [
        service ? `${emoji.cloud} **${t(lang, "service")}:** ${service.name}` : null,
        `${emoji.ticket} **${t(lang, "original")}:** \`${truncate(url, 180)}\``,
        seconds !== undefined
          ? `${emoji.warn} **${t(lang, "took")}:** ${seconds}${t(lang, "seconds")}`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "---",
      `${emoji.warn} \`\`\`\n${truncate(reason, 1200)}\n\`\`\``,
      row(
        btn(`res:retry:${userId}`, t(lang, "retry"), ButtonStyle.Primary, { emoji: ce.boost }),
        btn(`nav:supported:${userId}`, t(lang, "supported_btn"), ButtonStyle.Secondary, { emoji: ce.cloud }),
        btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false }),
      ),
    ]),
  ]);
}

function simplePanel(titleEmoji, title, body, extraRows = []) {
  return payload([container([`### ${titleEmoji} ${title}`, "---", body, ...extraRows])]);
}

/* ------------------------------ supported ------------------------------ */

const PAGE_SIZE = 30;

function supportedPanel(lang, page = 0, userId = "0") {
  const service = SERVICES[Math.min(Math.max(page, 0), SERVICES.length - 1)];
  const domains = service.domains.slice(0, PAGE_SIZE);
  const more = service.domains.length - domains.length;

  const selector = row(
    new StringSelectMenuBuilder()
      .setCustomId(`sup:pick:${userId}`)
      .setPlaceholder(t(lang, "supported_title"))
      .addOptions(
        SERVICES.slice(0, 25).map((s, i) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(s.name, 90))
            .setDescription(`${s.domains.length} ${t(lang, "domains_count")}`)
            .setValue(String(i))
            .setDefault(i === page),
        ),
      ),
  );

  const nav = row(
    btn(`sup:prev:${page}`, t(lang, "prev"), ButtonStyle.Secondary, {
      emoji: ce.left,
      disabled: page === 0,
    }),
    btn("sup:page", `${page + 1}/${SERVICES.length}`, ButtonStyle.Primary, { disabled: true }),
    btn(`sup:next:${page}`, t(lang, "next"), ButtonStyle.Secondary, {
      emoji: ce.right,
      disabled: page === SERVICES.length - 1,
    }),
  );

  return payload([
    container([
      `### ${emoji.cloud} ${t(lang, "supported_title")}`,
      `-# ${t(lang, "supported_desc")}`,
      "---",
      [
        `${emoji.boost} **${service.name}**`,
        `${emoji.shield} \`${service.backend}\``,
        "",
        domains.map((d) => `${emoji.true} \`${d}\``).join("\n"),
        more > 0 ? `-# +${more} …` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "---",
      selector,
      nav,
    ]),
  ]);
}

/* --------------------------------- apis --------------------------------- */

function apisPanel(lang, userId) {
  const lines = apis.PLATFORMS.map((p) => `${emoji.true} **${p.name}** \`${p.example}\``);
  return payload([
    container([
      `### ${emoji.cloud} ${t(lang, "apis_title")}`,
      `-# ${t(lang, "apis_desc")}`,
      "---",
      lines.join("\n"),
      "---",
      [
        `${emoji.shield} **Backend:** \`${apis.BASE}\``,
        `${emoji.cloud} **${t(lang, "total_domains")}:** \`${apis.allDomains().length}\``,
        `${emoji.boost} **${t(lang, "providers")}:** \`${apis.PLATFORMS.length}\``,
      ].join("\n"),
      "---",
      navRow(userId),
    ]),
  ]);
}

/* -------------------------------- help --------------------------------- */

function helpPanel(lang, userId = "0") {
  return payload([
    container([
      `### ${emoji.boost} ${t(lang, "help_title")}`,
      "---",
      `${emoji.ticket} **${t(lang, "help_bypass")}**\n` +
        [
          `\`${prefix}bypass <url>\``,
          `\`${prefix}check <url>\``,
          `\`${prefix}supported\``,
          `\`${prefix}apis\``,
          `\`${prefix}test-apis\``,
          `\`${prefix}get <link>\``,
          `\`${prefix}detect <link>\``,
        ].join("\n"),
      "---",
      `${emoji.notify} **${t(lang, "help_user")}**\n` +
        [
          `\`${prefix}ping\``,
          `\`${prefix}status\``,
          `\`${prefix}stats\``,
          `\`${prefix}logs\``,
          `\`${prefix}history\``,
          `\`${prefix}fav add|list|del <url|number>\``,
          `\`${prefix}feedback <text>\``,
          `\`${prefix}donate\``,
          `\`${prefix}verify\``,
        ].join("\n"),
      "---",
      `${emoji.boost} **${t(lang, "gen_title")}**\n` +
        [
          `\`${prefix}g-delta\``,
          `\`${prefix}g-delta-ios\``,
          `\`${prefix}g-arceus\``,
          `\`${prefix}g-ntthub\``,
          `\`${prefix}g-panda\``,
          `\`${prefix}g-workink\``,
        ].join("\n"),
      "---",
      `${emoji.cloud} **AI (Gemini)**\n` +
        [
          `\`${prefix}ai <question>\``,
          `\`${prefix}explain <file|reply>\``,
        ].join("\n"),
      "---",
      `${emoji.shield} **${t(lang, "help_setup")}**\n` +
        [
          `\`${prefix}setup\``,
          `\`${prefix}settings\``,
          `\`${prefix}set-br #channel\``,
          `\`${prefix}set-channel #channel\``,
          `\`${prefix}set-logs #channel\``,
          `\`${prefix}set-role @role\``,
          `\`${prefix}set-lug <en|ar>\``,
          `\`${prefix}auto <on|off>\``,
        ].join("\n"),
      "---",
      `${emoji.warn} **${t(lang, "help_admin")}**\n` +
        [
          `\`${prefix}whitelist add|remove|list <domain|@user>\``,
          `\`${prefix}blacklist add|remove|list <domain|@user>\``,
          `\`${prefix}maintenance <on|off>\``,
          `\`${prefix}reload\``,
          `\`${prefix}broadcast <text>\``,
        ].join("\n"),
      "---",
      `-# ${emoji.right} ${t(lang, "auto_desc")}`,
      "---",
      navRow(userId),
    ]),
  ]);
}


/* ------------------------------- test-apis ------------------------------- */

const TEST_BAR = 14;
function scoreBar(score) {
  const filled = Math.max(0, Math.min(TEST_BAR, Math.round((score / 100) * TEST_BAR)));
  return "▰".repeat(filled) + "▱".repeat(TEST_BAR - filled);
}

function testRunningPanel(lang) {
  return payload([
    container([
      `### ${emoji.loading} ${t(lang, "test_title")}`,
      `-# ${t(lang, "test_running")}`,
    ]),
  ]);
}

/** Full report for `a!test-apis`. */
function testPanel(lang, report, userId = "0") {
  const line = (item) => {
    const icon = item.ok ? emoji.true : item.degraded ? emoji.warn : emoji.false;
    const state = item.ok ? t(lang, "online") : item.degraded ? t(lang, "limited") : t(lang, "offline");
    return `${icon} **${truncate(item.name, 60)}** — \`${state}\` -# ${truncate(item.detail, 40)} • ${item.ms}ms`;
  };

  const backends = report.items.filter((x) => x.kind === "backend");
  const remote = report.items.filter((x) => x.kind === "api");
  const health =
    report.score >= 80 ? emoji.true : report.score >= 40 ? emoji.warn : emoji.false;

  return payload([
    container([
      `### ${emoji.shield} ${t(lang, "test_title")}`,
      `-# ${t(lang, "test_desc")}`,
      "---",
      `${emoji.cloud} **${t(lang, "test_backends")}**\n` + backends.map(line).join("\n"),
      "---",
      `${emoji.notify} **${t(lang, "test_remote")}**\n` + remote.map(line).join("\n"),
      "---",
      [
        `${health} **${t(lang, "test_score")}:** \`${report.score}%\``,
        `\`${scoreBar(report.score)}\``,
        `${emoji.true} **${t(lang, "online")}:** \`${report.online}\` • ${emoji.warn} **${t(lang, "limited")}:** \`${report.degraded}\` • ${emoji.false} **${t(lang, "offline")}:** \`${report.offline}\` • ${emoji.ticket} **${t(lang, "test_total")}:** \`${report.total}\``,
        `${emoji.shield} **${t(lang, "took")}:** ${report.seconds}${t(lang, "seconds")}`,
      ].join("\n"),
      "---",
      row(
        btn(`test:again:${userId}`, t(lang, "refresh"), ButtonStyle.Primary, { emoji: ce.boost }),
        btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false }),
      ),
      navRow(userId),
    ]),
  ]);
}


/* ---------------------------- new panels -------------------------------- */

function shortTime(ts, lang) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return lang === "ar" ? "الآن" : "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** a!ping */
function pingPanel(lang, data, userId = "0") {
  return payload([
    container([
      `### ${emoji.cloud} ${t(lang, "ping_title")}`,
      `-# ${t(lang, "ping_desc")}`,
      "---",
      [
        `${emoji.boost} **${t(lang, "ping_ws")}:** \`${data.ws}ms\``,
        `${emoji.ticket} **${t(lang, "ping_msg")}:** \`${data.msg}ms\``,
        data.api === null
          ? null
          : `${emoji.cloud} **${t(lang, "ping_api")}:** \`${data.api}ms\``,
      ]
        .filter(Boolean)
        .join("\n"),
      "---",
      navRow(userId),
    ]),
  ]);
}

/** a!stats */
function statsPanel(lang, s, userId = "0") {
  if (!s.total) {
    return simplePanel(emoji.warn, t(lang, "stats_title"), t(lang, "stats_empty"), [navRow(userId)]);
  }
  const rate = Math.round((s.success / s.total) * 100);
  const avg = (s.totalSeconds / s.total).toFixed(2);
  const topService = Object.entries(s.services).sort((a, b) => b[1] - a[1])[0];
  const providerRows = Object.entries(s.providers);
  const bestProvider = providerRows
    .slice()
    .sort((a, b) => b[1].ok - a[1].ok)[0];
  const fastest = providerRows
    .filter(([, v]) => v.ok > 0)
    .sort((a, b) => a[1].seconds / a[1].ok - b[1].seconds / b[1].ok)[0];
  const today = s.days[new Date().toISOString().slice(0, 10)] || 0;

  return payload([
    container([
      `### ${emoji.boost} ${t(lang, "stats_title")}`,
      `-# ${t(lang, "stats_desc")}`,
      "---",
      [
        `${emoji.ticket} **${t(lang, "stats_total")}:** \`${s.total}\``,
        `${emoji.true} **${t(lang, "stats_success")}:** \`${s.success}\``,
        `${emoji.false} **${t(lang, "stats_failed")}:** \`${s.failed}\``,
        `${emoji.shield} **${t(lang, "stats_rate")}:** \`${rate}%\``,
        `\`${scoreBar(rate)}\``,
      ].join("\n"),
      "---",
      [
        `${emoji.cloud} **${t(lang, "stats_avg")}:** \`${avg}${t(lang, "seconds")}\``,
        topService ? `${emoji.notify} **${t(lang, "stats_top_service")}:** ${topService[0]} \`${topService[1]}\`` : null,
        bestProvider ? `${emoji.boost} **${t(lang, "stats_top_provider")}:** ${bestProvider[0]} \`${bestProvider[1].ok}\`` : null,
        fastest
          ? `${emoji.right} **${t(lang, "stats_fastest")}:** ${fastest[0]} \`${(fastest[1].seconds / fastest[1].ok).toFixed(2)}${t(lang, "seconds")}\``
          : null,
        `${emoji.user} **${t(lang, "stats_today")}:** \`${today}\``,
      ]
        .filter(Boolean)
        .join("\n"),
      "---",
      row(
        btn(`stats:reset:${userId}`, t(lang, "stats_reset"), ButtonStyle.Danger, { emoji: ce.warn }),
        btn(`stats:refresh:${userId}`, t(lang, "refresh"), ButtonStyle.Primary, { emoji: ce.boost }),
      ),
      navRow(userId),
    ]),
  ]);
}

function historyLine(lang, item, i) {
  const icon = item.success ? emoji.true : emoji.false;
  return `${icon} **${i + 1}.** \`${truncate(item.url, 70)}\`\n-# ${emoji.right} ${item.service || "—"} • ${item.provider || "—"} • ${item.seconds}${t(lang, "seconds")} • ${shortTime(item.at, lang)}`;
}

/** a!logs (server wide) */
function logsPanel(lang, items, userId = "0") {
  const body = items.length
    ? items.map((x, i) => `${historyLine(lang, x, i)}\n-# ${emoji.user} <@${x.userId}>`).join("\n")
    : `${emoji.warn} ${t(lang, "logs_empty")}`;
  return payload([
    container([
      `### ${emoji.ticket} ${t(lang, "logs_title")}`,
      `-# ${t(lang, "logs_desc")}`,
      "---",
      truncate(body, 3500),
      "---",
      row(
        btn(`logs:refresh:${userId}`, t(lang, "refresh"), ButtonStyle.Primary, { emoji: ce.boost }),
        btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false }),
      ),
      navRow(userId),
    ]),
  ]);
}

/** a!history (per user) */
function historyPanel(lang, items, userId = "0") {
  const body = items.length
    ? items.map((x, i) => historyLine(lang, x, i)).join("\n")
    : `${emoji.warn} ${t(lang, "history_empty")}`;
  const rows = [
    row(
      btn(`hist:refresh:${userId}`, t(lang, "refresh"), ButtonStyle.Primary, { emoji: ce.boost }),
      btn(`hist:clear:${userId}`, t(lang, "clear"), ButtonStyle.Danger, { emoji: ce.warn }),
      btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false }),
    ),
  ];
  if (items.length) {
    rows.unshift(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`hist:go:${userId}`)
          .setPlaceholder(t(lang, "help_bypass"))
          .addOptions(
            items.slice(0, 25).map((x, i) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`${i + 1}. ${truncate(x.url.replace(/^https?:\/\//, ""), 80)}`)
                .setValue(String(i))
                .setEmoji(x.success ? ce.true : ce.false),
            ),
          ),
      ),
    );
  }
  return payload([
    container([
      `### ${emoji.user} ${t(lang, "history_title")}`,
      `-# ${t(lang, "history_desc")}`,
      "---",
      truncate(body, 3500),
      "---",
      ...rows,
    ]),
  ]);
}

/** a!fav */
function favoritesPanel(lang, items, userId = "0", notice = null) {
  const body = items.length
    ? items
        .map(
          (x, i) =>
            `${emoji.true} **${i + 1}.** \`${truncate(x.url, 80)}\`${x.note ? `\n-# ${emoji.right} ${truncate(x.note, 60)}` : ""}`,
        )
        .join("\n")
    : `${emoji.warn} ${t(lang, "fav_empty")}`;

  const rows = [];
  if (items.length) {
    rows.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`fav:go:${userId}`)
          .setPlaceholder(t(lang, "fav_pick"))
          .addOptions(
            items.slice(0, 25).map((x, i) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`${i + 1}. ${truncate(x.url.replace(/^https?:\/\//, ""), 80)}`)
                .setValue(String(i))
                .setEmoji(ce.boost),
            ),
          ),
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(`fav:del:${userId}`)
          .setPlaceholder(t(lang, "delete"))
          .addOptions(
            items.slice(0, 25).map((x, i) =>
              new StringSelectMenuOptionBuilder()
                .setLabel(`${i + 1}. ${truncate(x.url.replace(/^https?:\/\//, ""), 80)}`)
                .setValue(String(i))
                .setEmoji(ce.false),
            ),
          ),
      ),
    );
  }
  rows.push(
    row(btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false })),
  );

  return payload([
    container(
      [
        `### ${emoji.boost} ${t(lang, "fav_title")}`,
        `-# ${t(lang, "fav_desc")}`,
        "---",
        notice ? `${emoji.notify} ${notice}` : null,
        truncate(body, 3000),
        `-# \`${prefix}fav add <url>\` • \`${prefix}fav del <number>\``,
        "---",
        ...rows,
      ].filter(Boolean),
    ),
  ]);
}

/** a!whitelist / a!blacklist */
function listPanel(lang, kind, settings, userId = "0", notice = null) {
  const domains = kind === "whitelist" ? settings.whitelist : settings.blacklist;
  const users = kind === "whitelist" ? settings.allowedUsers : settings.blockedUsers;
  const title = kind === "whitelist" ? t(lang, "whitelist_title") : t(lang, "blacklist_title");
  return payload([
    container(
      [
        `### ${kind === "whitelist" ? emoji.true : emoji.false} ${title}`,
        `-# ${t(lang, "list_desc")}`,
        "---",
        notice ? `${emoji.notify} ${notice}` : null,
        `${emoji.cloud} **${t(lang, "list_domains")}**\n` +
          (domains.length
            ? domains.map((d) => `${emoji.right} \`${d}\``).join("\n")
            : `-# ${t(lang, "list_empty")}`),
        "---",
        `${emoji.user} **${t(lang, "list_users")}**\n` +
          (users.length
            ? users.map((u) => `${emoji.right} <@${u}>`).join("\n")
            : `-# ${t(lang, "list_empty")}`),
        "---",
        `-# \`${prefix}${kind} add <domain|@user>\` • \`${prefix}${kind} remove <domain|@user>\``,
        row(btn(`res:del:${userId}`, t(lang, "delete"), ButtonStyle.Danger, { emoji: ce.false })),
      ].filter(Boolean),
    ),
  ]);
}

/** a!donate */
function donatePanel(lang, url, userId = "0") {
  const rows = [];
  if (url) rows.push(row(linkBtn(url, t(lang, "donate_link"))));
  rows.push(navRow(userId));
  return payload([
    container([
      `### ${emoji.boost} ${t(lang, "donate_title")}`,
      `-# ${t(lang, "donate_desc")}`,
      "---",
      url ? `${emoji.right} ${url}` : `${emoji.warn} \`DONATE_URL\``,
      "---",
      ...rows,
    ]),
  ]);
}

/** Broadcast message sent to every server. */
function broadcastPanel(lang, text, tag) {
  return payload([
    container([
      `### ${emoji.notify} ${t(lang, "broadcast_title")}`,
      "---",
      truncate(text, 1800),
      "---",
      `-# ${emoji.user} ${tag}`,
    ]),
  ]);
}

module.exports = {
  safeUrl,
  setupPanel,
  pingPanel,
  statsPanel,
  logsPanel,
  historyPanel,
  favoritesPanel,
  listPanel,
  donatePanel,
  broadcastPanel,
  scoreBar,
  testPanel,
  testRunningPanel,
  setupComponents,
  settingsPanel,
  settingsLines,
  loadingPanel,
  successPanel,
  errorPanel,
  simplePanel,
  supportedPanel,
  apisPanel,
  helpPanel,
  navRow,
  truncate,
  firstUrl,
  row,
  btn,
  linkBtn,
};
