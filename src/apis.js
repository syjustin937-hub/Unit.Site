// -----------------------------------------------------------------------------
// Bypass backend (private API).
// This bot talks ONLY to the owner's own backend. All third-party / public
// bypass APIs have been removed.
// -----------------------------------------------------------------------------

const BASE = (process.env.BYPASS_API_URL || "https://backend-production-fcfb8.up.railway.app")
  .replace(/\/+$/, "");

const TIMEOUT = Number(process.env.BYPASS_API_TIMEOUT || 300000);

/* ------------------------------- platforms -------------------------------- */

const PLATFORMS = [
  {
    id: "platoboost",
    name: "Platoboost / PlatoRelay",
    example: "https://auth.platorelay.com/?d=TICKET",
    domains: ["auth.platorelay.com", "platorelay.com", "auth.platoboost.com", "gateway.platoboost.com", "platoboost.com"],
  },
  {
    id: "lootlabs",
    name: "LootLabs",
    example: "https://links.lootlabs.gg/XXXXX",
    domains: ["links.lootlabs.gg", "lootlabs.gg", "lootdest.com", "lootdest.org", "lootdest.info"],
  },
  {
    id: "lootlink",
    name: "loot.link",
    example: "https://loot.link/XXXXX",
    domains: ["loot.link", "loot-link.com", "loot-links.com", "lootlink.org"],
  },
  {
    id: "workink",
    name: "work.ink",
    example: "https://work.ink/XXXX/...",
    domains: ["work.ink", "workink.net"],
  },
  {
    id: "boostink",
    name: "boost.ink",
    example: "https://boost.ink/XXXXX",
    domains: ["boost.ink", "mboost.me", "bst.gg"],
  },
  {
    id: "linkvertise",
    name: "Linkvertise",
    example: "https://linkvertise.com/...",
    domains: ["linkvertise.com", "link-to.net", "link-target.net", "link-center.net", "link-hub.net", "direct-link.net"],
  },
  {
    id: "madium",
    name: "Madium",
    example: "https://getmadium.xyz/",
    domains: ["getmadium.xyz", "auth.getmadium.xyz", "madium.xyz"],
  },
];

/* --------------------------------- utils ---------------------------------- */

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainMatch(host, list) {
  return list.some((d) => host === d || host.endsWith("." + d));
}

function allDomains() {
  return [...new Set(PLATFORMS.flatMap((p) => p.domains))].sort();
}

function platformFor(url) {
  const host = hostOf(url);
  if (!host) return null;
  return PLATFORMS.find((p) => domainMatch(host, p.domains)) || null;
}

function isSupportedRemotely(url) {
  return !!platformFor(url);
}

/** Kept for compatibility with the UI: the single provider used by the bot. */
const PROVIDERS = [{ id: "private-backend", name: "Private Bypass API", base: BASE }];

function providersFor(url) {
  return isSupportedRemotely(url) ? PROVIDERS : [];
}

/* ------------------------------ http helper ------------------------------- */

async function request(path, { method = "GET", body, timeout = TIMEOUT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Turn a backend response into { success, result, platform, logs, tookMs }. */
function normalise(res) {
  const data = res.json;
  if (!data || typeof data !== "object") {
    return { success: false, result: res.text ? String(res.text).slice(0, 500) : `HTTP ${res.status}` };
  }
  if (data.success) {
    const value = data.key || data.url || data.result || "";
    return {
      success: !!value,
      result: value || "backend returned no key",
      platform: data.platform || null,
      logs: Array.isArray(data.logs) ? data.logs : [],
      tookMs: data.tookMs,
    };
  }
  return {
    success: false,
    result: data.error || data.message || `HTTP ${res.status}`,
    platform: data.platform || null,
    logs: Array.isArray(data.logs) ? data.logs : [],
    tookMs: data.tookMs,
  };
}

/* -------------------------------- bypass ---------------------------------- */

/**
 * Bypass a link through the private backend.
 * GET /api/bypass?url=... , with POST /api/bypass as a fallback.
 */
async function bypassWithApis(url, onStep = () => {}) {
  const platform = platformFor(url);
  if (!platform) {
    return { success: false, result: "this domain is not supported by the backend", provider: null };
  }

  onStep(`Platform: ${platform.name}`);
  onStep("Sending the link to the backend...");

  // Fire GET and POST at the same time; first success wins.
  const attempts = [
    request(`/api/bypass?url=${encodeURIComponent(url)}`, { method: "GET" }),
    request(`/api/bypass`, { method: "POST", body: { url } }),
  ];

  const errors = [];
  const settled = await new Promise((resolve) => {
    let pending = attempts.length;
    for (const p of attempts) {
      p.then(
        (res) => {
          let out;
          try {
            out = normalise(res);
          } catch (e) {
            out = { success: false, result: e.message };
          }
          if (out.success) return resolve(out);
          errors.push(out.result);
          if (--pending === 0) resolve(null);
        },
        (err) => {
          errors.push(err.name === "AbortError" ? "timeout" : err.message);
          if (--pending === 0) resolve(null);
        },
      );
    }
  });

  if (settled) {
    for (const line of (settled.logs || []).slice(-3)) onStep(String(line));
    return { ...settled, provider: "Private Bypass API" };
  }
  return { success: false, result: [...new Set(errors)].join("\n"), provider: null };
}

/** POST /api/madium/key — turn completed step tokens into a key. */
async function madiumKey(steps) {
  try {
    return normalise(await request("/api/madium/key", { method: "POST", body: { steps } }));
  } catch (err) {
    return { success: false, result: err.name === "AbortError" ? "timeout" : err.message };
  }
}

/* ------------------------------ health check ------------------------------ */

async function apiStatus() {
  try {
    const res = await request("/health", { method: "GET", timeout: 10000 });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  }
}

const HEALTH_CHECKS = [
  {
    id: "backend-health",
    name: "Private Backend (/health)",
    kind: "api",
    run: () => request("/health", { method: "GET", timeout: 15000 }),
  },
  {
    id: "backend-api",
    name: "Private Backend (/api)",
    kind: "api",
    run: () => request("/api", { method: "GET", timeout: 15000 }),
  },
  {
    id: "backend-detect",
    name: "Bypass engine (/api/detect)",
    kind: "api",
    run: () =>
      request(`/api/detect?url=${encodeURIComponent("https://auth.platorelay.com/?d=test")}`, {
        method: "GET",
        timeout: 15000,
      }),
  },
  {
    id: "backend-madium",
    name: "Madium (/api/madium/config)",
    kind: "api",
    run: () => request("/api/madium/config", { method: "GET", timeout: 20000 }),
  },
];

async function probeOne(check) {
  const started = Date.now();
  try {
    const res = await check.run();
    const ms = Date.now() - started;
    const ok = res.status > 0 && res.status < 400;
    const degraded = !ok && [400, 401, 402, 403, 422, 429].includes(res.status);
    return {
      id: check.id,
      name: check.name,
      kind: check.kind,
      ok,
      degraded,
      ms,
      detail: `HTTP ${res.status}${degraded ? " (limited)" : ""}`,
    };
  } catch (err) {
    return {
      id: check.id,
      name: check.name,
      kind: check.kind,
      ok: false,
      degraded: false,
      ms: Date.now() - started,
      detail: err.name === "AbortError" ? "timeout" : err.message || "network error",
    };
  }
}

async function testApis() {
  return Promise.all(HEALTH_CHECKS.map(probeOne));
}

module.exports = {
  BASE,
  PLATFORMS,
  PROVIDERS,
  HEALTH_CHECKS,
  allDomains,
  domainMatch,
  hostOf,
  platformFor,
  isSupportedRemotely,
  providersFor,
  bypassWithApis,
  madiumKey,
  apiStatus,
  testApis,
  probeOne,
};
