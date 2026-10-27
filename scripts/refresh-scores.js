#!/usr/bin/env node
// Rewrites data/nfl-scores.js, the saved football scores snapshot, from
// Sleeper's stats API for every week played so far.
//
// Usage: node scripts/refresh-scores.js [--dry-run]
//
// The page already pulls these live from Sleeper on every load (see
// lib/sleeper-scores.js), so this is only needed to keep the fallback
// current: what the page shows offline or if Sleeper is down.

const fs = require("fs");
const path = require("path");
const { fetchState, fetchWeek, weeksToFetch, mergeExtras } = require("./lib/sleeper-scores");
const { extractBlock } = require("./lib/bake");
const { formatScores, readSnapshot, SCORES_HEADER } = require("./lib/snapshots");

const INDEX_HTML = path.join(__dirname, "..", "index.html");
const OUT = path.join(__dirname, "..", "data", "nfl-scores.js");
const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const source = fs.readFileSync(INDEX_HTML, "utf8");
  const players = eval(extractBlock(source, "const samplePlayers = [", "\n];").text.replace(/^const samplePlayers = /, ""));

  const state = await fetchState();
  const byWeek = {};
  const dnp = {};
  for (const week of weeksToFetch(state)) {
    const wk = await fetchWeek(state.season, week, players);
    if (wk.teamsPlayed.length === 0) continue;
    byWeek[week] = wk;
    dnp[week] = wk.dnp;
    console.log(`Week ${week}: ${Object.keys(wk.scores).length} scores, ${wk.dnp.length} did not play, ${wk.teamsPlayed.length}/32 teams played`);
  }
  const { scores, players: extras } = mergeExtras(byWeek);
  console.log(`${extras.length} players outside samplePlayers have scored this season`);
  // Offseason/preseason: keep the last snapshot rather than blanking it.
  if (Object.keys(byWeek).length === 0) return console.log("No weeks played yet — file left as is.");

  // Only bump the date when the data changed, so scheduled runs don't commit no-ops.
  const before = readSnapshot(fs, OUT, SCORES_HEADER);
  const today = new Date().toISOString().slice(0, 10);
  const body = formatScores({ updatedOn: today, scores, dnp, extras });
  if (before && formatScores({ ...before, updatedOn: today }) === body) return console.log("Scores unchanged — file left as is.");

  if (DRY_RUN) return console.log("Dry run — file not written.");
  fs.writeFileSync(OUT, body);
  console.log(`Wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
