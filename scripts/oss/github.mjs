// A small read-only GitHub client: REST GET with pagination, caching and
// retries, plus one GraphQL query. `fetchImpl` and `sleep` are injectable so
// the tests never touch the network or wait. Nothing here can write: the only
// non-GET request is a fixed read-only GraphQL query.

import fs from "node:fs";

const API = "https://api.github.com";
const MAX_ATTEMPTS = 4;
const MAX_WAIT_MS = 60_000;

// The agents' subprocesses run with secrets scrubbed from their environment,
// so the workflow can hand the (read-only, job-scoped) token over in a file.
function defaultToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const file = process.env.OSS_READ_TOKEN_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  return undefined;
}

// How long to wait before retrying a response, or null if it is not worth
// retrying. 429 and rate-limit 403s say when to come back; 5xx get a short
// exponential backoff.
export function retryDelay(res, attempt, now = Date.now()) {
  const retryAfter = Number(res.headers.get("retry-after"));
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  const rateLimited = res.status === 429 || (res.status === 403 && (remaining === "0" || retryAfter > 0));
  if (rateLimited) {
    if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_WAIT_MS);
    if (reset > 0) return Math.min(Math.max(reset * 1000 - now, 1000), MAX_WAIT_MS);
    return Math.min(2 ** attempt * 1000, MAX_WAIT_MS);
  }
  if (res.status >= 500) return Math.min(2 ** attempt * 500, MAX_WAIT_MS);
  return null;
}

export function createClient({
  token = defaultToken(),
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const cache = new Map();
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rishitank-open-source-sync",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  async function send(url, init) {
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetchImpl(url, init);
      const wait = attempt < MAX_ATTEMPTS ? retryDelay(res, attempt) : null;
      if (wait === null) return res;
      await sleep(wait);
    }
  }

  async function request(url, extraHeaders = {}) {
    const res = await send(url, { headers: { ...headers, ...extraHeaders } });
    if (res.status === 404) return { status: 404, body: null, link: null };
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GET ${url} -> ${res.status} ${text.slice(0, 200)}`);
    }
    const raw = extraHeaders.Accept === "application/vnd.github.raw+json";
    return { status: res.status, body: raw ? await res.text() : await res.json(), link: res.headers.get("link") };
  }

  // GET a path. Returns null on 404 so callers can report "not found" as a
  // failed claim rather than a crash. Any other error throws.
  async function get(path, { raw = false } = {}) {
    const key = `${raw ? "raw:" : ""}${path}`;
    if (cache.has(key)) return cache.get(key);
    const url = path.startsWith("http") ? path : `${API}${path}`;
    const { body } = await request(url, raw ? { Accept: "application/vnd.github.raw+json" } : {});
    cache.set(key, body);
    return body;
  }

  // GET every page of a list endpoint by following rel="next".
  async function getAll(path) {
    const key = `all:${path}`;
    if (cache.has(key)) return cache.get(key);
    const out = [];
    let url = `${API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    for (let page = 0; url && page < 50; page += 1) {
      const { status, body, link } = await request(url);
      if (status === 404) return null;
      if (Array.isArray(body)) out.push(...body);
      else if (Array.isArray(body?.items)) out.push(...body.items);
      const next = link?.split(",").find((p) => /rel="next"/.test(p));
      url = next ? next.slice(next.indexOf("<") + 1, next.indexOf(">")) : null;
    }
    cache.set(key, out);
    return out;
  }

  // The only GraphQL call: a discussion and its chosen answer. REST has no
  // discussions endpoint for public repositories. Returns null if the
  // discussion does not exist; throws on any other error (rate limits, auth)
  // so an outage is never mistaken for a false claim.
  async function discussionAnswer(repo, number) {
    const key = `discussion:${repo}#${number}`;
    if (cache.has(key)) return cache.get(key);
    const [owner, name] = repo.split("/");
    const query =
      "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){discussion(number:$number){url author{login} answer{body author{login}}}}}";
    const res = await send(`${API}/graphql`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { owner, name, number } }),
    });
    if (!res.ok) throw new Error(`GraphQL discussion ${repo}#${number} -> ${res.status}`);
    const json = await res.json();
    const errors = json.errors ?? [];
    if (errors.length && !errors.every((e) => e.type === "NOT_FOUND"))
      throw new Error(`GraphQL discussion ${repo}#${number}: ${errors.map((e) => e.type ?? e.message).join(", ")}`);
    const d = json.data?.repository?.discussion ?? null;
    cache.set(key, d);
    return d;
  }

  return { get, getAll, discussionAnswer };
}
