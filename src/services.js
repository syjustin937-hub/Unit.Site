// Service detection — every platform is handled by the private backend API.
const apis = require("./apis");

const SERVICES = apis.PLATFORMS.map((p) => ({
  id: p.id,
  name: p.name,
  backend: `Private API — ${apis.BASE}`,
  remote: true,
  remoteOnly: true,
  example: p.example,
  domains: [...p.domains].sort(),
  match(url) {
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    return apis.domainMatch(host, this.domains);
  },
}));

function parseUrl(raw) {
  try {
    const cleaned = String(raw).trim().replace(/^<|>$/g, "");
    const u = new URL(cleaned);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

function detect(raw) {
  const url = parseUrl(raw);
  if (!url) return { url: null, service: null };
  const service = SERVICES.find((s) => s.match(url)) || null;
  return { url, service };
}

module.exports = { SERVICES, LOCAL_SERVICES: [], REMOTE_SERVICES: SERVICES, detect, parseUrl };
