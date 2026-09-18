// -----------------------------------------------------------------------------
// LootLabs bypass (local engine) — ported from the LootLabs userscript.
// -----------------------------------------------------------------------------

const WebSocket = require("ws");

const UA =
  process.env.WORKINK_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const DOMAINS = [
  "lootlabs.gg",
  "links.lootlabs.gg",
  "lootdest.com",
  "lootdest.org",
  "lootdest.info",
  "lootboost.net",
  "loot-link.com",
  "loot-links.com",
  "lootlink.org",
  "loot.link",
];

const MAX_PINGS = 6;
const SOCKET_TIMEOUT_MS = 70000;

function supports(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

/** XOR payload decoder used by LootLabs (5-byte rolling key). */
function solvePayload(rawToken) {
  try {
    const raw = Buffer.from(
      String(rawToken || "")
        .replace(/[\u0000-\u001F\u007F]/g, "")
        .trim(),
      "base64",
    ).toString("binary");
    const key = raw.substring(0, 5);
    const data = raw.substring(5);
    let out = "";
    for (let i = 0; i < data.length; i++) {
      out += String.fromCharCode(data.charCodeAt(i) ^ key.charCodeAt(i % 5));
    }
    return /^https?:\/\//i.test(out) ? out : null;
  } catch {
    return null;
  }
}

function randomSession() {
  return String(
    Math.floor(Math.random() * 9 + 1) +
      Array(16)
        .fill(0)
        .map(() => Math.floor(Math.random() * 10))
        .join("") +
      Math.floor(Math.random() * 10),
  );
}

/** Pull the inline `p = {...}` config out of the landing page HTML. */
function extractConfig(html) {
  const pick = (key) => {
    const m =
      html.match(new RegExp(`${key}\\s*[:=]\\s*["']([^"']+)["']`)) ||
      html.match(new RegExp(`${key}\\s*[:=]\\s*(\\d+)`));
    return m ? m[1] : null;
  };
  const config = {
    TID: pick("TID"),
    KEY: pick("KEY"),
    CDN_DOMAIN: pick("CDN_DOMAIN"),
    TIER_ID: pick("TIER_ID") || "",
    OFFER: pick("OFFER") || "0",
  };
  return config.TID && config.KEY && config.CDN_DOMAIN ? config : null;
}

async function bypass(rawUrl, onStep = () => {}) {
  onStep("LootLabs: loading the landing page...");
  let html = "";
  try {
    const res = await fetch(rawUrl, {
      headers: { "user-agent": UA, accept: "text/html,*/*" },
      redirect: "follow",
    });
    html = await res.text();
  } catch (err) {
    return { success: false, result: `LootLabs page fetch failed: ${err.message}` };
  }

  const p = extractConfig(html);
  if (!p) return { success: false, result: "LootLabs: could not read the page config (TID/KEY)" };

  onStep("LootLabs: fetching CDN parameters...");
  let cdn;
  try {
    const text = await (await fetch(`https://${p.CDN_DOMAIN}/?tid=${p.TID}&params_only=1`)).text();
    cdn = JSON.parse("[" + text.slice(1, -2) + "]");
  } catch (err) {
    return { success: false, result: `LootLabs: CDN fetch failed (${err.message})` };
  }

  const incentiveServerDomain = cdn[9];
  const incentiveSyncerDomain = cdn[29];
  const sessionId = randomSession();
  const cookieId = String(Math.floor(Math.random() * 900000000) + 100000000);
  const puid = new URL(rawUrl).searchParams.get("puid") || "";

  const body = {
    tid: p.TID,
    bl: Array.from({ length: 53 }, (_, i) => i + 1).filter((n) => n !== 2 && n !== 17),
    session: sessionId,
    max_tasks: 1,
    design_id: 106,
    cur_url: rawUrl,
    doc_ref: "",
    tier_id: p.TIER_ID,
    num_of_tasks: 1,
    is_loot: true,
    rkey: p.KEY,
    cookie_id: cookieId,
    offer: p.OFFER,
    taboola_user_sync: "",
  };
  if (puid) body.puid = puid;

  onStep("LootLabs: requesting tasks...");
  let tasks;
  try {
    const res = await fetch(`https://${incentiveSyncerDomain}/tc`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA, origin: new URL(rawUrl).origin },
      body: JSON.stringify(body),
    });
    tasks = await res.json();
  } catch (err) {
    return { success: false, result: `LootLabs: task request failed (${err.message})` };
  }
  if (!Array.isArray(tasks) || !tasks.length) {
    return { success: false, result: "LootLabs: no tasks returned" };
  }

  const taskSessionId = tasks[0].session_id || sessionId;
  const urids = tasks.map((t) => t.urid);
  const taskIds = tasks.map((t) => t.task_id);
  const shard = parseInt(String(urids[0]).slice(-5), 10) % 3;
  const wsBase = `${shard}.${incentiveServerDomain}`;

  for (const [idx, task] of tasks.entries()) {
    fetch(`https://${wsBase}/st?uid=${task.urid}&cat=${task.task_id}`, { method: "POST" }).catch(() => {});
    fetch(`https://enaightdecipie.com?event=task_clicked&session_id=${taskSessionId}&info=${idx + 1}`).catch(
      () => {},
    );
    if (task.action_pixel_url) {
      fetch(`https://${String(task.action_pixel_url).replace(/^\/\//, "")}`).catch(() => {});
    }
    if (task.auto_complete_seconds != null) {
      setTimeout(
        () => fetch(`https://${wsBase}/p?uid=${task.urid}`, { method: "POST" }).catch(() => {}),
        task.auto_complete_seconds * 1000,
      );
    }
  }

  const wsUrl =
    `wss://${wsBase}/c?uid=${urids.join(",")}&cat=${taskIds.join(",")}&key=${p.KEY}` +
    `&session_id=${taskSessionId}&is_loot=1&tid=${p.TID}`;

  onStep("LootLabs: waiting for the completion token...");

  return await new Promise((resolve) => {
    let settled = false;
    let pings = 1;
    let pendingToken = null;
    const taskCount = tasks.length;
    const ws = new WebSocket(wsUrl, { headers: { origin: new URL(rawUrl).origin, "user-agent": UA } });

    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(pinger);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(out);
    };

    const watchdog = setTimeout(
      () => finish({ success: false, result: "LootLabs: websocket timeout" }),
      SOCKET_TIMEOUT_MS,
    );
    let pinger = null;

    ws.on("open", () => {
      setTimeout(() => {
        if (settled) return;
        try {
          ws.send("0");
        } catch {
          /* ignore */
        }
        pings = Math.min(MAX_PINGS, pings + 1);
        pinger = setInterval(() => {
          if (settled) return;
          try {
            ws.send("0");
          } catch {
            /* ignore */
          }
          pings = Math.min(MAX_PINGS, pings + 1);
        }, 10000);
      }, 10000);
    });

    ws.on("message", (data) => {
      const msg = typeof data === "string" ? data : data.toString("utf8");
      if (!msg) return;
      pings = Math.min(MAX_PINGS, pings + 1);
      if (msg.includes("r:")) {
        pendingToken = msg.replace("r:", "");
      }
      if (msg === "Refresh Page") {
        finish({ success: false, result: "LootLabs asked to refresh the page" });
        return;
      }
      if (pendingToken && pings >= taskCount) {
        const destination = solvePayload(pendingToken);
        if (destination) finish({ success: true, result: destination });
      }
    });

    ws.on("error", (err) => finish({ success: false, result: `LootLabs socket error: ${err.message}` }));
    ws.on("close", () => {
      const destination = pendingToken ? solvePayload(pendingToken) : null;
      if (destination) finish({ success: true, result: destination });
      else finish({ success: false, result: "LootLabs: socket closed without a token" });
    });
  });
}

module.exports = { id: "lootlabs", name: "LootLabs", DOMAINS, supports, bypass, solvePayload };
