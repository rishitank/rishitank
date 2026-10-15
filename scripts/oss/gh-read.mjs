#!/usr/bin/env node
// The only way the curator and reviewer agents can see GitHub: read-only GET
// requests under /repos/... and /search/..., plus a discussion's chosen
// answer. The workflow allow-lists exactly this script for the agents, and the
// token it uses is the job's own `contents: read` GITHUB_TOKEN, so a prompt
// injected through an issue comment cannot make the agent write anywhere.
//
//   node scripts/oss/gh-read.mjs --thread OWNER/REPO N        issue or PR, every comment, and its timeline, compacted
//   node scripts/oss/gh-read.mjs /repos/OWNER/REPO/pulls/N    any single GET under /repos or /search
//   node scripts/oss/gh-read.mjs --all /repos/OWNER/REPO/...  every page of a list endpoint
//   node scripts/oss/gh-read.mjs --discussion OWNER/REPO N    a discussion's chosen answer

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./github.mjs";

// Accept a path only if, after percent-decoding and URL normalisation, it is
// still under /repos/ or /search/. "/repos/%2e%2e/user" normalises to "/user"
// and is refused.
export function allowedPath(p) {
  if (typeof p !== "string" || !p.startsWith("/")) return false;
  let decoded;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return false;
  }
  if (decoded.includes("..") || /[\s\\]/.test(decoded)) return false;
  const url = new URL(p, "https://api.github.com");
  if (url.origin !== "https://api.github.com") return false;
  const normalised = decodeURIComponent(url.pathname);
  return /^\/(repos|search)\//.test(normalised) && !normalised.includes("..");
}

const REPO_ARG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Keep only what a reader of the thread needs, so long threads fit.
const brief = (c) => ({ user: c.user?.login, created_at: c.created_at, body: c.body, url: c.html_url });
function briefEvent(e) {
  const out = { event: e.event, actor: e.actor?.login ?? e.user?.login, created_at: e.created_at };
  if (e.commit_id) out.commit_id = e.commit_id;
  if (e.source?.issue) {
    const i = e.source.issue;
    out.source = { url: i.html_url, title: i.title, state: i.state, is_pr: Boolean(i.pull_request), merged_at: i.pull_request?.merged_at ?? null, author: i.user?.login };
  }
  if (e.event === "commented") return null; // comments are listed separately
  return out;
}

export async function thread(gh, repo, number) {
  const item = await gh.get(`/repos/${repo}/issues/${number}`);
  if (!item) return { error: "not found" };
  const [comments, timeline, pr] = await Promise.all([
    gh.getAll(`/repos/${repo}/issues/${number}/comments`),
    gh.getAll(`/repos/${repo}/issues/${number}/timeline`),
    item.pull_request ? gh.get(`/repos/${repo}/pulls/${number}`) : null,
  ]);
  return {
    url: item.html_url,
    kind: item.pull_request ? "pr" : "issue",
    title: item.title,
    author: item.user?.login,
    state: item.state,
    state_reason: item.state_reason ?? null,
    created_at: item.created_at,
    closed_at: item.closed_at,
    closed_by: item.closed_by?.login ?? null,
    merged_at: pr?.merged_at ?? null,
    merged_by: pr?.merged_by?.login ?? null,
    body: item.body,
    comments: (comments ?? []).map(brief),
    timeline: (timeline ?? []).map(briefEvent).filter(Boolean),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const usage = "usage: gh-read.mjs --thread OWNER/REPO N | [--all] /repos/... | /search/... | --discussion OWNER/REPO N";
  const gh = createClient();
  try {
    let out;
    if (args[0] === "--thread" || args[0] === "--discussion") {
      const [repo, num] = args.slice(1);
      if (!REPO_ARG.test(repo ?? "") || !/^\d+$/.test(num ?? "")) throw new Error(usage);
      out = args[0] === "--thread" ? await thread(gh, repo, Number(num)) : await gh.discussionAnswer(repo, Number(num));
    } else {
      const all = args[0] === "--all";
      const p = all ? args[1] : args[0];
      if (!allowedPath(p)) throw new Error(usage);
      out = all ? await gh.getAll(p) : await gh.get(p);
    }
    console.log(JSON.stringify(out ?? { error: "not found" }, null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
