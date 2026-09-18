// Components V2 helpers
const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require("discord.js");
const { color } = require("./config");

function container(sections = []) {
  const c = new ContainerBuilder().setAccentColor(color);
  sections.forEach((part, i) => {
    if (part === null || part === undefined) return;
    if (part === "---") {
      c.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
      );
      return;
    }
    if (typeof part === "string") {
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(part));
      return;
    }
    // Pre-built component (ActionRow etc.) - skip empty rows (Discord rejects them)
    const inner = part?.components;
    if (Array.isArray(inner) && inner.length === 0) return;
    c.addActionRowComponents(part);
    void i;
  });
  return c;
}

function payload(components, extra = {}) {
  return {
    components,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    ...extra,
  };
}

module.exports = { container, payload, V2: MessageFlags.IsComponentsV2 };
