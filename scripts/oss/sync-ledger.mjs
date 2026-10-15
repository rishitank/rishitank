#!/usr/bin/env node
// Runs after the curator agent. Copies the facts the scan observed (kind,
// state, updatedAt) from discovery.json into the ledger for every new and
// changed item, so those are never typed by the model, and fails if the
// agent left any new item without a decision.
//
//   node scripts/oss/sync-ledger.mjs discovery.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./lib.mjs";

export function syncLedger(ledger, discovery) {
  const problems = [];
  for (const f of [...discovery.new, ...discovery.changed]) {
    const item = ledger.items[f.key];
    if (!item || !["included", "excluded"].includes(item.decision)) {
      problems.push(`${f.key}: no decision recorded`);
      continue;
    }
    item.kind = f.kind;
    item.state = f.state;
    item.updatedAt = f.updatedAt;
  }
  // Keep keys sorted so diffs stay readable.
  ledger.items = Object.fromEntries(Object.entries(ledger.items).sort(([a], [b]) => a.localeCompare(b, "en")));
  return problems;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const ledgerPath = path.join(root, "data/open-source-ledger.json");
  const ledger = readJson(ledgerPath);
  const problems = syncLedger(ledger, readJson(process.argv[2] ?? path.join(root, "discovery.json")));
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  if (problems.length) {
    console.error(`Ledger incomplete:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("Ledger synced with discovery.json.");
}
