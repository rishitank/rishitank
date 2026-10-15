#!/usr/bin/env node
// Re-checks every piece of evidence in data/open-source.json against the live
// GitHub API, and that every link in every entry's text resolves.
//
// This is the deterministic half of the trust model: an AI agent may draft
// an entry, but it cannot get one merged unless each claim it cites (who
// opened the issue, that the PR merged, that the maintainer said "released
// in 1.2.3") is literally true on GitHub right now. It cannot check that the
// prose is a fair summary; that is what the independent review is for.
//
//   GITHUB_TOKEN=... node scripts/oss/verify-claims.mjs [--data file.json] [--json report.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./github.mjs";
import { parseInline, readJson } from "./lib.mjs";

// A closing keyword followed by the issue reference, as GitHub itself
// recognises them (https://docs.github.com/articles/closing-issues-using-keywords),
// plus the "Resolves issue #N" phrasing some people write. HTML comments (PR
// templates) are ignored, the keyword must start a word, and a negation
// anywhere earlier in the same clause ("doesn't really fix #N", "this is not
// meant to close #N") does not count. That errs towards "no": a sentence like
// "doesn't break anything and fixes #N" fails, which a person then rewords.
export function referencesIssue(text, repo, issue) {
  if (!text) return false;
  const visible = text.replace(/<!--[\s\S]*?-->/g, " ");
  const n = String(issue);
  const r = repo.replace(/[.]/g, "\\.");
  const re = new RegExp(
    `(^|[^\\w-])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:issue\\s+)?(?:#${n}|${r}#${n}|https://github\\.com/${r}/issues/${n})(?![0-9])`,
    "gi",
  );
  for (const m of visible.matchAll(re)) {
    const upTo = visible.slice(0, m.index + m[1].length);
    const clause = upTo.slice(Math.max(...[".", ";", ",", "!", "?", "\n", ":"].map((c) => upTo.lastIndexOf(c))) + 1);
    if (!/(\bnot\b|\bnever\b|n't\b|\bno longer\b|\bwithout\b)/i.test(clause)) return true;
  }
  return false;
}

// `needle` occurs in `haystack`; a quote that ends in a number ("fixes #59",
// "version 1.14.2") must not match the start of a longer one ("#595",
// "1.14.25").
export function containsQuote(haystack, needle) {
  const text = String(haystack ?? "");
  if (!/[0-9]$/.test(needle)) return text.includes(needle);
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    if (!/[0-9]/.test(text[i + needle.length] ?? "")) return true;
  }
  return false;
}

export async function checkEvidence(gh, ev) {
  const at = `${ev.repo}`;
  switch (ev.type) {
    case "issue": {
      const issue = await gh.get(`/repos/${ev.repo}/issues/${ev.number}`);
      if (!issue) return `${at}#${ev.number}: not found`;
      if (issue.pull_request) return `${at}#${ev.number}: is a pull request, not an issue`;
      if (issue.user?.login !== ev.author) return `${at}#${ev.number}: opened by ${issue.user?.login}, not ${ev.author}`;
      if (ev.contains && !containsQuote(`${issue.title}\n${issue.body ?? ""}`, ev.contains))
        return `${at}#${ev.number}: title/description does not contain ${JSON.stringify(ev.contains)}`;
      return null;
    }
    case "pr": {
      const pr = await gh.get(`/repos/${ev.repo}/pulls/${ev.number}`);
      if (!pr) return `${at}#${ev.number}: pull request not found`;
      if (pr.user?.login !== ev.author) return `${at}#${ev.number}: opened by ${pr.user?.login}, not ${ev.author}`;
      if (ev.merged === true && !pr.merged_at) return `${at}#${ev.number}: claimed merged but is not`;
      if (ev.merged === false && pr.merged_at) return `${at}#${ev.number}: claimed unmerged but it merged`;
      if (ev.state && pr.state !== ev.state) return `${at}#${ev.number}: claimed ${ev.state} but is ${pr.state}`;
      if (ev.base && pr.base?.ref !== ev.base) return `${at}#${ev.number}: targets ${pr.base?.ref}, not ${ev.base}`;
      if (ev.contains && !containsQuote(`${pr.title}\n${pr.body ?? ""}`, ev.contains))
        return `${at}#${ev.number}: title/description does not contain ${JSON.stringify(ev.contains)}`;
      return null;
    }
    case "pr-fixes-issue": {
      const pr = await gh.get(`/repos/${ev.repo}/pulls/${ev.number}`);
      if (!pr) return `${at}#${ev.number}: pull request not found`;
      if (!pr.merged_at) return `${at}#${ev.number}: not merged`;
      if (!referencesIssue(`${pr.title}\n${pr.body ?? ""}`, ev.repo, ev.issue))
        return `${at}#${ev.number}: does not say it fixes/closes/resolves #${ev.issue}`;
      return null;
    }
    case "comment": {
      const comments = await gh.getAll(`/repos/${ev.repo}/issues/${ev.number}/comments`);
      if (!comments) return `${at}#${ev.number}: thread not found`;
      const hit = comments.some((c) => c.user?.login === ev.author && containsQuote(c.body, ev.contains));
      return hit ? null : `${at}#${ev.number}: no comment by ${ev.author} containing ${JSON.stringify(ev.contains)}`;
    }
    case "commit": {
      const commit = await gh.get(`/repos/${ev.repo}/commits/${ev.sha}`);
      if (!commit) return `${at}@${ev.sha.slice(0, 7)}: commit not found`;
      return containsQuote(commit.commit?.message, ev.contains)
        ? null
        : `${at}@${ev.sha.slice(0, 7)}: message does not contain ${JSON.stringify(ev.contains)}`;
    }
    case "release": {
      const rel = await gh.get(`/repos/${ev.repo}/releases/tags/${encodeURIComponent(ev.tag)}`);
      if (!rel) return `${at} ${ev.tag}: release not found`;
      return containsQuote(rel.body, ev.contains) ? null : `${at} ${ev.tag}: notes do not contain ${JSON.stringify(ev.contains)}`;
    }
    case "file": {
      const body = await gh.get(`/repos/${ev.repo}/contents/${ev.path.split("/").map(encodeURIComponent).join("/")}`, { raw: true });
      if (body === null) return `${at}/${ev.path}: file not found`;
      return containsQuote(body, ev.contains) ? null : `${at}/${ev.path}: does not contain ${JSON.stringify(ev.contains)}`;
    }
    case "discussion-answer": {
      const d = await gh.discussionAnswer(ev.repo, ev.number);
      if (!d) return `${at} discussion ${ev.number}: not found`;
      if (ev.opener && d.author?.login !== ev.opener) return `${at} discussion ${ev.number}: opened by ${d.author?.login}, not ${ev.opener}`;
      if (!d.answer) return `${at} discussion ${ev.number}: has no chosen answer`;
      if (d.answer.author?.login !== ev.author) return `${at} discussion ${ev.number}: answer is by ${d.answer.author?.login}, not ${ev.author}`;
      return containsQuote(d.answer.body, ev.contains) ? null : `${at} discussion ${ev.number}: answer does not contain ${JSON.stringify(ev.contains)}`;
    }
    default:
      return `unknown evidence type ${ev.type}`;
  }
}

const ITEM_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull|discussions)\/(\d+)$/;
const REPO_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/;
const TAG_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/(.+)$/;
const COMMIT_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{7,40})$/;

// Every link shape the validator allows is resolved here, so "every link
// resolves" has no exceptions.
export async function checkLink(gh, href) {
  let m;
  if ((m = ITEM_RE.exec(href))) {
    const [, repo, kind, num] = m;
    if (kind === "discussions") return (await gh.discussionAnswer(repo, Number(num))) ? null : `${href}: discussion not found`;
    const item = await gh.get(`/repos/${repo}/issues/${num}`);
    if (!item) return `${href}: not found`;
    const isPr = Boolean(item.pull_request);
    if (kind === "pull" && !isPr) return `${href}: is an issue, link says pull`;
    if (kind === "issues" && isPr) return `${href}: is a pull request, link says issues`;
    return null;
  }
  if ((m = REPO_RE.exec(href))) return (await gh.get(`/repos/${m[1]}`)) ? null : `${href}: repository not found`;
  if ((m = TAG_RE.exec(href))) return (await gh.get(`/repos/${m[1]}/releases/tags/${encodeURIComponent(m[2])}`)) ? null : `${href}: release not found`;
  if ((m = COMMIT_RE.exec(href))) return (await gh.get(`/repos/${m[1]}/commits/${m[2]}`)) ? null : `${href}: commit not found`;
  return `${href}: not a link shape this checker can resolve`;
}

export async function verifyAll(gh, data) {
  const results = [];
  for (const e of data.entries) {
    for (const ev of e.evidence) results.push({ entry: e.id, check: ev.type, error: await checkEvidence(gh, ev) });
    for (const t of parseInline(e.text)) {
      if (t.type === "link") results.push({ entry: e.id, check: `link ${t.label}`, error: await checkLink(gh, t.href) });
    }
  }
  return results;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const data = readJson(arg("--data") ?? path.join(root, "data/open-source.json"));
  // Exit codes: 0 every claim holds, 1 at least one claim is false, 2 the
  // check itself could not run (network, rate limit). Callers treat 2 as
  // "unknown", never as "a claim needs fixing".
  let results;
  try {
    results = await verifyAll(createClient(), data);
  } catch (err) {
    console.error(`verify-claims could not complete: ${err.message}`);
    process.exit(2);
  }
  const failed = results.filter((r) => r.error);
  for (const r of results) console.log(`${r.error ? "FAIL" : "ok  "} ${r.entry} ${r.check}${r.error ? ` - ${r.error}` : ""}`);
  if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify({ checked: results.length, failed }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} claims verified.`);
  if (failed.length) process.exit(1);
}
