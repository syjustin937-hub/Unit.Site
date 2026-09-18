// -----------------------------------------------------------------------------
// Content resolver used by `a!get <link>`.
//
// 1. Hidden/ad links are bypassed first (parallel local engine + backend).
// 2. The destination is downloaded as RAW BYTES with a proper HTTP client that
//    follows redirects safely.
// 3. Content-Type, Content-Disposition and the URL extension decide the type.
//    - real file  -> bytes are kept exactly as received (never stringified)
//    - text/html  -> NOT treated as Lua; we look for a clear direct download
//                    link (or a <pre>/<code> script block) and re-fetch it,
//                    then verify the final response is a real file, not HTML.
// -----------------------------------------------------------------------------

const { runBypass } = require("./backend");
const { engineFor } = require("./bypass");
const apis = require("./apis");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 8;

const FILE_EXT =
  /\.(lua|luau|txt|json|js|ts|py|rbxm|rbxmx|rbxl|zip|rar|7z|tar|gz|exe|dll|pdf|png|jpe?g|gif|webp|mp3|mp4|csv|md|xml|yml|yaml|ini|cfg|bin|dat)$/i;

function parseUrl(raw) {
  try {
    const u = new URL(String(raw).trim().replace(/^<|>$/g, ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function host(url) {
  return url.hostname.replace(/^www\./, "").toLowerCase();
}

/** Map a known paste/script page to its raw endpoint. */
function rawUrlFor(url) {
  const h = host(url);
  const seg = url.pathname.split("/").filter(Boolean);
  const id = seg[seg.length - 1] || "";

  if (h === "pastebin.com" && id && seg[0] !== "raw") return `https://pastebin.com/raw/${id}`;
  if (h === "pastefy.app" || h === "pastefy.ga") return `https://pastefy.app/api/v2/paste/${id}/raw`;
  if (h === "paste.ee") return `https://paste.ee/r/${id}`;
  if (h === "hastebin.com" || h === "hasteb.in") return `https://hastebin.com/raw/${id}`;
  if (h === "controlc.com" || h === "anotepad.com") return url.href;
  if (h === "rentry.co" || h === "rentry.org") return `${url.origin}${url.pathname.replace(/\/$/, "")}/raw`;
  if (h === "github.com" && url.pathname.includes("/blob/")) {
    return `https://raw.githubusercontent.com${url.pathname.replace("/blob/", "/")}`;
  }
  if (h === "gist.github.com") return `${url.href.replace(/\/$/, "")}/raw`;
  if (h === "gitlab.com" && url.pathname.includes("/blob/")) return url.href.replace("/blob/", "/raw/");
  if (h === "drive.google.com") {
    const m = /\/file\/d\/([^/]+)/.exec(url.pathname) || [null, url.searchParams.get("id")];
    if (m[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  }
  if (h === "dropbox.com" || h === "dl.dropboxusercontent.com") {
    const u = new URL(url.href);
    u.searchParams.set("dl", "1");
    return u.href;
  }
  if (h === "rawscripts.net" && url.searchParams.get("id")) {
    return `https://rawscripts.net/raw/${url.searchParams.get("id")}`;
  }
  return url.href;
}

function looksLikeScript(text) {
  return /loadstring|game:HttpGet|getgenv\(|_G\.|game\.Players\.LocalPlayer|hookfunction|syn\.|\blocal\s+\w+\s*=|Roblox/i.test(
    text,
  );
}

function looksLikeHtml(buf, contentType) {
  if (/text\/html|application\/xhtml/i.test(contentType || "")) return true;
  const head = buf.slice(0, 512).toString("utf8").trim().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

function isBinaryBuffer(buf) {
  const slice = buf.slice(0, 4000);
  for (const b of slice) {
    if (b === 0) return true;
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000E-\u001F]/.test(slice.toString("utf8"));
}

function filenameFromDisposition(value) {
  if (!value) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?["']?([^;"']+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename\s*=\s*["']?([^;"']+)/i.exec(value);
  return plain ? plain[1].trim() : null;
}

function filenameFromUrl(url) {
  const seg = url.pathname.split("/").filter(Boolean).pop() || "";
  if (!seg) return null;
  // any segment that looks like a real file name (known ext, or "name.ext")
  if (FILE_EXT.test(seg) || /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(seg)) return decodeURIComponent(seg);
  return null;
}

function extFor(contentType, buf) {
  const ct = (contentType || "").split(";")[0].toLowerCase();
  const map = {
    "text/x-lua": "lua",
    "application/x-lua": "lua",
    "text/plain": "txt",
    "application/json": "json",
    "text/json": "json",
    "application/javascript": "js",
    "text/javascript": "js",
    "application/zip": "zip",
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
  };
  if (map[ct]) return map[ct];
  if (isBinaryBuffer(buf)) return "bin";
  const text = buf.slice(0, 4000).toString("utf8");
  if (looksLikeScript(text)) return "lua";
  if (/^\s*[[{]/.test(text)) return "json";
  return "txt";
}

/** Manual redirect following so we can inspect every hop. */
async function httpGet(target, { referer } = {}) {
  let current = target;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: {
        "user-agent": UA,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        ...(referer ? { referer } : {}),
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, current);
      if (next.protocol !== "http:" && next.protocol !== "https:") break;
      current = next.href;
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      disposition: res.headers.get("content-disposition") || "",
      buffer: buf.slice(0, MAX_BYTES),
      finalUrl: current,
    };
  }
  throw new Error("too many redirects");
}

const DOWNLOAD_HOST =
  /(raw\.githubusercontent|gitlab|pastebin\.com\/raw|paste\.ee\/r\/|rentry\.[a-z]+\/.+\/raw|hastebin\.com\/raw|cdn\.discordapp\.com|files\.catbox\.moe|uploadhaven|mediafire|pixeldrain|anonfiles|gofile|workers\.dev|amazonaws\.com|googleusercontent)/i;

/** Pull a clear direct-download link out of an HTML page. */
function directLinkFromHtml(html, baseUrl) {
  const candidates = [];
  const push = (href) => {
    if (!href) return;
    try {
      const u = new URL(href.replace(/&amp;/g, "&"), baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") candidates.push(u.href);
    } catch {
      /* ignore */
    }
  };

  // <meta http-equiv="refresh">
  const meta = /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"';]+)/i.exec(html);
  if (meta) push(meta[1]);

  // anchors with a download attribute or a file extension / download wording
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const [tag, href, label] = [m[0], m[1], m[2].replace(/<[^>]+>/g, "").trim()];
    const scored =
      /\bdownload\b/i.test(tag) ||
      /download|تحميل|raw|get file/i.test(label) ||
      FILE_EXT.test(href.split("?")[0]) ||
      DOWNLOAD_HOST.test(href);
    if (scored) push(href);
  }

  // explicit file urls anywhere in the markup / inline JS
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
    const href = m[0];
    if (FILE_EXT.test(href.split("?")[0]) || DOWNLOAD_HOST.test(href)) push(href);
  }

  const seen = new Set();
  const unique = candidates.filter((c) => (seen.has(c) ? false : seen.add(c)));
  // prefer known raw/file hosts, then plain file extensions
  return (
    unique.find((c) => DOWNLOAD_HOST.test(c)) ||
    unique.find((c) => FILE_EXT.test(c.split("?")[0])) ||
    null
  );
}

/** Fall back to scraping <pre>/<code> blocks out of an HTML page. */
function extractFromHtml(html) {
  const blocks = [...html.matchAll(/<(?:pre|code|textarea)[^>]*>([\s\S]*?)<\/(?:pre|code|textarea)>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/g, "&")
        .trim(),
    )
    .filter((t) => t.length > 20);
  if (!blocks.length) return null;
  return blocks.sort((a, b) => b.length - a.length)[0];
}

function nameFor(res, url, buffer) {
  const fromHeader = filenameFromDisposition(res.disposition);
  if (fromHeader) return fromHeader.replace(/[/\\]/g, "_");
  const fromUrl = filenameFromUrl(url);
  if (fromUrl) return fromUrl.replace(/[/\\]/g, "_");
  return `${host(url).replace(/[^a-z0-9]+/g, "-")}-content.${extFor(res.contentType, buffer)}`;
}

/**
 * Resolve a link into a downloadable file.
 * @returns {{success:boolean, buffer?:Buffer, filename?:string, isScript?:boolean,
 *            isBinary?:boolean, contentType?:string, error?:string}}
 */
async function getContent(raw, onStep = () => {}) {
  const url = parseUrl(raw);
  if (!url) return { success: false, error: "invalid url" };

  const steps = [];
  const log = (msg) => {
    steps.push(msg);
    onStep(msg);
  };

  let target = url.href;
  let bypassed = null;

  // 1) hidden link? bypass it first (parallel engines + cache)
  if (engineFor(target) || apis.isSupportedRemotely(target)) {
    log("Hidden link detected — bypassing...");
    const out = await runBypass({ id: "auto", name: "auto" }, target, log).catch(() => null);
    if (!out?.success) return { success: false, error: out?.result || "bypass failed", steps };
    bypassed = out.result;
    target = out.result;
    log(`Bypassed → ${bypassed}`);
  }

  const finalUrl = parseUrl(target);
  if (!finalUrl) {
    // The bypass returned a key / plain text instead of a URL.
    return {
      success: true,
      steps,
      bypassed,
      source: url.href,
      filename: "result.txt",
      buffer: Buffer.from(String(target), "utf8"),
      contentType: "text/plain",
      isScript: false,
      isBinary: false,
    };
  }

  // 2) download the bytes (raw endpoint when we know one)
  let fetchUrl = rawUrlFor(finalUrl);
  log(`Downloading from ${host(finalUrl)}...`);
  let res;
  try {
    res = await httpGet(fetchUrl);
  } catch (err) {
    return { success: false, error: `fetch failed: ${err.message}`, steps, bypassed };
  }
  if (res.status >= 400) {
    return { success: false, error: `HTTP ${res.status} from ${host(finalUrl)}`, steps, bypassed };
  }

  const hasDisposition = /attachment/i.test(res.disposition) || !!filenameFromDisposition(res.disposition);

  // 3) HTML? never assume it's Lua — look for a direct download link first.
  if (!hasDisposition && looksLikeHtml(res.buffer, res.contentType)) {
    const html = res.buffer.toString("utf8");
    const direct = directLinkFromHtml(html, res.finalUrl);
    if (direct && direct !== res.finalUrl) {
      log("Found a direct download link on the page — following it...");
      try {
        const second = await httpGet(direct, { referer: res.finalUrl });
        const secondHasFile =
          second.status < 400 &&
          second.buffer.length > 0 &&
          (/attachment/i.test(second.disposition) ||
            !!filenameFromDisposition(second.disposition) ||
            !looksLikeHtml(second.buffer, second.contentType));
        if (secondHasFile) {
          res = second;
          fetchUrl = direct;
        }
      } catch {
        /* keep the html result */
      }
    }
  }

  // 4) still HTML? try a <pre>/<code> block, otherwise fail clearly.
  if (looksLikeHtml(res.buffer, res.contentType) && !/attachment/i.test(res.disposition)) {
    const html = res.buffer.toString("utf8");
    const extracted = extractFromHtml(html);
    if (!extracted) {
      return {
        success: false,
        error: "the final URL returns an HTML page, not a file (no direct download link found)",
        steps,
        bypassed,
        target: fetchUrl,
      };
    }
    log("Extracted the embedded script/code block from the page.");
    const buffer = Buffer.from(extracted, "utf8");
    return {
      success: true,
      steps,
      bypassed,
      source: url.href,
      target: fetchUrl,
      filename: `${host(finalUrl).replace(/[^a-z0-9]+/g, "-")}-content.${looksLikeScript(extracted) ? "lua" : "txt"}`,
      buffer,
      contentType: "text/plain",
      isScript: looksLikeScript(extracted),
      isBinary: false,
    };
  }

  if (!res.buffer.length) return { success: false, error: "the destination returned an empty file", steps, bypassed };

  const isBinary = isBinaryBuffer(res.buffer);
  const preview = isBinary ? "" : res.buffer.slice(0, 4000).toString("utf8");

  return {
    success: true,
    steps,
    bypassed,
    source: url.href,
    target: res.finalUrl,
    filename: nameFor(res, parseUrl(res.finalUrl) || finalUrl, res.buffer),
    buffer: res.buffer,
    contentType: res.contentType,
    isBinary,
    isScript: !isBinary && looksLikeScript(preview),
  };
}

module.exports = { getContent, parseUrl, rawUrlFor, looksLikeScript, directLinkFromHtml };
