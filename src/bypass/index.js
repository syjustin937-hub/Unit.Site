// -----------------------------------------------------------------------------
// Local bypass engines.
// These run inside the bot itself (no external backend needed) and are tried
// BEFORE the private backend API. If a local engine fails, the caller falls
// back to the remote backend.
// -----------------------------------------------------------------------------

const workink = require("./workink");
const lootlabs = require("./lootlabs");
const linkvertise = require("./linkvertise");

const ENGINES = [workink, lootlabs, linkvertise];

function engineFor(url) {
  return ENGINES.find((e) => e.supports(url)) || null;
}

function localDomains() {
  return [...new Set(ENGINES.flatMap((e) => e.DOMAINS))].sort();
}

/** @returns {Promise<{success:boolean,result:string,provider?:string}|null>} */
async function runLocal(url, onStep = () => {}) {
  const engine = engineFor(url);
  if (!engine) return null;
  try {
    const out = await engine.bypass(url, onStep);
    return { ...out, provider: `Local engine — ${engine.name}` };
  } catch (err) {
    return { success: false, result: `${engine.name}: ${err.message}`, provider: `Local engine — ${engine.name}` };
  }
}

module.exports = { ENGINES, engineFor, localDomains, runLocal, workink, lootlabs, linkvertise };
