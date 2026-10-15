#!/usr/bin/env node
// Weekly scan, no AI. Finds what changed since the ledger was last updated:
//
//   new      an issue or PR the user authored upstream that the ledger has
//            never seen
//   changed  a ledger item whose updatedAt moved (new comment, merged,
//            closed, reopened...), so an earlier decision may no longer hold
//   watch    an entry asked to be told when a release mentions something
//            (e.g. "#2869"), and a release now does
//   missing  in the ledger but no longer found by search (deleted, made
//            private); reported only, never acted on automatically
//
// Writes discovery.json and, on GitHub Actions, sets the output
// `changed=true|false`. The AI step only runs when it is true, so a quiet
// week costs one search and no tokens.
//
//   GITHUB_TOKEN=... node scripts/oss/discover.mjs [--out discovery.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./github.mjs";
import { ledgerKey, readJson } from "./lib.mjs";

export function searchQuery(ledger, kind) {
  return [`author:${ledger.user}`, `is:${kind}`, ...ledger.excludeOwners.map((o) => `-user:${o}`)].join(" ");
}

// Normalise a search API item to the ledger's shape.
export function toLedgerItem(item) {
  const repo = item.repository_url.replace("https://api.github.com/repos/", "");
  const kind = item.pull_request ? "pr" : "issue";
  const state = kind === "pr" && item.pull_request?.merged_at ? "merged" : item.state;
  return {
    key: ledgerKey(repo, item.number),
    kind,
    state,
    updatedAt: item.updated_at,
    title: item.title,
    url: item.html_url,
  };
}

export function computeDiff(ledger, found) {
  const seen = new Set();
  const out = { new: [], changed: [], missing: [] };
  for (const f of found) {
    seen.add(f.key);
    const prev = ledger.items[f.key];
    if (!prev) out.new.push(f);
    else if (prev.updatedAt !== f.updatedAt || prev.state !== f.state)
      out.changed.push({ ...f, previous: { state: prev.state, updatedAt: prev.updatedAt }, decision: prev.decision, entry: prev.entry, reason: prev.reason });
  }
  for (const key of Object.keys(ledger.items)) if (!seen.has(key)) out.missing.push(key);
  return out;
}

export async function checkWatches(gh, data) {
  const hits = [];
  for (const e of data.entries) {
    for (const w of e.watch ?? []) {
      const releases = (await gh.get(`/repos/${w.repo}/releases?per_page=20`)) ?? [];
      // "#2869" must not match "#28690".
      const re = new RegExp(`${w.contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
      const rel = releases.find((r) => !r.draft && re.test(r.body ?? ""));
      if (rel) hits.push({ entry: e.id, repo: w.repo, contains: w.contains, note: w.note, release: { tag: rel.tag_name, url: rel.html_url, publishedAt: rel.published_at } });
    }
  }
  return hits;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const outIdx = process.argv.indexOf("--out");
  const outPath = outIdx === -1 ? path.join(root, "discovery.json") : process.argv[outIdx + 1];
  const ledger = readJson(path.join(root, "data/open-source-ledger.json"));
  const data = readJson(path.join(root, "data/open-source.json"));
  const gh = createClient();

  const found = [];
  for (const kind of ["issue", "pr"]) {
    const q = encodeURIComponent(searchQuery(ledger, kind));
    const items = await gh.getAll(`/search/issues?q=${q}&sort=created&order=desc`);
    found.push(...(items ?? []).map(toLedgerItem));
  }
  const diff = computeDiff(ledger, found);
  const watch = await checkWatches(gh, data);
  const report = { generatedAt: new Date().toISOString(), searched: found.length, ...diff, watch };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

  const changed = diff.new.length + diff.changed.length + watch.length > 0;
  console.log(`Searched ${found.length} items: ${diff.new.length} new, ${diff.changed.length} changed, ${watch.length} watch hit(s), ${diff.missing.length} missing.`);
  for (const n of diff.new) console.log(`  new      ${n.key} (${n.state}) ${n.title}`);
  for (const c of diff.changed) console.log(`  changed  ${c.key} ${c.previous.state} -> ${c.state} (${c.decision})`);
  for (const w of watch) console.log(`  watch    ${w.entry}: ${w.release.tag} mentions ${w.contains}`);
  for (const m of diff.missing) console.log(`  missing  ${m}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
