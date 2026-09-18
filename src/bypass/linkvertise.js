// -----------------------------------------------------------------------------
// Linkvertise bypass (local engine) — ported from the Python GraphQL bypasser.
// Requires a publisher access token in LINKVERTISE_TOKEN.
// -----------------------------------------------------------------------------

const GQL_URL = "https://publisher.linkvertise.com/graphql";
const TOKEN = () => process.env.LINKVERTISE_TOKEN || "";

const DOMAINS = [
  "linkvertise.com",
  "link-to.net",
  "link-target.net",
  "link-center.net",
  "link-hub.net",
  "direct-link.net",
];

const GET_CONTENT_QUERY = `
query getContent($identifier: PublicLinkIdentificationInput!) {
  getContent(input: $identifier) {
    __typename
    ... on DetailPageTargetData {
      url
      paste
    }
  }
}
`;

function supports(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

async function gql(operationName, variables, query) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      authorization: `Bearer ${TOKEN()}`,
      origin: "https://linkvertise.com",
      referer: "https://linkvertise.com/",
      "user-agent":
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
    },
    body: JSON.stringify({ operationName, variables, query }),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function bypass(rawUrl, onStep = () => {}) {
  if (!TOKEN()) {
    return { success: false, result: "Linkvertise: set LINKVERTISE_TOKEN in .env to use this engine" };
  }

  const path = new URL(rawUrl).pathname.replace("/access/", "/");
  const match = path.match(/\/(\d+)\/([\w-]+)/);
  if (!match) return { success: false, result: "Linkvertise: invalid link format" };

  const identifier = { userIdAndUrl: { user_id: Number(match[1]), url: match[2] } };
  onStep(`Linkvertise: id ${match[1]} | slug ${match[2]}`);

  for (let step = 0; step < 15; step++) {
    onStep(`Linkvertise: step ${step + 1}/15`);
    const res = await gql("getContent", { identifier, task_args: null }, GET_CONTENT_QUERY);
    if (!res || res.errors) {
      return {
        success: false,
        result: `Linkvertise: GraphQL error — ${JSON.stringify(res?.errors || "no response").slice(0, 300)}`,
      };
    }
    const data = res.data?.getContent;
    if (!data) return { success: false, result: "Linkvertise: no data returned" };
    if (data.__typename === "DetailPageTargetData") {
      const value = data.url || data.paste;
      if (value) return { success: true, result: value };
    }
  }
  return { success: false, result: "Linkvertise: ran out of steps without a target" };
}

module.exports = { id: "linkvertise", name: "Linkvertise", DOMAINS, supports, bypass };
