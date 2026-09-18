// LeakD Deobfuscator & Detector API client.
// Docs: https://leakd.vercel.app/api
const { API_BASE, API_ENDPOINTS, API_TIMEOUT_MS } = require("./config");

// Safe debug logging (never prints file contents or secrets).
const DEBUG = /^(1|true|yes)$/i.test(String(process.env.DEOBF_DEBUG || ""));

class ApiError extends Error {}

async function postJson(path, body, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new ApiError("api_timeout");
    throw new ApiError("api_unreachable");
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!data || typeof data !== "object") {
    if (!res.ok) throw new ApiError(`api_http_${res.status}`);
    throw new ApiError("api_invalid_response");
  }
  if (data.success === false || (!res.ok && data.error)) {
    throw new ApiError(String(data.error || `HTTP ${res.status}`));
  }
  if (!res.ok) throw new ApiError(`api_http_${res.status}`);
  return data;
}

/** Run a deobfuscation endpoint. Returns { code, detection }. */
async function deobfuscate(type, code, filename) {
  const path = API_ENDPOINTS[type];
  if (!path) throw new ApiError("unknown_method");

  const data = await postJson(path, { code, filename }, API_TIMEOUT_MS);

  if (DEBUG) {
    console.log("[leakd] endpoint:", path);
    console.log("[leakd] response keys:", Object.keys(data || {}));
    console.log("[leakd] success:", data?.success);
    console.log("[leakd] deobfuscated code length:", data?.deobfuscated_code?.length || 0);
  }

  // The API explicitly reports failure.
  if (data.success === false) {
    throw new ApiError(String(data.error || data.message || "api_failed"));
  }

  // Primary documented field, then legacy fallbacks (kept for other endpoints).
  const out =
    typeof data.deobfuscated_code === "string"
      ? data.deobfuscated_code
      : (data.code ?? data.result ?? data.output ?? data.script);

  if (typeof out !== "string") throw new ApiError("api_no_code_field");
  if (!out.trim()) throw new ApiError("api_empty_code");

  return { code: out, detection: formatDetection(data.detection) };
}

/** "MoonSec V3 (100%)" from either the /detect or the endpoint detection object. */
function formatDetection(d) {
  if (!d || typeof d !== "object") return null;
  const name = d.name || d.obfuscator;
  if (!name) return null;
  return `${name}${d.version ? ` ${d.version}` : ""}${d.confidence != null ? ` (${d.confidence}%)` : ""}`;
}

/** Optional detector — used to enrich the response embed. */
async function detect(code) {
  try {
    const data = await postJson("/detect", { code }, Math.min(API_TIMEOUT_MS, 30000));
    return formatDetection(data.top_result);
  } catch {
    return null;
  }
}

module.exports = { deobfuscate, detect, formatDetection, ApiError };
