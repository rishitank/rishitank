// node --test tests/*.test.mjs
// Covers every rule in scripts/oss/*.mjs without touching the network: the
// GitHub client is replaced by fakes that answer from fixtures.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWatches, computeDiff, searchQuery, toLedgerItem } from "../scripts/oss/discover.mjs";
import { allowedPath, thread } from "../scripts/oss/gh-read.mjs";
import { createClient, retryDelay } from "../scripts/oss/github.mjs";
import {
  applySection,
  END_MARKER,
  findSecrets,
  GITHUB_URL_RE,
  parseInline,
  readJson,
  renderSection,
  START_MARKER,
  validateData,
  validateLedger,
} from "../scripts/oss/lib.mjs";
import { syncLedger } from "../scripts/oss/sync-ledger.mjs";
import { checkEvidence, checkLink, referencesIssue, verifyAll } from "../scripts/oss/verify-claims.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = readJson(path.join(root, "data/open-source.json"));
const ledger = readJson(path.join(root, "data/open-source-ledger.json"));

function entry(overrides = {}) {
  return {
    id: "demo",
    project: "Demo",
    url: "https://github.com/o/r/issues/1",
    status: "shipped",
    text: "asked for `x`, shipped ([#1](https://github.com/o/r/issues/1))",
    evidence: [
      { type: "issue", repo: "o/r", number: 1, author: "me" },
      { type: "comment", repo: "o/r", number: 1, author: "maint", contains: "released in 1.2.3" },
    ],
    ...overrides,
  };
}
const dataWith = (...entries) => ({ heading: "Heading:", entries });
const errorsFor = (...entries) => validateData(dataWith(...entries));
const hasError = (errs, want) => errs.some((e) => e.includes(want));

// ---------------------------------------------------------------- real data

test("the committed data file and ledger are valid and agree", () => {
  assert.deepEqual(validateData(data), []);
  assert.deepEqual(validateLedger(ledger, data), []);
  assert.deepEqual(findSecrets(JSON.stringify(data) + JSON.stringify(ledger)), []);
});

test("the committed README block matches the data file", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.equal(applySection(readme, renderSection(data)), readme);
});

// ---------------------------------------------------------------- inline grammar

test("parseInline splits text, code and links", () => {
  assert.deepEqual(parseInline("a `b` [c](https://github.com/o/r/pull/2) d"), [
    { type: "text", value: "a " },
    { type: "code", value: "b" },
    { type: "text", value: " " },
    { type: "link", label: "c", href: "https://github.com/o/r/pull/2" },
    { type: "text", value: " d" },
  ]);
});

test("parseInline rejects markup, off-site links and broken syntax outside code", () => {
  const bad = [
    "<b>x</b>",
    "a <b",
    "a > b",
    "**x**",
    "_x_",
    "~~x~~",
    "&lt;b&gt;",
    "ping @someone",
    "see https://evil.example",
    "see www.evil.example",
    "[x](https://evil.example/)",
    "[x](javascript:alert(1))",
    "[<img src=x>](https://github.com/o/r/issues/1)",
    "[a *b*](https://github.com/o/r/issues/1)",
    "[x](https://github.com/o/r/issues/1#frag)",
    "[x](https://github.com/a/b/../../x)",
    "[x](https://github.com/o/r/blob/main/x)",
    "`open",
    "``",
    "` `",
    "[x](https://github.com/o/r",
    "a ] b",
    "two\nlines",
    `rtl ${String.fromCodePoint(0x202e)} override`,
  ];
  for (const s of bad) assert.throws(() => parseInline(s), undefined, JSON.stringify(s));
});

test("parseInline allows anything but backticks inside code", () => {
  assert.deepEqual(parseInline("`&nbsp; <b> *x* @y`"), [{ type: "code", value: "&nbsp; <b> *x* @y" }]);
});

test("GITHUB_URL_RE allows exactly repo, issue, PR, discussion, release and commit URLs", () => {
  for (const ok of ["https://github.com/o/r", "https://github.com/o/r/issues/1", "https://github.com/o/r/pull/2", "https://github.com/o/r/discussions/3", "https://github.com/o/r/releases/tag/v1.0.0-beta.16", "https://github.com/o/r/commit/abc1234"])
    assert.ok(GITHUB_URL_RE.test(ok), ok);
  for (const no of ["http://github.com/o/r", "https://github.com/o", "https://github.com/o/r/", "https://github.com/o/r/issues/x", "https://github.com/o/r?x=1", "https://github.com.evil.com/o/r", "https://github.com/o/r/tree/main"])
    assert.ok(!GITHUB_URL_RE.test(no), no);
});

// ---------------------------------------------------------------- validateData

test("validateData accepts a minimal entry", () => {
  assert.deepEqual(errorsFor(entry()), []);
});

test("validateData validates the heading and project as plain text", () => {
  assert.ok(hasError(validateData({ heading: "<img src=x> [a](https://evil.example)", entries: [entry()] }), "heading"));
  assert.ok(hasError(validateData({ heading: "x".repeat(200), entries: [entry()] }), "heading"));
  assert.ok(hasError(errorsFor(entry({ project: "Demo\n\n## Pwned" })), "project"));
  assert.ok(hasError(errorsFor(entry({ project: "<b>x</b>" })), "project"));
});

test("validateData requires the card url to be one of the text links", () => {
  assert.ok(hasError(errorsFor(entry({ url: "https://github.com/o/r/issues/2" })), "url must also appear"));
});

test("validateData survives null and non-object entries", () => {
  assert.ok(hasError(validateData({ heading: "h", entries: [null] }), "must be an object"));
  assert.ok(hasError(validateData({ heading: "h", entries: ["x"] }), "must be an object"));
});

test("validateData rejects duplicates, bad status, long text and weak evidence", () => {
  const long = "x".repeat(500) + " [#1](https://github.com/o/r/issues/1)";
  const errs = errorsFor(
    entry(),
    entry({ status: "done", text: long, evidence: [{ type: "comment", repo: "o/r", number: 1, author: "a", contains: "ok" }] }),
  );
  for (const want of ["duplicate id", "duplicate url", "status must be", "keep it under", "6-160 characters"]) assert.ok(hasError(errs, want), want);
  assert.ok(hasError(errorsFor(entry({ evidence: [{ type: "comment", repo: "o/r", number: 1, author: "a", contains: "x".repeat(200) }] })), "6-160"));
});

test("validateData checks evidence fields per type", () => {
  const bad = [
    { type: "nope", repo: "o/r" },
    { type: "commit", repo: "o/r", sha: "abc", contains: "Fix #1 thing" },
    { type: "pr-fixes-issue", repo: "o/r", number: 2 },
    { type: "release", repo: "o/r", contains: "something" },
    { type: "pr", repo: "bad repo", number: 1, author: "a", merged: "yes" },
    { type: "pr", repo: "o/r", number: 1, author: "a", state: "merged" },
    { type: "file", repo: "o/r", path: "/etc/passwd", contains: "root:x:0" },
  ];
  const errs = errorsFor(entry({ evidence: bad }));
  for (const want of ["unknown evidence type", "full 40-character", "issue must be", "tag is required", "bad repo", "merged must be a boolean", "state must be open or closed", "path is required"])
    assert.ok(hasError(errs, want), want);
});

test("validateData checks that the status is backed by evidence", () => {
  const issueOnly = [{ type: "issue", repo: "o/r", number: 1, author: "me" }];
  assert.ok(hasError(errorsFor(entry({ status: "merged", evidence: issueOnly })), "status merged needs"));
  assert.ok(hasError(errorsFor(entry({ status: "shipped", evidence: issueOnly })), "status shipped needs"));
  assert.ok(hasError(errorsFor(entry({ status: "credited", evidence: issueOnly })), "status credited needs"));
  assert.ok(hasError(errorsFor(entry({ status: "in-review", evidence: issueOnly })), "status in-review needs"));
  assert.deepEqual(errorsFor(entry({ status: "in-review", evidence: [{ type: "pr", repo: "o/r", number: 1, author: "me", state: "open" }] })), []);
  assert.deepEqual(errorsFor(entry({ status: "merged", evidence: [{ type: "pr", repo: "o/r", number: 1, author: "me", merged: true }] })), []);
});

test("validateData limits watch items", () => {
  const w = (x) => errorsFor(entry({ watch: [x] }));
  assert.deepEqual(w({ type: "release-mentions", repo: "o/r", contains: "#1", note: "fine" }), []);
  assert.ok(hasError(w({ type: "release-mentions", repo: "o/r", contains: "#1", note: "x\ny" }), "note"));
  assert.ok(hasError(w({ type: "other", repo: "o/r", contains: "#1" }), "watch items"));
});

test("findSecrets spots credential-shaped strings", () => {
  for (const s of ["sk-ant-api03-abcdefghijklmnop", "ghs_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG0123456789_abcdef", "AKIAABCDEFGHIJKLMNOP", "-----BEGIN RSA PRIVATE KEY-----"])
    assert.ok(findSecrets(`x ${s} y`).length > 0, s);
  assert.deepEqual(findSecrets("Fixes #51, see ghost_writer and sk-ant docs"), []);
});

// ---------------------------------------------------------------- validateLedger

const item = (extra) => ({ kind: "issue", state: "closed", updatedAt: "2026-01-01T00:00:00Z", ...extra });

test("validateLedger catches drift between ledger and entries", () => {
  const d = dataWith(entry());
  const base = { user: "me", excludeOwners: [], items: {} };
  assert.ok(hasError(validateLedger(base, d), "missing from the ledger"));

  assert.ok(hasError(validateLedger({ ...base, items: { "o/r#1": item({ decision: "included", entry: "other" }) } }, d), '"other" does not exist'));
  assert.ok(hasError(validateLedger({ ...base, items: { "o/r#1": item({ decision: "excluded", reason: "not this one, sorry" }) } }, d), "ledger has o/r#1 as excluded"));

  const second = { ...entry(), id: "second", url: "https://github.com/o/r/issues/2", text: "x ([#2](https://github.com/o/r/issues/2))" };
  const d2 = dataWith(entry(), second);
  const swapped = { ...base, items: { "o/r#1": item({ decision: "included", entry: "second" }) } };
  assert.ok(hasError(validateLedger(swapped, d2), "ledger has o/r#1 as included under second"));

  const orphan = {
    ...base,
    items: {
      "o/r#1": item({ decision: "included", entry: "demo" }),
      "o/r#9": item({ decision: "included", entry: "demo" }),
      "o/r#10": item({ state: "open", updatedAt: "nope", decision: "excluded", reason: "x" }),
      "o/r#11": item({ kind: "commit", decision: "excluded", reason: "a perfectly fine reason" }),
      "o/r#12": item({ decision: "excluded", reason: "multi\nline reason here" }),
      "o/r#13": item({ decision: "maybe" }),
    },
  };
  const errs = validateLedger(orphan, d);
  for (const want of ["o/r#9: included under demo but", "o/r#10: updatedAt", "o/r#10: excluded items need", "o/r#11: kind", "o/r#12: excluded items need", "o/r#13: decision"])
    assert.ok(hasError(errs, want), want);
});

test("validateLedger requires pr-fixes-issue to fix an issue the user opened", () => {
  const e = entry({
    status: "merged",
    evidence: [
      { type: "issue", repo: "o/r", number: 1, author: "me" },
      { type: "pr-fixes-issue", repo: "o/r", number: 5, issue: 7 },
    ],
  });
  const l = { user: "me", excludeOwners: [], items: { "o/r#1": item({ decision: "included", entry: "demo" }) } };
  assert.ok(hasError(validateLedger(l, dataWith(e)), "fixes #7, but no issue evidence shows me opened #7"));
  e.evidence[1].issue = 1;
  assert.deepEqual(validateLedger(l, dataWith(e)), []);
});

// ---------------------------------------------------------------- rendering

test("renderSection and applySection replace only the marked block", () => {
  const readme = `top\n${START_MARKER}\nold\n${END_MARKER}\nbottom\n`;
  const out = applySection(readme, renderSection({ heading: "H:", entries: [entry()] }));
  assert.ok(out.startsWith("top\n") && out.endsWith("\nbottom\n"));
  assert.ok(out.includes("- **Demo**: asked for `x`, shipped ([#1](https://github.com/o/r/issues/1))"));
  assert.ok(!out.includes("old"));
});

test("applySection refuses missing or duplicated markers", () => {
  assert.throws(() => applySection("no markers", "x"), /missing/);
  assert.throws(() => applySection(`${START_MARKER}${END_MARKER}${START_MARKER}${END_MARKER}`, "x"), /more than one/);
  assert.throws(() => applySection(`${END_MARKER}${START_MARKER}`, "x"), /before/);
});

// ---------------------------------------------------------------- github client

function fakeResponse(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function scriptedFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return next;
    },
  };
}

test("client follows rel=next pagination and caches", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    fakeResponse(200, [1, 2], { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' }),
    fakeResponse(200, [3], { link: '<https://api.github.com/x?page=1>; rel="prev"' }),
  ]);
  const gh = createClient({ token: "t", fetchImpl, sleep: async () => {} });
  assert.deepEqual(await gh.getAll("/x"), [1, 2, 3]);
  assert.deepEqual(await gh.getAll("/x"), [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.github.com/x?page=2");
  assert.equal(calls[0].init.headers.Authorization, "Bearer t");
});

test("client returns null on 404 and throws on other errors", async () => {
  const gh = createClient({ token: "t", fetchImpl: scriptedFetch([fakeResponse(404, {}), fakeResponse(401, "bad creds")]).fetchImpl, sleep: async () => {} });
  assert.equal(await gh.get("/missing"), null);
  await assert.rejects(gh.get("/denied"), /401/);
});

test("client retries rate limits and 5xx, honouring retry-after", async () => {
  const waits = [];
  const { calls, fetchImpl } = scriptedFetch([
    fakeResponse(403, {}, { "x-ratelimit-remaining": "0", "retry-after": "2" }),
    fakeResponse(502, {}),
    fakeResponse(200, { ok: true }),
  ]);
  const gh = createClient({ token: "t", fetchImpl, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(await gh.get("/x"), { ok: true });
  assert.equal(calls.length, 3);
  assert.equal(waits[0], 2000);
});

test("client gives up after repeated 5xx and does not retry plain 403s", async () => {
  const gh = createClient({ token: "t", fetchImpl: scriptedFetch(Array.from({ length: 4 }, () => fakeResponse(500, "down"))).fetchImpl, sleep: async () => {} });
  await assert.rejects(gh.get("/x"), /500/);
  const { calls, fetchImpl } = scriptedFetch([fakeResponse(403, "forbidden", { "x-ratelimit-remaining": "42" })]);
  await assert.rejects(createClient({ token: "t", fetchImpl, sleep: async () => {} }).get("/y"), /403/);
  assert.equal(calls.length, 1);
});

test("retryDelay uses the rate-limit reset time when there is no retry-after", () => {
  const res = fakeResponse(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1010" });
  assert.equal(retryDelay(res, 1, 1_000_000), 10_000);
  assert.equal(retryDelay(fakeResponse(404, {}), 1), null);
});

test("discussionAnswer: NOT_FOUND is null, other GraphQL errors throw", async () => {
  const notFound = fakeResponse(200, { errors: [{ type: "NOT_FOUND" }], data: { repository: { discussion: null } } });
  const limited = fakeResponse(200, { errors: [{ type: "RATE_LIMITED" }] });
  const found = fakeResponse(200, { data: { repository: { discussion: { answer: { body: "b", author: { login: "m" } } } } } });
  const gh = createClient({ token: "t", fetchImpl: scriptedFetch([notFound, limited, found]).fetchImpl, sleep: async () => {} });
  assert.equal(await gh.discussionAnswer("o/r", 1), null);
  await assert.rejects(gh.discussionAnswer("o/r", 2), /RATE_LIMITED/);
  assert.equal((await gh.discussionAnswer("o/r", 3)).answer.author.login, "m");
});

test("client reads the token from OSS_READ_TOKEN_FILE when GITHUB_TOKEN is scrubbed", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "oss-")), "token");
  fs.writeFileSync(file, "file-token\n");
  const saved = { gt: process.env.GITHUB_TOKEN, f: process.env.OSS_READ_TOKEN_FILE };
  delete process.env.GITHUB_TOKEN;
  process.env.OSS_READ_TOKEN_FILE = file;
  try {
    const { calls, fetchImpl } = scriptedFetch([fakeResponse(200, {})]);
    await createClient({ fetchImpl }).get("/x");
    assert.equal(calls[0].init.headers.Authorization, "Bearer file-token");
  } finally {
    if (saved.gt === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.gt;
    if (saved.f === undefined) delete process.env.OSS_READ_TOKEN_FILE;
    else process.env.OSS_READ_TOKEN_FILE = saved.f;
  }
});

// ---------------------------------------------------------------- gh-read

test("allowedPath keeps the agents under /repos and /search", () => {
  for (const ok of ["/repos/o/r/issues/1", "/repos/o/r/issues/1/comments?per_page=100", "/search/issues?q=author:me"]) assert.ok(allowedPath(ok), ok);
  for (const no of ["/user", "/repos/../user", "/repos/%2e%2e/user", "/repos/%2E%2E/%2E%2E/user", "/repos/o/r/../../user", "https://evil.example/repos/x", "//evil.example/repos/x", "repos/o/r", "/repos/o/r\\x", "/orgs/o/members", undefined])
    assert.ok(!allowedPath(no), String(no));
});

test("thread() compacts an issue, its comments and its timeline", async () => {
  const gh = {
    get: async (p) =>
      ({
        "/repos/o/r/issues/1": { html_url: "u", title: "t", user: { login: "me" }, state: "closed", body: "b", closed_by: { login: "m" } },
      })[p] ?? null,
    getAll: async (p) =>
      p.endsWith("/comments")
        ? [{ user: { login: "m" }, created_at: "c", body: "released", html_url: "cu", reactions: { total_count: 9 } }]
        : [
            { event: "commented", actor: { login: "m" } },
            { event: "cross-referenced", actor: { login: "x" }, source: { issue: { html_url: "pu", title: "fix", state: "closed", pull_request: { merged_at: "m" }, user: { login: "x" } } } },
            { event: "closed", actor: { login: "m" }, commit_id: "abc" },
          ],
  };
  const t = await thread(gh, "o/r", 1);
  assert.equal(t.kind, "issue");
  assert.equal(t.closed_by, "m");
  assert.deepEqual(t.comments, [{ user: "m", created_at: "c", body: "released", url: "cu" }]);
  assert.equal(t.timeline.length, 2);
  assert.deepEqual(t.timeline[0].source, { url: "pu", title: "fix", state: "closed", is_pr: true, merged_at: "m", author: "x" });
  assert.equal(t.timeline[1].commit_id, "abc");
  assert.deepEqual(await thread({ get: async () => null, getAll: async () => [] }, "o/r", 2), { error: "not found" });
});

// ---------------------------------------------------------------- verify-claims

function fakeGitHub(fixtures) {
  return {
    async get(p) {
      return p in fixtures ? fixtures[p] : null;
    },
    async getAll(p) {
      return p in fixtures ? fixtures[p] : null;
    },
    async discussionAnswer(repo, n) {
      return fixtures[`discussion:${repo}#${n}`] ?? null;
    },
  };
}

test("referencesIssue matches closing keywords, not negations, templates or other numbers", () => {
  for (const ok of ["Fixes #51", "fixes: #51", "Resolves issue #51", "Closes o/r#51", "resolved https://github.com/o/r/issues/51", "This PR fixes #51.", "Notes: fixes #51"])
    assert.ok(referencesIssue(ok, "o/r", 51), ok);
  for (const no of ["See #51", "Fixes #510", "Fixes #5", "prefixes #51", "pre-fixes #51", "Does not fix #51", "won't fix #51", "<!-- Fixes #51 -->", "Fixes other/repo#51"])
    assert.ok(!referencesIssue(no, "o/r", 51), no);
});

test("checkEvidence passes true claims and explains false ones", async () => {
  const gh = fakeGitHub({
    "/repos/o/r/issues/1": { user: { login: "me" } },
    "/repos/o/r/issues/2": { user: { login: "me" }, pull_request: {} },
    "/repos/o/r/pulls/3": { user: { login: "me" }, merged_at: null, state: "open", title: "t", body: "built for Example Ltd" },
    "/repos/o/r/pulls/4": { user: { login: "them" }, merged_at: "2026-01-01", state: "closed", title: "feat", body: "Fixes #1" },
    "/repos/o/r/issues/1/comments": [{ user: { login: "maint" }, body: "Released in 1.2.3, thanks" }],
    ["/repos/o/r/commits/" + "a".repeat(40)]: { commit: { message: "fix #1 the thing" } },
    "/repos/o/r/releases/tags/v1": { body: "- thing (requested by @me)" },
    "/repos/o/r/contents/CHANGELOG.md": "## 2.0\n- closes #1",
    "discussion:o/r#5": { answer: { author: { login: "maint" }, body: "added in 2.0" } },
    "discussion:o/r#6": { answer: null },
  });
  const ok = [
    { type: "issue", repo: "o/r", number: 1, author: "me" },
    { type: "pr", repo: "o/r", number: 3, author: "me", merged: false, state: "open", contains: "built for Example Ltd" },
    { type: "pr-fixes-issue", repo: "o/r", number: 4, issue: 1 },
    { type: "comment", repo: "o/r", number: 1, author: "maint", contains: "Released in 1.2.3" },
    { type: "commit", repo: "o/r", sha: "a".repeat(40), contains: "fix #1" },
    { type: "release", repo: "o/r", tag: "v1", contains: "requested by @me" },
    { type: "file", repo: "o/r", path: "CHANGELOG.md", contains: "closes #1" },
    { type: "discussion-answer", repo: "o/r", number: 5, author: "maint", contains: "added in 2.0" },
  ];
  for (const ev of ok) assert.equal(await checkEvidence(gh, ev), null, JSON.stringify(ev));

  const bad = [
    [{ type: "issue", repo: "o/r", number: 2, author: "me" }, /is a pull request/],
    [{ type: "issue", repo: "o/r", number: 99, author: "me" }, /not found/],
    [{ type: "issue", repo: "o/r", number: 1, author: "you" }, /opened by me, not you/],
    [{ type: "pr", repo: "o/r", number: 3, author: "me", merged: true }, /claimed merged/],
    [{ type: "pr", repo: "o/r", number: 4, author: "them", merged: false }, /claimed unmerged/],
    [{ type: "pr", repo: "o/r", number: 3, author: "me", state: "closed" }, /claimed closed but is open/],
    [{ type: "pr", repo: "o/r", number: 3, author: "me", contains: "built for Acme" }, /does not contain/],
    [{ type: "pr", repo: "o/r", number: 4, author: "me" }, /opened by them/],
    [{ type: "pr-fixes-issue", repo: "o/r", number: 4, issue: 2 }, /does not say it fixes/],
    [{ type: "pr-fixes-issue", repo: "o/r", number: 3, issue: 1 }, /not merged/],
    [{ type: "comment", repo: "o/r", number: 1, author: "someone", contains: "Released in 1.2.3" }, /no comment by someone/],
    [{ type: "comment", repo: "o/r", number: 1, author: "maint", contains: "Released in 9.9.9" }, /no comment by maint/],
    [{ type: "comment", repo: "o/r", number: 8, author: "maint", contains: "Released" }, /thread not found/],
    [{ type: "commit", repo: "o/r", sha: "a".repeat(40), contains: "fix #2" }, /message does not contain/],
    [{ type: "commit", repo: "o/r", sha: "b".repeat(40), contains: "fix #1" }, /commit not found/],
    [{ type: "release", repo: "o/r", tag: "v1", contains: "requested by @you" }, /notes do not contain/],
    [{ type: "release", repo: "o/r", tag: "v2", contains: "requested by @me" }, /release not found/],
    [{ type: "file", repo: "o/r", path: "CHANGELOG.md", contains: "closes #2" }, /does not contain/],
    [{ type: "file", repo: "o/r", path: "NOPE.md", contains: "closes #1" }, /file not found/],
    [{ type: "discussion-answer", repo: "o/r", number: 5, author: "me", contains: "added in 2.0" }, /answer is by maint/],
    [{ type: "discussion-answer", repo: "o/r", number: 5, author: "maint", contains: "added in 3.0" }, /answer does not contain/],
    [{ type: "discussion-answer", repo: "o/r", number: 6, author: "maint", contains: "added in 2.0" }, /no chosen answer/],
    [{ type: "discussion-answer", repo: "o/r", number: 7, author: "maint", contains: "added in 2.0" }, /not found/],
  ];
  for (const [ev, re] of bad) assert.match((await checkEvidence(gh, ev)) ?? "(passed)", re, JSON.stringify(ev));
});

test("checkLink resolves every allowed link shape", async () => {
  const gh = fakeGitHub({
    "/repos/o/r/issues/1": { pull_request: {} },
    "/repos/o/r/issues/2": {},
    "/repos/o/r": {},
    "/repos/o/r/releases/tags/v1.2.3": {},
    "/repos/o/r/commits/abc1234": {},
    "discussion:o/r#9": { answer: null },
  });
  assert.equal(await checkLink(gh, "https://github.com/o/r/pull/1"), null);
  assert.match(await checkLink(gh, "https://github.com/o/r/issues/1"), /is a pull request/);
  assert.match(await checkLink(gh, "https://github.com/o/r/pull/2"), /is an issue/);
  assert.match(await checkLink(gh, "https://github.com/o/r/pull/3"), /not found/);
  assert.equal(await checkLink(gh, "https://github.com/o/r/discussions/9"), null);
  assert.match(await checkLink(gh, "https://github.com/o/r/discussions/8"), /discussion not found/);
  assert.equal(await checkLink(gh, "https://github.com/o/r"), null);
  assert.match(await checkLink(gh, "https://github.com/login/oauth"), /repository not found/);
  assert.equal(await checkLink(gh, "https://github.com/o/r/releases/tag/v1.2.3"), null);
  assert.match(await checkLink(gh, "https://github.com/o/r/releases/tag/v9"), /release not found/);
  assert.equal(await checkLink(gh, "https://github.com/o/r/commit/abc1234"), null);
  assert.match(await checkLink(gh, "https://github.com/o/r/blob/main/x"), /not a link shape/);
});

test("verifyAll reports one result per evidence item and link", async () => {
  const gh = fakeGitHub({ "/repos/o/r/issues/1": { user: { login: "me" } }, "/repos/o/r/issues/1/comments": [{ user: { login: "maint" }, body: "released in 1.2.3" }] });
  const results = await verifyAll(gh, { entries: [entry()] });
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.error === null));
});

// ---------------------------------------------------------------- discovery

test("searchQuery excludes the user's own accounts", () => {
  assert.equal(searchQuery({ user: "me", excludeOwners: ["me", "Org"] }, "pr"), "author:me is:pr -user:me -user:Org");
});

test("toLedgerItem normalises search results, including merged PRs", () => {
  const pr = toLedgerItem({ repository_url: "https://api.github.com/repos/o/r", number: 7, state: "closed", pull_request: { merged_at: "x" }, updated_at: "u", title: "t", html_url: "h" });
  assert.deepEqual(pr, { key: "o/r#7", kind: "pr", state: "merged", updatedAt: "u", title: "t", url: "h" });
  const closedPr = toLedgerItem({ repository_url: "https://api.github.com/repos/o/r", number: 9, state: "closed", pull_request: { merged_at: null }, updated_at: "u" });
  assert.equal(closedPr.state, "closed");
  assert.equal(toLedgerItem({ repository_url: "https://api.github.com/repos/o/r", number: 8, state: "open", updated_at: "u" }).kind, "issue");
});

test("computeDiff finds new, changed and missing items", () => {
  const l = {
    items: {
      "o/r#1": { state: "open", updatedAt: "a", decision: "excluded", reason: "no reply yet" },
      "o/r#2": { state: "closed", updatedAt: "b", decision: "included", entry: "x" },
      "o/r#3": { state: "closed", updatedAt: "c", decision: "excluded", reason: "gone" },
      "o/r#5": { state: "open", updatedAt: "e", decision: "excluded", reason: "no reply yet" },
      "o/r#6": { state: "open", updatedAt: "f", decision: "excluded", reason: "no reply yet" },
    },
  };
  const d = computeDiff(l, [
    { key: "o/r#1", state: "closed", updatedAt: "a2" },
    { key: "o/r#2", state: "closed", updatedAt: "b" },
    { key: "o/r#4", state: "open", updatedAt: "d" },
    { key: "o/r#5", state: "open", updatedAt: "e2" },
    { key: "o/r#6", state: "closed", updatedAt: "f" },
  ]);
  assert.deepEqual(d.new.map((x) => x.key), ["o/r#4"]);
  assert.deepEqual(d.changed.map((x) => [x.key, x.previous.state, x.decision]), [
    ["o/r#1", "open", "excluded"],
    ["o/r#5", "open", "excluded"],
    ["o/r#6", "open", "excluded"],
  ]);
  assert.deepEqual(d.missing, ["o/r#3"]);
});

test("checkWatches reports a published release that mentions the watched string", async () => {
  const gh = fakeGitHub({
    "/repos/o/r/releases?per_page=20": [
      { draft: true, body: "fix (#2869)", tag_name: "v9-draft", html_url: "d", published_at: null },
      { draft: false, body: "other (#28690)", tag_name: "v3.0.9", html_url: "x", published_at: "p0" },
      { draft: false, body: "fix (#2869)", tag_name: "v3.1.0", html_url: "u", published_at: "p" },
    ],
  });
  const watch = (contains) => checkWatches(gh, { entries: [entry({ watch: [{ type: "release-mentions", repo: "o/r", contains }] })] });
  assert.equal((await watch("#2869"))[0].release.tag, "v3.1.0");
  assert.equal((await watch("#9999")).length, 0);
});

// ---------------------------------------------------------------- sync-ledger

test("syncLedger copies observed facts, insists on a decision and sorts keys", () => {
  const l = {
    items: {
      "z/z#1": { kind: "issue", state: "open", updatedAt: "a", decision: "excluded", reason: "waiting on maintainer" },
      "o/r#1": { kind: "issue", state: "open", updatedAt: "a", decision: "excluded", reason: "waiting on maintainer" },
      "o/r#2": { decision: "included", entry: "x" },
    },
  };
  const disc = {
    new: [{ key: "o/r#2", kind: "pr", state: "merged", updatedAt: "z" }, { key: "o/r#3", kind: "issue", state: "open", updatedAt: "y" }],
    changed: [{ key: "o/r#1", kind: "issue", state: "closed", updatedAt: "b" }],
  };
  assert.deepEqual(syncLedger(l, disc), ["o/r#3: no decision recorded"]);
  assert.deepEqual(l.items["o/r#1"], { kind: "issue", state: "closed", updatedAt: "b", decision: "excluded", reason: "waiting on maintainer" });
  assert.equal(l.items["o/r#2"].state, "merged");
  assert.deepEqual(Object.keys(l.items), ["o/r#1", "o/r#2", "z/z#1"]);
});

test("the committed ledger keys are sorted", () => {
  const keys = Object.keys(ledger.items);
  assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b, "en")));
});
