// Pastefy upload helper. The API key is read from the environment only.
const { PASTEFY_TIMEOUT_MS } = require("./config");

const PASTEFY_API = process.env.PASTEFY_API_URL || "https://pastefy.app/api/v2/paste";

function hasKey() {
  return !!process.env.PASTEFY_API_KEY;
}

/**
 * Uploads content to Pastefy and returns { url, raw } or throws.
 * Never logs or returns the API key.
 */
async function upload(title, content) {
  const key = process.env.PASTEFY_API_KEY;
  if (!key) throw new Error("pastefy_no_key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PASTEFY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(PASTEFY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        title: String(title || "deobfuscated").slice(0, 100),
        content,
        type: "PASTE",
        visibility: "UNLISTED",
        encrypted: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new Error(err.name === "AbortError" ? "pastefy_timeout" : "pastefy_unreachable");
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.success === false) {
    throw new Error(`pastefy_http_${res.status}`);
  }
  const id = data?.paste?.id || data?.id;
  if (!id) throw new Error("pastefy_invalid_response");
  return { url: `https://pastefy.app/${id}`, raw: `https://pastefy.app/api/v2/paste/${id}/raw` };
}

module.exports = { upload, hasKey };
