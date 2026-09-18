// -----------------------------------------------------------------------------
// work.ink bypass (local engine)
//
// Ported to Node from the "Banana Userscript - Work.ink" userscript.
// Flow:
//   1. GET the link page  -> f_user_id + slug
//   2. POST evade /init   -> monocle assessment (mcl), pinger, customer token
//   3. open wss://work.ink/_api/v2/ws
//   4. relay every socket frame through evade /negotiate, execute the returned
//      social / read-article / monetization / custom-offer messages
//   5. resolve when the relay answers with conditions === "destination"
// -----------------------------------------------------------------------------

const WebSocket = require("ws");

const EVADE_BASE = process.env.WORKINK_RELAY || "https://evade.bypass.tools";
const UA =
  process.env.WORKINK_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const DOMAINS = ["work.ink", "workink.net"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function supports(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

async function relay(path, body, timeout = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${EVADE_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PAGE_HEADERS = {
  "user-agent": UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "upgrade-insecure-requests": "1",
};

/**
 * Load the link page. Cloudflare challenges datacenter IPs, so an optional
 * proxy template can be set in .env:
 *   WORKINK_PAGE_PROXY=https://my-proxy.example/fetch?url={url}
 */
async function fetchLinkPage(url) {
  const attempts = [url];
  const template = process.env.WORKINK_PAGE_PROXY || "";
  if (template) attempts.push(template.replace("{url}", encodeURIComponent(url)));

  let last = { status: 0, html: "" };
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt, { headers: PAGE_HEADERS, redirect: "follow" });
      const html = await res.text();
      last = { status: res.status, html };
      if (/f_user_id/.test(html)) return last;
    } catch {
      /* try the next attempt */
    }
  }
  return last;
}


/**
 * @param {string} rawUrl work.ink link
 * @param {(msg:string)=>void} onStep progress callback
 */
async function bypass(rawUrl, onStep = () => {}) {
  const session = Math.random().toString(36).slice(2, 15);
  const target = new URL(rawUrl);
  const parts = target.pathname.split("/").filter(Boolean);
  const custom = parts[1] || parts[0] || "";
  const serverOverride = target.searchParams.get("sr") || "";

  onStep("work.ink: contacting the anti-bot relay...");
  const init = await relay("/api/evade/init", { mcl: "", session_id: session });
  if (!init || !init.mcl) {
    return { success: false, result: "work.ink relay is unreachable (evade /init failed)" };
  }

  onStep("work.ink: reading link parameters...");
  let userId = null;
  let pageError = null;
  try {
    const page = await fetchLinkPage(rawUrl);
    const m = page.html.match(/f_user_id\s*:\s*["']?(\d+)["']?/);
    if (m) userId = m[1];
    else if (page.status === 403) pageError = "work.ink returned a Cloudflare bot-check (403)";
    else pageError = `could not read f_user_id (HTTP ${page.status})`;
  } catch (err) {
    pageError = `page fetch failed: ${err.message}`;
  }
  if (!userId) {
    return {
      success: false,
      result:
        (pageError || "could not extract the work.ink user id") +
        "\nTip: run the bot from a residential IP — datacenter/VPS ranges are challenged by work.ink.",
    };
  }

  const wsUrl =
    `wss://work.ink/_api/v2/ws?userId=${encodeURIComponent(userId)}` +
    `&custom=${encodeURIComponent(custom)}&referrer=https://work.ink/&toLink=` +
    `&serverOverride=${encodeURIComponent(serverOverride)}` +
    `&customerSessionToken=${encodeURIComponent(init.tok || "")}` +
    `&monocleAssessment=${encodeURIComponent(init.mcl || "")}`;

  onStep("work.ink: connecting to the socket...");

  return await new Promise((resolve) => {
    let done = false;
    let started = Date.now();
    let execStarted = false;
    let socialDone = null;
    let monDone = null;
    let offersDone = null;
    let destResolve = null;

    const ws = new WebSocket(wsUrl, {
      headers: { origin: "https://work.ink", "user-agent": UA },
      handshakeTimeout: 20000,
    });

    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimeout);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };

    const hardTimeout = setTimeout(
      () => finish({ success: false, result: "work.ink bypass timed out" }),
      Number(process.env.WORKINK_TIMEOUT || 280000),
    );

    const send = (msg) => {
      try {
        if (ws.readyState === WebSocket.OPEN && typeof msg === "string") ws.send(msg);
      } catch {
        /* ignore */
      }
    };

    const waitFor = (setter, ms) =>
      new Promise((res) => {
        const t = setTimeout(() => {
          setter(null);
          res(null);
        }, ms);
        setter((value) => {
          clearTimeout(t);
          setter(null);
          res(value);
        });
      });

    async function execute(data) {
      const { fM, flM, sM, raM, mM, coM, pinger, envC } = data;
      if (envC) send(envC);
      if (pinger) send(pinger);

      if (Array.isArray(sM) && sM.length) {
        for (let i = 0; i < sM.length; i++) {
          if (done) return;
          onStep(`work.ink: social task ${i + 1}/${sM.length}`);
          send(sM[i].encrypted || sM[i]);
          if (flM) send(flM);
          await waitFor((fn) => (socialDone = fn), 10000);
          await sleep(10);
          if (fM) send(fM);
        }
      }

      if (Array.isArray(raM) && raM.length) {
        onStep("work.ink: read-article tasks...");
        for (const a of raM) send(a.encrypted || a);
        await waitFor((fn) => (offersDone = fn), 20000);
        if (done) return;
      }

      const offers = [
        ...(Array.isArray(mM) ? mM.map((x) => ({ ...x, _src: "monetization" })) : []),
        ...(Array.isArray(coM) ? coM.map((x) => ({ ...x, _src: "customOffer" })) : []),
      ].sort((a, b) => a.id - b.id);

      for (let i = 0; i < offers.length; i++) {
        if (done) return;
        const item = offers[i];
        const raw = item.encrypted || JSON.stringify(item);
        onStep(`work.ink: offer ${i + 1}/${offers.length}`);

        if (item._src === "customOffer") {
          send(item.initEncrypted);
          send(item.startEncrypted);
          if (flM) send(flM);
          await sleep(500);
          if (fM) send(fM);
          await waitFor((fn) => (monDone = fn), 65000);
          await sleep(50);
        } else if (item.id === 80) {
          send(raw);
          await waitFor((fn) => (monDone = fn), 140000);
        } else if ((item.id === 25 || item.id === 34) && item.event === "start") {
          send(raw);
          const clicked = offers.find((x) => x.id === item.id && x.event === "installClicked");
          if (clicked) send(clicked.encrypted || JSON.stringify(clicked));
          if (item.id === 25) {
            await fetch("https://work.ink/_api/v2/affiliate/operaGX", {
              method: "HEAD",
              headers: { "user-agent": "Opera Installer/1.0" },
            }).catch(() => {});
            await fetch("https://work.ink/_api/v2/callback/operaGX", {
              method: "POST",
              headers: { "content-type": "application/json", "user-agent": "Opera Installer/1.0" },
              body: JSON.stringify({ noteligible: true }),
            }).catch(() => {});
            await sleep(1200);
          }
          if (done) return;
          if (flM) send(flM);
          await waitFor((fn) => (monDone = fn), 300000);
          if (fM) send(fM);
        } else {
          send(raw);
          await sleep(500);
        }
      }

      if (done) return;
      onStep("work.ink: waiting for the destination...");
      const destPromise = waitFor((fn) => (destResolve = fn), 180000);
      if (fM) send(fM);
      const dest = await destPromise;
      if (dest) finish({ success: true, result: dest });
    }

    function handleRelay(resp) {
      if (!resp || done) return;
      if (resp.success === false && resp.error) {
        finish({ success: false, result: String(resp.error) });
        return;
      }
      if (resp.conditions === "destination" && resp.destinationURL) {
        if (destResolve) destResolve(resp.destinationURL);
        else finish({ success: true, result: resp.destinationURL });
        return;
      }
      if (resp.conditions === "prxd" && Date.now() - started < 9000) {
        finish({ success: false, result: "work.ink detected a VPN/proxy on this host" });
        return;
      }
      if (resp.conditions === "social_done" && socialDone) socialDone();
      if ((resp.conditions === "monetization_done" || resp.conditions === "monetization_ack") && monDone)
        monDone(resp);
      if (resp.conditions === "offers_state" && offersDone) offersDone(resp);
      if (resp.conditions === "ping" && resp.pingMsg) setTimeout(() => send(resp.pingMsg), 2000);
      if (resp.em) send(resp.em);

      const hasTasks =
        resp.sM?.length || resp.raM?.length || resp.mM?.length || resp.coM?.length ||
        Object.prototype.hasOwnProperty.call(resp, "sM");

      if (!execStarted && hasTasks) {
        execStarted = true;
        (async () => {
          // Turnstile / hCaptcha are solved by the relay when it can; the bot has
          // no browser, so we only forward whatever token the relay hands back.
          const neg = await relay("/api/evade/negotiate", { turnstile: null, tat: resp.tat || null });
          if (neg?.tst) send(neg.tst);
          if (resp.hcr) {
            const solves = Math.max(1, parseInt(resp.hcsn, 10) || 1);
            for (let i = 0; i < solves; i++) {
              const hc = await relay("/api/evade/negotiate", { hCapToken: null });
              const value = hc?.hcresp || hc?.tst;
              if (value) send(value);
            }
          }
          execute(resp).catch((err) =>
            finish({ success: false, result: `work.ink execute failed: ${err.message}` }),
          );
        })();
      }
    }

    ws.on("open", () => {
      started = Date.now();
      if (init.mcl) send(init.mcl);
      if (init.pinger) send(init.pinger);
      onStep("work.ink: connected, waiting for link info...");
    });

    ws.on("message", (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (!text) return;
      relay("/api/evade/negotiate", {
        demands: text,
        direction: "incoming",
        session_id: session,
        client_timestamp: Date.now(),
      })
        .then(handleRelay)
        .catch(() => {});
    });

    ws.on("error", (err) => {
      const msg = /403/.test(err.message)
        ? "work.ink refused the socket (403) — this IP is blocked by their bot check"
        : `socket error: ${err.message}`;
      finish({ success: false, result: msg });
    });

    ws.on("close", () => {
      if (!done) finish({ success: false, result: "work.ink closed the socket before finishing" });
    });
  });
}

module.exports = { id: "workink", name: "work.ink", DOMAINS, supports, bypass };
