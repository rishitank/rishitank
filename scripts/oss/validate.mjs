#!/usr/bin/env node
// Offline checks: the data file's shape and inline markup, and that the
// ledger and the data file agree with each other. No network.

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { findSecrets, readJson, validateData, validateLedger } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const data = readJson(path.join(root, "data/open-source.json"));
const ledger = readJson(path.join(root, "data/open-source-ledger.json"));

const errors = [...validateData(data), ...validateLedger(ledger, data)];
for (const f of ["data/open-source.json", "data/open-source-ledger.json", "oss-summary.md"]) {
  const file = path.join(root, f);
  if (!fs.existsSync(file)) continue;
  for (const hit of findSecrets(fs.readFileSync(file, "utf8"))) errors.push(`${f}: contains something that looks like a credential (${hit})`);
}
if (errors.length) {
  console.error(`${errors.length} problem(s):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
const included = Object.values(ledger.items).filter((i) => i.decision === "included").length;
console.log(`OK: ${data.entries.length} entries; ledger has ${Object.keys(ledger.items).length} items (${included} included).`);
