#!/usr/bin/env node
// Checks the hand-kept INJURED_RESERVE list in index.html against Sleeper's
// saved designations (data/nfl-players.js) and the weekly scores
// (data/nfl-scores.js), and prints what's worth a look before editing it.
// Informational only: it never changes a file and always exits 0.
//
// Usage: node scripts/check-injuries.js [--week N]
//   --week  the upcoming week (default: the week after the last one played)
//
// Run `node scripts/refresh-players.js` first for the newest designations.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const LONG_TERM = ["IR", "PUP"];
// Injury text with nothing past the body part ("Knee", "Ankle sprain" is fine).
const VAGUE_INJURY = /^\s*[A-Za-z]+\s*$/;

// list: INJURED_RESERVE entries. pool: players by app id ({id, name, team,
// position}). sleeper: Sleeper's map by Sleeper id ({name, status, injury}).
// scores: {week: {appId: pts}}. week: the upcoming week. resolve(id, name,
// pos) -> Sleeper id. returnWeek(entry, team) -> earliest return week.
// Returns {activeAgain, scoredSince, pastReturn, notListed, vague, unknown},
// each a list of {id, name, team, detail}.
function checkInjuries({ list, pool, sleeper, scores, week, resolve, returnWeek }) {
  const out = { activeAgain: [], scoredSince: [], pastReturn: [], notListed: [], vague: [], unknown: [] };
  const byId = Object.fromEntries(pool.map((p) => [p.id, p]));
  const listed = new Set(list.map((r) => r.id));
  const sleeperOf = (p) => sleeper[resolve(p.id, p.name, p.position)];
  const row = (p, detail) => ({ id: p.id, name: p.name, team: p.team, detail });
  const weeks = Object.keys(scores).map(Number).sort((a, b) => a - b);

  for (const r of list) {
    const p = byId[r.id];
    if (!p) { out.unknown.push({ id: r.id, name: r.id, team: "", detail: "not in samplePlayers or the scores' extra players" }); continue; }
    const sp = sleeperOf(p);
    if (!r.seasonEnding && sp && sp.status == null) {
      out.activeAgain.push(row(p, "Sleeper shows him healthy (the site already hides him); remove the entry"));
    }
    // Points, not just an entry: Sleeper sometimes logs a game with no stats (0) for an IR player.
    const playedSince = weeks.filter((w) => w >= r.sinceWeek && scores[w]?.[r.id] > 0);
    if (playedSince.length) {
      out.scoredSince.push(row(p, `scored in Wk ${playedSince.join(", ")} but sinceWeek is ${r.sinceWeek}; fix the start week or remove`));
    } else if (!r.seasonEnding) {
      const back = returnWeek(r, p.team);
      if (back != null && back < week) out.pastReturn.push(row(p, `eligible since Wk ${back}, Sleeper: ${sp ? sp.status || "active" : "not found"}; check for activation or a longer timeline`));
    }
    if (VAGUE_INJURY.test(r.injury || "")) out.vague.push(row(p, `"${r.injury}"; add detail if the news has it`));
  }

  for (const p of pool) {
    if (listed.has(p.id)) continue;
    const sp = sleeperOf(p);
    if (sp && LONG_TERM.includes(sp.status)) {
      out.notListed.push(row(p, `Sleeper: ${sp.status}, ${sp.injury || "undisclosed"}; add an entry for a real description, start week or season-ending call`));
    }
  }
  return out;
}

// The upcoming week: the week after the last one played, unless that week is
// still under way (fewer than 26 teams have scores in it).
function upcomingWeek(scores, pool) {
  const weeks = Object.keys(scores).map(Number).sort((a, b) => a - b);
  const latest = weeks[weeks.length - 1];
  if (!latest) return 1;
  const teamOf = Object.fromEntries(pool.map((p) => [p.id, p.team]));
  const teams = new Set(Object.keys(scores[latest]).map((id) => teamOf[id]).filter(Boolean));
  return teams.size >= 26 ? latest + 1 : latest;
}

const SECTIONS = [
  ["activeAgain", "Active again"],
  ["scoredSince", "Played after their start week"],
  ["pastReturn", "Past their earliest return, still listed"],
  ["notListed", "On Sleeper's IR/PUP but not hand-listed"],
  ["vague", "Vague injury description"],
  ["unknown", "Unknown ids"],
];

function readWindowData(file, name) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, file), "utf8"), sandbox);
  return sandbox.window[name];
}

function main() {
  const { loadApp } = require("../tests/load-app");
  const app = loadApp();
  const players = readWindowData("data/nfl-players.js", "NFL_PLAYERS");
  const scores = readWindowData("data/nfl-scores.js", "NFL_SCORES");
  const pool = [...app.samplePlayers, ...(scores.extras || [])];
  const weekArg = process.argv.indexOf("--week");
  const week = weekArg > 0 ? Number(process.argv[weekArg + 1]) : upcomingWeek(scores.scores, pool);

  const result = checkInjuries({
    list: app.INJURED_RESERVE, pool, sleeper: players.players, scores: scores.scores, week,
    resolve: app.nflIdResolver(players.players), returnWeek: app.irReturnWeek,
  });

  const age = Math.round((Date.now() - players.fetchedAt) / 3600000);
  console.log(`INJURED_RESERVE: ${app.INJURED_RESERVE.length} entries (updated ${app.INJURED_RESERVE_UPDATED_ON}). Upcoming week ${week}. Sleeper designations ${age}h old.\n`);
  let total = 0;
  for (const [key, title] of SECTIONS) {
    const rows = result[key];
    if (!rows.length) continue;
    total += rows.length;
    console.log(`${title} (${rows.length})`);
    // Vague descriptions are a low-priority nice-to-have: one line, not one each.
    if (key === "vague") console.log(`  ${rows.map((r) => `${r.name} (${r.detail.split(";")[0]})`).join(", ")}`);
    else for (const r of rows) console.log(`  - ${r.name}${r.team ? ` (${r.team})` : ""} [${r.id}]: ${r.detail}`);
    console.log("");
  }
  console.log(total ? `${total} to look at.` : "Nothing to look at.");
}

if (require.main === module) main();
module.exports = { checkInjuries, upcomingWeek };
