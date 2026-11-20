#!/usr/bin/env node
// Checks that every data/ file is fresh and not suspiciously small, so a
// refresh Action that quietly stops working (a feed changes shape, an API
// starts failing, a job is disabled) shows up as a failed run, and an email,
// instead of a stale site. The daily check-data Action runs it.
//
// Usage: node scripts/check-data.js [--today YYYY-MM-DD]
//
// Each check: the file's date (updatedOn, the last history date or
// fetchedAt) is at most `maxDays` old, and `count` (how many players, trades
// or rows it holds) is at least `min`. Checks with `months` only run in those
// months (1-12), so the off-season doesn't fail them: NFL games run
// September-February, NBA October-June. The trade markets and values run all
// year, since dynasty trading never stops.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DATA = path.join(__dirname, "..", "data");
const NFL_SEASON = [9, 10, 11, 12, 1, 2];
const NBA_SEASON = [10, 11, 12, 1, 2, 3, 4, 5, 6];

const size = (o) => (Array.isArray(o) ? o.length : o && typeof o === "object" ? Object.keys(o).length : 0);
const lastDate = (d) => d.dates?.[d.dates.length - 1];

const CHECKS = [
  { file: "nfl-players.js", maxDays: 1, date: (d) => new Date(d.fetchedAt).toISOString().slice(0, 10), count: (d) => size(d.players), min: 500 },
  { file: "nfl-scores.js", maxDays: 9, months: NFL_SEASON, count: (d) => size(d.scores), min: 1 },
  { file: "nfl-market.js", maxDays: 3, count: (d) => size(d.values?.dynasty?.["1qb"]), min: 200 },
  { file: "nfl-market-history.js", maxDays: 9, date: lastDate, count: (d) => size(d["dynasty-1qb"]), min: 200 },
  { file: "nfl-trades.js", maxDays: 3, count: (d) => size(d.trades), min: 500 },
  { file: "market-values.js", maxDays: 3, count: (d) => size(d.values?.ktc?.["1qb"]), min: 200 },
  { file: "market-history.js", maxDays: 9, date: lastDate, count: (d) => size(d.dates), min: 2 },
  { file: "dynasty-values.js", maxDays: 9, count: (d) => size(d["1qb"]), min: 200 },
  { file: "prospects-2027.js", maxDays: 9, count: (d) => size(d.players), min: 10 },
  { file: "nba-snapshot.js", maxDays: 3, months: NBA_SEASON, count: (d) => size(d.data?.[`season-${d.data?.state?.season}`]), min: 200 },
  { file: "nba-waivers.js", maxDays: 3, months: NBA_SEASON, count: (d) => size(d.targets), min: 1 },
  { file: "nba-market.js", maxDays: 3, count: (d) => size(d.formats?.dynasty), min: 150 },
  { file: "nba-market-history.js", maxDays: 9, date: lastDate, count: (d) => size(d.dynasty), min: 150 },
  { file: "nba-trades.js", maxDays: 3, count: (d) => size(d.trades), min: 500 },
];

// The object a data file assigns to window.
function readDataFile(file) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(DATA, file), "utf8"), { window });
  const values = Object.values(window);
  if (values.length !== 1) throw new Error("expected one window global");
  return values[0];
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

// [{ file, ok, skipped, message }] for every check, as of `today` (YYYY-MM-DD).
function runChecks(today, checks = CHECKS, read = readDataFile) {
  const month = Number(today.slice(5, 7));
  return checks.map((c) => {
    if (c.months && !c.months.includes(month)) return { file: c.file, ok: true, skipped: true, message: "off-season, skipped" };
    try {
      const d = read(c.file);
      const date = (c.date || ((x) => x.updatedOn))(d);
      const problems = [];
      if (!date || Number.isNaN(Date.parse(date))) problems.push("no date");
      else if (daysBetween(date, today) > c.maxDays) problems.push(`last updated ${date}, ${daysBetween(date, today)} days ago (limit ${c.maxDays})`);
      const n = c.count(d);
      if (n < c.min) problems.push(`only ${n} entries (expected at least ${c.min})`);
      return { file: c.file, ok: problems.length === 0, message: problems.length ? problems.join("; ") : `${date}, ${n} entries` };
    } catch (e) {
      return { file: c.file, ok: false, message: `couldn't read it: ${e.message}` };
    }
  });
}

if (require.main === module) {
  const i = process.argv.indexOf("--today");
  const today = i > 0 ? process.argv[i + 1] : new Date().toISOString().slice(0, 10);
  const results = runChecks(today);
  for (const r of results) console.log(`${r.ok ? (r.skipped ? "–" : "✓") : "✗"} ${r.file}: ${r.message}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n${failed.length} data file(s) look stale or broken. Check that file's refresh Action.`);
    process.exit(1);
  }
}

module.exports = { CHECKS, runChecks, readDataFile };
