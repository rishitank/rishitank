// Shared logic for the open-source list: loading, validation, inline-markup
// parsing and README rendering. Pure functions only (no network), so every
// rule here is covered by tests/oss.test.mjs.
//
// Data flow
//   data/open-source.json         the list itself (edited by hand or by the
//                                 weekly discovery job, never generated)
//   data/open-source-ledger.json  every issue/PR the user authored upstream,
//                                 and whether it was included or why not
//   README.md                     the block between the markers is rendered
//                                 from data/open-source.json
//   rishitank.co.uk/about         the portfolio fetches data/open-source.json
//                                 from raw.githubusercontent.com at runtime

import fs from "node:fs";

export const START_MARKER = "<!-- open-source:start -->";
export const END_MARKER = "<!-- open-source:end -->";

export const STATUSES = new Set(["merged", "shipped", "credited", "in-review"]);
export const EVIDENCE_TYPES = new Set([
  "issue",
  "pr",
  "pr-fixes-issue",
  "comment",
  "commit",
  "release",
  "file",
  "discussion-answer",
]);

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Only these GitHub URL shapes may appear: a repository, an issue, a pull
// request, a discussion, a release tag or a commit. No query strings, no
// fragments, no "..": every link points at something verify-claims can check.
const OWNER_REPO = "[A-Za-z0-9_-][A-Za-z0-9_.-]*\\/[A-Za-z0-9_-][A-Za-z0-9_.-]*";
export const GITHUB_URL_RE = new RegExp(
  `^https:\\/\\/github\\.com\\/${OWNER_REPO}(?:\\/(?:issues|pull|discussions)\\/\\d+|\\/releases\\/tag\\/[A-Za-z0-9_.+-]+|\\/commit\\/[0-9a-f]{7,40})?$`,
);
const MAX_TEXT = 420;
const MAX_PLAIN = 120;
// The portfolio refuses a file with more entries than this, so the producer
// must too, or a merged file could never reach the site.
export const MAX_ENTRIES = 50;
// Outside `code`, these would be markup in GitHub Markdown (HTML, emphasis,
// strikethrough, entities, bare autolinks, @mentions, "!" turning a link into
// an image, a backslash escaping the next character) or break a list item.
// The portfolio shows them literally, so allowing them would make the two
// surfaces render the same text differently.
const FORBIDDEN_PLAIN = /[<>*_~&@!\\\]\n\r\t]|https?:\/\/|www\./i;
// Bidirectional-override and isolate controls (U+202A-202E, U+2066-2069)
// can make text display differently from what it says. Checked by code point
// so the source itself never contains them.
const isBidiControl = (cp) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

// The entry text allows exactly two kinds of markup, so that the README
// (Markdown) and the portfolio (React) render it identically and nothing in
// it can inject HTML, images, mentions or off-site links:
//   `code`            -> inline code (any characters but a backtick or newline)
//   [label](url)      -> a link; the label is plain text and the url must be
//                        one of the GitHub shapes in GITHUB_URL_RE
// Everything else is plain text, and plain text may not contain anything
// GitHub would treat as markup (see FORBIDDEN_PLAIN). Returns tokens, or
// throws with the reason. The portfolio has a TypeScript copy of this grammar
// in src/lib/open-source.ts; keep the two in step.
function checkBidi(text, what) {
  for (const ch of text) {
    if (isBidiControl(ch.codePointAt(0))) throw new Error(`${what} contains a bidirectional control character`);
  }
}

export function checkPlain(text, what = "text") {
  const m = FORBIDDEN_PLAIN.exec(text);
  if (m) throw new Error(`${what} contains ${JSON.stringify(m[0])}, which is not allowed outside \`code\``);
  checkBidi(text, what);
}

export function parseInline(text) {
  const tokens = [];
  let i = 0;
  let buf = "";
  const flush = () => {
    if (buf) {
      checkPlain(buf);
      tokens.push({ type: "text", value: buf });
    }
    buf = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) throw new Error(`unclosed backtick at ${i}`);
      const value = text.slice(i + 1, end);
      if (!value.trim() || /[\n\r]/.test(value)) throw new Error(`empty or multi-line code span at ${i}`);
      // Code may hold markup characters, but never text that displays in a
      // different order from how it reads.
      checkBidi(value, "code span");
      flush();
      tokens.push({ type: "code", value });
      i = end + 1;
    } else if (ch === "[") {
      const close = text.indexOf("](", i);
      const end = close === -1 ? -1 : text.indexOf(")", close + 2);
      if (close === -1 || end === -1) throw new Error(`malformed link at ${i}`);
      const label = text.slice(i + 1, close);
      const href = text.slice(close + 2, end);
      // Brackets, backticks and parentheses in a label would make the Markdown
      // link ambiguous to read, so labels are kept to plain words and numbers.
      // (The portfolio's copy may accept more; it only ever sees files that
      // passed this check.)
      if (!label.trim() || /[[\]`()]/.test(label)) throw new Error(`bad link label at ${i}`);
      checkPlain(label, "link label");
      if (!GITHUB_URL_RE.test(href)) throw new Error(`link must be a GitHub repo, issue, PR, discussion, release or commit URL: ${href}`);
      flush();
      tokens.push({ type: "link", label, href });
      i = end + 1;
    } else {
      buf += ch;
      i += 1;
    }
  }
  flush();
  return tokens;
}

function fail(errors, where, msg) {
  errors.push(`${where}: ${msg}`);
}

function validateEvidence(ev, where, errors) {
  if (!ev || typeof ev !== "object") return fail(errors, where, "evidence must be an object");
  if (!EVIDENCE_TYPES.has(ev.type)) return fail(errors, where, `unknown evidence type ${JSON.stringify(ev.type)}`);
  if (!REPO_RE.test(ev.repo ?? "")) fail(errors, where, `bad repo ${JSON.stringify(ev.repo)}`);
  const needNumber = ["issue", "pr", "pr-fixes-issue", "comment", "discussion-answer"];
  if (needNumber.includes(ev.type) && !(Number.isInteger(ev.number) && ev.number > 0)) fail(errors, where, "number must be a positive integer");
  const needAuthor = ["issue", "pr", "comment", "discussion-answer"];
  if (needAuthor.includes(ev.type) && !(typeof ev.author === "string" && ev.author)) fail(errors, where, "author is required");
  const needContains = ["comment", "commit", "release", "file", "discussion-answer"];
  const quoteOk = typeof ev.contains === "string" && ev.contains.length >= 6 && ev.contains.length <= 160;
  if (needContains.includes(ev.type) && !quoteOk) fail(errors, where, "contains must be an exact quote of 6-160 characters");
  // Optional on an issue or a PR: a quote from its title or description.
  if ((ev.type === "issue" || ev.type === "pr") && "contains" in ev && !quoteOk) fail(errors, where, "contains must be an exact quote of 6-160 characters");
  // Optional on a PR: the branch it was merged into.
  if (ev.type === "pr" && "base" in ev && !(typeof ev.base === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(ev.base))) fail(errors, where, "base must be a branch name");
  // Optional on a discussion answer: who opened the discussion.
  if (ev.type === "discussion-answer" && "opener" in ev && !(typeof ev.opener === "string" && ev.opener)) fail(errors, where, "opener must be a GitHub login");
  if (ev.type === "pr-fixes-issue" && !(Number.isInteger(ev.issue) && ev.issue > 0)) fail(errors, where, "issue must be a positive integer");
  if (ev.type === "commit" && !/^[0-9a-f]{40}$/.test(ev.sha ?? "")) fail(errors, where, "sha must be a full 40-character commit SHA");
  if (ev.type === "release" && !(typeof ev.tag === "string" && ev.tag)) fail(errors, where, "tag is required");
  if (ev.type === "file" && !(typeof ev.path === "string" && ev.path && !ev.path.startsWith("/"))) fail(errors, where, "path is required");
  if (ev.type === "pr" && "merged" in ev && typeof ev.merged !== "boolean") fail(errors, where, "merged must be a boolean");
  if (ev.type === "pr" && "state" in ev && !["open", "closed"].includes(ev.state)) fail(errors, where, "state must be open or closed");
}

export function validateData(data) {
  const errors = [];
  if (!data || typeof data !== "object") return ["root: not an object"];
  if (typeof data.heading !== "string" || !data.heading.trim() || data.heading.length > MAX_PLAIN) fail(errors, "heading", `must be plain text of 1-${MAX_PLAIN} characters`);
  else if (/[[\]`]/.test(data.heading)) fail(errors, "heading", "must not contain [, ] or a backtick");
  else {
    try {
      checkPlain(data.heading, "heading");
    } catch (err) {
      fail(errors, "heading", err.message);
    }
  }
  if (!Array.isArray(data.entries) || data.entries.length === 0) return [...errors, "entries: must be a non-empty array"];
  if (data.entries.length > MAX_ENTRIES) fail(errors, "entries", `at most ${MAX_ENTRIES} entries; the portfolio refuses more`);
  const ids = new Set();
  const urls = new Set();
  data.entries.forEach((e, idx) => {
    const where = `entries[${idx}]${e?.id ? ` (${e.id})` : ""}`;
    if (!e || typeof e !== "object" || Array.isArray(e)) return fail(errors, where, "must be an object");
    if (!ID_RE.test(e?.id ?? "")) fail(errors, where, "id must be kebab-case");
    if (ids.has(e.id)) fail(errors, where, "duplicate id");
    ids.add(e.id);
    if (typeof e.project !== "string" || !e.project.trim() || e.project.length > 60 || /[[\]`]/.test(e.project)) fail(errors, where, "project must be plain text of 1-60 characters");
    else {
      try {
        checkPlain(e.project, "project");
      } catch (err) {
        fail(errors, where, err.message);
      }
    }
    if (!GITHUB_URL_RE.test(e.url ?? "")) fail(errors, where, "url must be a github.com URL");
    if (urls.has(e.url)) fail(errors, where, "duplicate url");
    urls.add(e.url);
    if (!STATUSES.has(e.status)) fail(errors, where, `status must be one of ${[...STATUSES].join(", ")}`);
    if (typeof e.text !== "string" || !e.text.trim()) {
      fail(errors, where, "text is required");
    } else {
      if (e.text.length > MAX_TEXT) fail(errors, where, `text is ${e.text.length} characters; keep it under ${MAX_TEXT}`);
      try {
        const links = parseInline(e.text).filter((t) => t.type === "link").map((t) => t.href);
        if (!links.includes(e.url)) fail(errors, where, "url must also appear as a link in text");
      } catch (err) {
        fail(errors, where, `text: ${err.message}`);
      }
    }
    if (!Array.isArray(e.evidence) || e.evidence.length === 0) fail(errors, where, "evidence must be a non-empty array");
    else {
      e.evidence.forEach((ev, j) => validateEvidence(ev, `${where}.evidence[${j}]`, errors));
      // The status must be backed by evidence of the matching kind. That the
      // evidence involves the user is checked in validateLedger, which knows
      // who the user is.
      const types = new Set(e.evidence.map((ev) => ev?.type));
      const mergedPr = e.evidence.some((ev) => ev?.type === "pr" && ev.merged === true);
      if (e.status === "merged" && !mergedPr) fail(errors, where, "status merged needs a merged pr evidence");
      if (e.status === "shipped" && !["comment", "release", "commit", "file", "discussion-answer", "pr-fixes-issue"].some((t) => types.has(t)))
        fail(errors, where, "status shipped needs a comment, release, commit, file, discussion-answer or pr-fixes-issue evidence");
      if (e.status === "credited" && !types.has("comment")) fail(errors, where, "status credited needs a comment evidence");
      if (e.status === "in-review" && !e.evidence.some((ev) => ev?.type === "pr" && ev.state === "open")) fail(errors, where, "status in-review needs an open pr evidence");
    }
    if ("watch" in e) {
      if (!Array.isArray(e.watch)) fail(errors, where, "watch must be an array");
      else
        e.watch.forEach((w, j) => {
          if (w?.type !== "release-mentions" || !REPO_RE.test(w.repo ?? "") || typeof w.contains !== "string" || !w.contains || w.contains.length > 60)
            fail(errors, `${where}.watch[${j}]`, "watch items are {type: release-mentions, repo, contains (up to 60 characters), note?}");
          if ("note" in (w ?? {}) && !(typeof w.note === "string" && w.note.length <= 160 && !/[<>\n]/.test(w.note)))
            fail(errors, `${where}.watch[${j}]`, "note must be one line of plain text, up to 160 characters");
        });
    }
  });
  return errors;
}

export const ledgerKey = (repo, number) => `${repo}#${number}`;

// Anything that looks like a credential. The data files are public and are
// edited by an agent that reads text written by strangers, so a leaked token
// must fail validation rather than be published.
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function findSecrets(text) {
  return SECRET_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

export function validateLedger(ledger, data) {
  const errors = [];
  if (typeof ledger?.user !== "string" || !ledger.user) return ["ledger.user is required"];
  if (!Array.isArray(ledger.excludeOwners)) errors.push("ledger.excludeOwners must be an array");
  const items = ledger.items ?? {};
  const entries = (data.entries ?? []).filter((e) => e && typeof e === "object" && !Array.isArray(e));
  const entryIds = new Set(entries.map((e) => e.id));
  for (const [key, item] of Object.entries(items)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`ledger ${key}: must be an object`);
      continue;
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/.test(key)) errors.push(`ledger ${key}: key must be owner/repo#number`);
    if (!["issue", "pr"].includes(item.kind)) errors.push(`ledger ${key}: kind must be issue or pr`);
    if (!["open", "closed", "merged"].includes(item.state)) errors.push(`ledger ${key}: state must be open, closed or merged`);
    if (Number.isNaN(Date.parse(item.updatedAt))) errors.push(`ledger ${key}: updatedAt must be an ISO date`);
    if (item.decision === "included") {
      if (!entryIds.has(item.entry)) errors.push(`ledger ${key}: entry ${JSON.stringify(item.entry)} does not exist`);
    } else if (item.decision === "excluded") {
      if (typeof item.reason !== "string" || item.reason.length < 10 || item.reason.length > 240 || /[<>\n]/.test(item.reason))
        errors.push(`ledger ${key}: excluded items need a one-line reason of 10-240 characters`);
    } else errors.push(`ledger ${key}: decision must be included or excluded`);
  }
  // Every entry must be about something the user did, and its status must
  // rest on the user's own part in it. Without this, a well-formed entry
  // about someone else's repository (whose claims verify-claims would
  // happily confirm) could pass every check that does not involve an AI.
  const u = ledger.user;
  const isObj = (ev) => ev && typeof ev === "object";
  const userPr = (ev, test) => isObj(ev) && ev.type === "pr" && ev.author === u && test(ev);
  const userRequest = (ev) => isObj(ev) && ((ev.type === "issue" && ev.author === u) || (ev.type === "discussion-answer" && ev.opener === u));
  const userWrote = (ev) => userRequest(ev) || (isObj(ev) && (ev.type === "pr" || ev.type === "comment") && ev.author === u);
  const resolution = (ev) =>
    isObj(ev) &&
    (["pr-fixes-issue", "commit", "release", "file", "discussion-answer"].includes(ev.type) ||
      (ev.type === "comment" && ev.author !== u) ||
      (ev.type === "pr" && ev.author !== u && ev.merged === true));
  for (const e of entries) {
    const evs = Array.isArray(e.evidence) ? e.evidence : [];
    const where = `entry ${e.id}`;
    if (!evs.some(userWrote)) errors.push(`${where}: no evidence shows ${u} opened, wrote or commented on anything`);
    if (e.status === "merged" && !evs.some((ev) => userPr(ev, (x) => x.merged === true))) errors.push(`${where}: merged needs a merged pr opened by ${u}`);
    if (e.status === "in-review" && !evs.some((ev) => userPr(ev, (x) => x.state === "open"))) errors.push(`${where}: in-review needs an open pr opened by ${u}`);
    if (e.status === "credited" && !(evs.some((ev) => isObj(ev) && ev.type === "comment" && ev.author === u) && evs.some((ev) => isObj(ev) && ev.type === "comment" && ev.author !== u)))
      errors.push(`${where}: credited needs a comment by ${u} and a comment by someone else`);
    if (e.status === "shipped" && !(evs.some(userRequest) && evs.some(resolution)))
      errors.push(`${where}: shipped needs an issue (or discussion) opened by ${u} and evidence that it was resolved`);
  }
  // Every issue or PR the user authored that an entry relies on must be in
  // the ledger as included under that entry, so the two files cannot drift.
  for (const e of entries) {
    for (const ev of (e.evidence ?? []).filter(isObj)) {
      const authoredByUser = (ev.type === "issue" || ev.type === "pr") && ev.author === ledger.user;
      if (!authoredByUser) continue;
      const item = items[ledgerKey(ev.repo, ev.number)];
      if (!item) errors.push(`entry ${e.id}: ${ledgerKey(ev.repo, ev.number)} is missing from the ledger`);
      else if (item.decision !== "included" || item.entry !== e.id)
        errors.push(`entry ${e.id}: ledger has ${ledgerKey(ev.repo, ev.number)} as ${item.decision}${item.entry ? ` under ${item.entry}` : ""}`);
    }
  }
  // A "this PR fixes that issue" claim only credits the user if the issue is
  // theirs, so the same entry must also prove they opened it.
  for (const e of entries) {
    for (const ev of (e.evidence ?? []).filter(isObj)) {
      if (ev.type !== "pr-fixes-issue") continue;
      const own = (e.evidence ?? []).some((x) => isObj(x) && x.type === "issue" && x.repo === ev.repo && x.number === ev.issue && x.author === ledger.user);
      if (!own) errors.push(`entry ${e.id}: ${ev.repo}#${ev.number} fixes #${ev.issue}, but no issue evidence shows ${ledger.user} opened #${ev.issue}`);
    }
  }
  // And every included ledger item must be cited by its entry's evidence.
  for (const [key, item] of Object.entries(items)) {
    if (item?.decision !== "included") continue;
    const entry = entries.find((e) => e.id === item.entry);
    const cited = entry?.evidence?.some((ev) => isObj(ev) && (ev.type === "issue" || ev.type === "pr") && ledgerKey(ev.repo, ev.number) === key);
    if (entry && !cited) errors.push(`ledger ${key}: included under ${item.entry} but that entry has no issue/pr evidence for it`);
  }
  return errors;
}

// What an automated update may not change in the ledger: whose contributions
// these are, which accounts count as the user's own, and the record of any
// item already decided (it can be re-decided, never dropped). The weekly
// publish step checks the curator's ledger against main's with this.
export function checkLedgerInvariants(base, head) {
  const errors = [];
  for (const field of ["$comment", "user", "excludeOwners"]) {
    if (JSON.stringify(base?.[field]) !== JSON.stringify(head?.[field])) errors.push(`ledger.${field} must not change in an automated update`);
  }
  const headItems = head?.items ?? {};
  for (const key of Object.keys(base?.items ?? {})) {
    if (!(key in headItems)) errors.push(`ledger ${key}: removed; items may be re-decided but not deleted`);
  }
  return errors;
}

export function renderSection(data) {
  const lines = [START_MARKER, "<!-- Generated from data/open-source.json by scripts/oss/render-readme.mjs. Edit the JSON, not this block. -->", ""];
  lines.push(data.heading, "");
  for (const e of data.entries) lines.push(`- **${e.project}**: ${e.text}`);
  lines.push("", END_MARKER);
  return lines.join("\n");
}

export function applySection(readme, section) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1) throw new Error("README is missing the open-source markers");
  if (readme.indexOf(START_MARKER, start + 1) !== -1 || readme.indexOf(END_MARKER, end + 1) !== -1)
    throw new Error("README has more than one pair of open-source markers");
  if (end < start) throw new Error("open-source end marker comes before the start marker");
  return readme.slice(0, start) + section + readme.slice(end + END_MARKER.length);
}
