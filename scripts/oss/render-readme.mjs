#!/usr/bin/env node
// Rewrites the open-source block of README.md from data/open-source.json.
//
//   node scripts/oss/render-readme.mjs          write README.md in place
//   node scripts/oss/render-readme.mjs --check  exit 1 if README.md is stale
//
// CI runs --check, so a PR that edits the JSON without regenerating the
// README (or edits the README block by hand) fails instead of drifting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applySection, readJson, renderSection, validateData } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataPath = path.join(root, "data/open-source.json");
const readmePath = path.join(root, "README.md");

const data = readJson(dataPath);
const errors = validateData(data);
if (errors.length) {
  console.error(`data/open-source.json is invalid:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

const current = fs.readFileSync(readmePath, "utf8");
const next = applySection(current, renderSection(data));

if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("README.md is out of date. Run: node scripts/oss/render-readme.mjs");
    process.exit(1);
  }
  console.log("README.md open-source block matches data/open-source.json.");
} else if (current === next) {
  console.log("README.md already up to date.");
} else {
  fs.writeFileSync(readmePath, next);
  console.log("README.md updated.");
}
