// -----------------------------------------------------------------------------
// Google Gemini AI support for the Dumper Bot.
//
// Provides:
//   - ask()          : plain question -> answer
//   - explainScript(): explain / analyse a dumped Lua / Luau script
//
// Configuration (.env):
//   GEMINI_API_KEY   required
//   GEMINI_MODEL     optional (default: gemini-2.5-flash)
//   GEMINI_TIMEOUT   optional (ms, default 60000)
// -----------------------------------------------------------------------------

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TIMEOUT = Number(process.env.GEMINI_TIMEOUT || 60000);
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const SYSTEM_PROMPT = [
  "You are the assistant of a Discord Dumper Bot.",
  "You help members with dumped script files, link resolving, Lua / Luau code and general bot usage.",
  "Answer briefly and clearly. Use Discord markdown. Use code blocks for code.",
  "Reply in the same language the user wrote in (Arabic or English).",
  "Never invent bot commands that do not exist.",
].join(" ");

function isEnabled() {
  return Boolean(API_KEY);
}

async function callGemini(parts) {
  if (!API_KEY) throw new Error("ai_no_key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  let res;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(MODEL)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") throw new Error("ai_timeout");
    throw new Error("ai_unreachable");
  }
  clearTimeout(timer);

  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.parse(raw)?.error?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(`ai_http_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("ai_invalid_response");
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p) => p?.text || "")
    .join("")
    .trim();

  if (!text) throw new Error("ai_empty_response");
  return text;
}

/** Ask Gemini a free-form question. */
async function ask(question) {
  const q = String(question || "").trim();
  if (!q) throw new Error("ai_no_input");
  return callGemini([{ text: q }]);
}

/** Ask Gemini to explain a dumped script. */
async function explainScript(code, filename = "script.lua") {
  const src = String(code || "").slice(0, 60000);
  if (!src.trim()) throw new Error("ai_no_input");
  return callGemini([
    {
      text:
        `Analyse this dumped file \`${filename}\`.\n` +
        "Say what it does, list the main functions / remotes / endpoints it touches, " +
        "and flag anything suspicious or malicious. Keep it under 1500 characters.",
    },
    { text: "```lua\n" + src + "\n```" },
  ]);
}

const AI_ERRORS = {
  ai_no_key: "Gemini is not configured. Add `GEMINI_API_KEY` to the .env file.",
  ai_no_input: "Nothing to send. Write a question or attach a file.",
  ai_timeout: "Gemini took too long to answer.",
  ai_unreachable: "Gemini is unreachable right now.",
  ai_invalid_response: "Gemini returned an invalid response.",
  ai_empty_response: "Gemini returned an empty answer.",
};

function aiReason(err) {
  const key = String(err?.message || "unknown");
  if (AI_ERRORS[key]) return AI_ERRORS[key];
  if (key.startsWith("ai_http_")) return `Gemini API error (${key.slice(8)}).`;
  return key.slice(0, 300);
}

module.exports = { ask, explainScript, isEnabled, aiReason, MODEL };
