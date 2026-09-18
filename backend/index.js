// Bypass router: local engines and the private backend run IN PARALLEL and the
// first success wins (with a short-lived result cache + in-flight dedupe).
const apis = require("../apis");
const local = require("../bypass");

// url -> { result, at }
const CACHE = new Map();
const CACHE_TTL = Number(process.env.BYPASS_CACHE_TTL || 10 * 60 * 1000);
// url -> Promise (dedupe simultaneous requests for the same link)
const INFLIGHT = new Map();

function cacheGet(url) {
  const hit = CACHE.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    CACHE.delete(url);
    return null;
  }
  return { ...hit.result, cached: true };
}

function cacheSet(url, result) {
  CACHE.set(url, { result, at: Date.now() });
  if (CACHE.size > 500) CACHE.delete(CACHE.keys().next().value);
}

/** Resolve with the first fulfilled value that passes `ok`, else null. */
function firstSuccess(tasks, ok) {
  return new Promise((resolve) => {
    let pending = tasks.length;
    const failures = [];
    if (!pending) return resolve({ winner: null, failures });
    for (const task of tasks) {
      Promise.resolve()
        .then(task)
        .then(
          (out) => {
            if (out && ok(out)) return resolve({ winner: out, failures });
            if (out) failures.push(out);
            if (--pending === 0) resolve({ winner: null, failures });
          },
          (err) => {
            failures.push({ success: false, result: err?.message || String(err) });
            if (--pending === 0) resolve({ winner: null, failures });
          },
        );
    }
  });
}

async function runBypass(service, url, onStep = () => {}) {
  if (!service) return { success: false, result: "unsupported service" };

  const cached = cacheGet(url);
  if (cached) {
    onStep("Cached result — instant.");
    return cached;
  }
  if (INFLIGHT.has(url)) {
    onStep("Same link is already being processed — waiting for it...");
    return INFLIGHT.get(url);
  }

  const job = (async () => {
    const tasks = [];
    if (local.engineFor(url)) tasks.push(() => local.runLocal(url, onStep));
    if (apis.isSupportedRemotely(url)) tasks.push(() => apis.bypassWithApis(url, onStep));
    if (!tasks.length) return { success: false, result: "unsupported service" };

    onStep(tasks.length > 1 ? "Running local engine + backend in parallel..." : "Working...");
    const { winner, failures } = await firstSuccess(tasks, (out) => out && out.success);
    if (winner) {
      cacheSet(url, winner);
      return winner;
    }
    return {
      success: false,
      result: [...new Set(failures.map((f) => f.result).filter(Boolean))].join("\n") || "bypass failed",
      provider: null,
    };
  })();

  INFLIGHT.set(url, job);
  try {
    return await job;
  } finally {
    INFLIGHT.delete(url);
  }
}

async function backendStatus() {
  return { apis: await apis.apiStatus() };
}

/** Full diagnostic used by `a!test-apis`. */
async function testAll() {
  const started = Date.now();
  const items = await apis.testApis();
  const total = items.length;
  const online = items.filter((x) => x.ok).length;
  const degraded = items.filter((x) => !x.ok && x.degraded).length;
  const offline = total - online - degraded;
  const weighted = online + degraded * 0.5;

  return {
    items,
    total,
    online,
    degraded,
    offline,
    score: total ? Math.round((weighted / total) * 100) : 0,
    seconds: ((Date.now() - started) / 1000).toFixed(2),
  };
}

module.exports = { runBypass, backendStatus, testAll, cacheGet, cacheSet };
