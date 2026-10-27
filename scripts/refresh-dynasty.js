#!/usr/bin/env node
// Rewrites data/dynasty-values.js, the saved dynasty values snapshot, from
// FantasyCalc, for both 1QB and Superflex.
//
// Usage: node scripts/refresh-dynasty.js [--dry-run]
//
// The page already pulls these live on every load (see lib/fantasycalc.js),
// so this is only needed to keep the fallback current: what the dynasty tabs
// show offline or if FantasyCalc is down.

const fs = require("fs");
const path = require("path");
const { fetchValues } = require("./lib/fantasycalc");
const { formatDynasty, readSnapshot, DYNASTY_HEADER } = require("./lib/snapshots");

const OUT = path.join(__dirname, "..", "data", "dynasty-values.js");
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const formats = { "1qb": await fetchValues({ superflex: false }), sf: await fetchValues({ superflex: true }) };
  for (const f in formats) console.log(`${f}: ${formats[f].length} rows (${formats[f].filter((r) => r.position === "PICK").length} picks)`);
  if (formats["1qb"].length < 100 || formats.sf.length < 100) throw new Error("Suspiciously few rows — file left as is.");

  const before = readSnapshot(fs, OUT, DYNASTY_HEADER);
  const today = new Date().toISOString().slice(0, 10);
  const body = formatDynasty({ updatedOn: today, ...formats });
  if (before && formatDynasty({ ...before, updatedOn: today }) === body) return console.log("Values unchanged — file left as is.");

  if (DRY_RUN) return console.log("Dry run — file not written.");
  fs.writeFileSync(OUT, body);
  console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
