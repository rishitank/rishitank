#!/usr/bin/env node
// Offline checks: the data file's shape and inline markup, and that the
// ledger and the data file agree with each other. No network.
//
//   node scripts/oss/validate.mjs [--base-ledger main-ledger.json] [--scan file ...]
//
// --base-ledger  also check that the ledger keeps main's user, excluded
//                owners and every item already recorded (used by the weekly
//                publish step on the curator's output)
// --scan         also look for credentials in these files (the curator's
//                summary and the reviewer's verdict, which go into the PR body)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkLedgerInvariants, findSecrets, readJson, validateData, validateLedger } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const data = readJson(path.join(root, "data/open-source.json"));
const ledger = readJson(path.join(root, "data/open-source-ledger.json"));

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base-ledger");
const baseLedger = baseIdx === -1 ? null : args[baseIdx + 1];
const scanIdx = args.indexOf("--scan");
const extra = scanIdx === -1 ? [] : args.slice(scanIdx + 1).filter((a) => !a.startsWith("--"));

const errors = [...validateData(data), ...validateLedger(ledger, data)];
if (baseLedger) errors.push(...checkLedgerInvariants(readJson(baseLedger), ledger));

const scanned = [
  ...["data/open-source.json", "data/open-source-ledger.json", "oss-summary.md"].map((f) => ({ label: f, file: path.join(root, f) })),
  ...extra.map((f) => ({ label: f, file: path.resolve(f) })),
];
for (const { label, file } of scanned) {
  if (!fs.existsSync(file)) continue;
  for (const hit of findSecrets(fs.readFileSync(file, "utf8"))) errors.push(`${label}: contains something that looks like a credential (${hit})`);
}
if (errors.length) {
  console.error(`${errors.length} problem(s):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
const included = Object.values(ledger.items).filter((i) => i.decision === "included").length;
console.log(`OK: ${data.entries.length} entries; ledger has ${Object.keys(ledger.items).length} items (${included} included).`);
