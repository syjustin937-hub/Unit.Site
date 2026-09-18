// Shared source resolver: Discord attachment or direct URL -> { name, content }
const { ALLOWED_EXTENSIONS, MAX_FILE_BYTES, DOWNLOAD_TIMEOUT_MS } = require("./config");

class SourceError extends Error {}

function extOf(name) {
  const m = /(\.[a-z0-9]+)$/i.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

function checkExt(name) {
  const ext = extOf(name);
  if (ext && !ALLOWED_EXTENSIONS.includes(ext)) throw new SourceError("bad_type");
}

function parseUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

async function fromUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) throw new SourceError("bad_url");

  const filename = decodeURIComponent(url.pathname.split("/").pop() || "script.lua");
  checkExt(filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url.href, { signal: controller.signal, redirect: "follow" });
  } catch (err) {
    clearTimeout(timer);
    throw new SourceError(err.name === "AbortError" ? "download_timeout" : "unreachable");
  }
  clearTimeout(timer);

  if (!res.ok) throw new SourceError(`http_${res.status}`);

  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/")) {
    throw new SourceError("bad_type");
  }
  const len = Number(res.headers.get("content-length") || 0);
  if (len && len > MAX_FILE_BYTES) throw new SourceError("too_large");

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_FILE_BYTES) throw new SourceError("too_large");
  const content = buf.toString("utf8");
  if (!content.trim()) throw new SourceError("empty_file");
  return { name: filename || "script.lua", content };
}

async function fromAttachment(att) {
  checkExt(att.name);
  if (att.size > MAX_FILE_BYTES) throw new SourceError("too_large");
  const got = await fromUrl(att.url).catch((err) => {
    throw err instanceof SourceError ? err : new SourceError("unreachable");
  });
  return { name: att.name || got.name, content: got.content };
}

/** Resolve the input of a command message (attachment first, then URL argument). */
async function resolveSource(message, args) {
  const att = message.attachments?.first?.();
  if (att) return fromAttachment(att);
  const raw = (args || []).find((a) => /^https?:\/\//i.test(a));
  if (raw) return fromUrl(raw);
  throw new SourceError("no_input");
}

module.exports = { resolveSource, fromUrl, fromAttachment, SourceError, parseUrl };
