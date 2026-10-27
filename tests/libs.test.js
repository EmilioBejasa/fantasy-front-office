// The shared scripts/lib code the page and the refresh scripts both use.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { summarizeWeek, mergeExtras, isWeekFinal } = require("../scripts/lib/sleeper-scores");
const snapshots = require("../scripts/lib/snapshots");
const { ROOT } = require("./load-app");

const row = (id, first, last, position, team, stats, opponent = "BUF") => ({
  player_id: id, team, opponent, stats, player: { first_name: first, last_name: last, position },
});

test("summarizeWeek: scores, OUT and extras", () => {
  const players = [
    { id: "gibbs", name: "Jahmyr Gibbs", team: "DET", position: "RB" },
    { id: "lap", name: "Sam LaPorta", team: "DET", position: "TE" },
    { id: "allen", name: "Josh Allen", team: "BUF", position: "QB" },
  ];
  const rows = [
    row("9221", "Jahmyr", "Gibbs", "RB", "DET", { gp: 1, pts_ppr: 21.34, off_snp: 40, tm_off_snp: 60, rush_att: 15, rec_tgt: 4 }),
    row("1", "Sam", "LaPorta", "TE", "DET", {}),                         // DET played, he didn't: OUT
    row("2", "Backup", "Back", "RB", "WAS", { gp: 1, pts_ppr: 5 }, "DET"), // not in the pool: an extra, WAS → WSH
  ];
  const wk = summarizeWeek(rows, players);
  assert.equal(wk.scores.gibbs, 21.3);
  assert.deepEqual(wk.dnp, ["lap"]);
  assert.equal(wk.scores.allen, undefined); // BUF hasn't played: blank, not OUT
  assert.ok(!wk.dnp.includes("allen"));
  assert.deepEqual(wk.details.gibbs, { opp: "BUF", snap: 67, tgt: 4, car: 15 });
  assert.equal(wk.extras["2"].team, "WSH");
  assert.equal(wk.allowed.BUF.RB, 21.3);
});

test("isWeekFinal: last week stays live until display_week moves on too", () => {
  // The Tuesday after Monday night: Sleeper's week is 8, display_week still 7.
  const tuesday = { season_type: "regular", week: 8, display_week: 7 };
  assert.equal(isWeekFinal(tuesday, 6), true);
  assert.equal(isWeekFinal(tuesday, 7), false);
  assert.equal(isWeekFinal({ ...tuesday, display_week: 8 }, 7), true);
  assert.equal(isWeekFinal({ season_type: "regular", week: 8 }, 7), true); // no display_week
  assert.equal(isWeekFinal({ season_type: "post", week: 1, display_week: 1 }, 18), true);
});

test("mergeExtras: players who only logged zeros are left out", () => {
  const byWeek = {
    1: { scores: { a: 1 }, extras: { 10: { name: "Ten", team: "X", position: "WR", pts: 4 }, 11: { name: "Zero", team: "X", position: "QB", pts: 0 } } },
    2: { scores: { a: 2 }, extras: { 10: { name: "Ten", team: "Y", position: "WR", pts: 6 } } },
  };
  const { scores, players } = mergeExtras(byWeek);
  assert.deepEqual(players.map((p) => p.id), ["sl-10"]);
  assert.equal(players[0].team, "Y"); // latest team
  assert.equal(scores[2]["sl-10"], 6);
  assert.equal(scores[1]["sl-11"], undefined);
});

test("snapshot files read back exactly as written", () => {
  for (const [file, header, format] of [
    ["data/nfl-scores.js", snapshots.SCORES_HEADER, snapshots.formatScores],
    ["data/dynasty-values.js", snapshots.DYNASTY_HEADER, snapshots.formatDynasty],
  ]) {
    const full = path.join(ROOT, file);
    const data = snapshots.readSnapshot(fs, full, header);
    assert.ok(data, `${file} didn't parse`);
    assert.equal(format(data), fs.readFileSync(full, "utf8"), `${file} doesn't round-trip`);
  }
});

test("the dynasty snapshot's fields match its rows", () => {
  global.window = {};
  require("../data/dynasty-values.js");
  const snap = global.window.DYNASTY_SNAPSHOT;
  assert.deepEqual(snap.fields, snapshots.DYNASTY_FIELDS);
  for (const qb of ["1qb", "sf"]) {
    assert.ok(snap[qb].length > 100);
    for (const r of snap[qb]) assert.equal(r.length, snap.fields.length);
  }
});
