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

test("trimPlayers keeps two-way players under their skill position", () => {
  const { trimPlayers } = require("../scripts/lib/sleeper-players");
  const t = trimPlayers({
    12530: { full_name: "Travis Hunter", position: "DB", fantasy_positions: ["DB", "WR"], team: "JAX" },
    1379: { full_name: "Kyle Juszczyk", position: "FB", fantasy_positions: ["RB"], team: "SF" },
    5: { full_name: "Just A Corner", position: "CB", fantasy_positions: ["DB"], team: "JAX" },
    6: { full_name: "Free Agent", position: "WR", team: null },
  });
  assert.deepEqual(Object.keys(t).sort(), ["12530", "1379"]);
  assert.equal(t[12530].position, "WR");
  assert.equal(t[1379].position, "RB");
});

test("pickNbaWaivers: hot, available and opportunity picks, skipping the drafted and the injured", () => {
  const { pickNbaWaivers } = require("../scripts/lib/nba-waivers");
  const points = (s) => s.pts || 0;
  const game = (date, pts, min = 30) => ({ date, stats: { pts, sp: min * 60 } });
  const two = (pts, min) => [game("2026-10-25", pts, min), game("2026-10-26", pts, min)];
  const player = (id, team, status = null) => ({ name: `P${id}`, position: "PG", positions: ["PG"], team, status });
  const players = {
    1: player(1, "LAL"), 2: player(2, "LAL"), 3: player(3, "BOS"), 4: player(4, "BOS", "Out"),
    5: player(5, "GSW"), 6: player(6, "GSW", "Out"), 7: player(7, "MIA"), 8: player(8, "MIA"),
  };
  const weeks = [[
    { id: "1", games: two(34) },     // hot and widely added: Must Add
    { id: "2", games: two(40) },     // drafted early: assumed rostered
    { id: "3", games: two(45) },     // fine, but...
    { id: "4", games: two(45) },     // ...this one is Out
    { id: "5", games: two(24) },     // teammate 6 (a 35-point player) is out: Speculative
    { id: "7", games: two(25) },     // 3+ games left: Streamer
    { id: "8", games: two(40, 12) }, // too few minutes
  ]];
  const targets = pickNbaWaivers({
    state: { season_type: "regular", week: 2 }, weeks, players, points, today: "2026-10-27",
    season: [{ id: "6", gp: 4, stats: { pts: 140 } }], previous: [],
    projections: [{ id: "2", adp: 40 }], adds: [{ player_id: "1", count: 9000 }],
    schedule: ["2026-10-28", "2026-10-29", "2026-10-31"].map((date) => ({ date, week: 2, home: "MIA", away: "NYK", done: false })),
  });
  const by = Object.fromEntries(targets.map((t) => [t.id, t.priority]));
  assert.deepEqual(by, { 1: "Must Add", 3: "Must Add", 5: "Speculative", 7: "Streamer" });
  assert.match(targets.find((t) => t.id === "5").note, /P6 is out/);
  assert.match(targets.find((t) => t.id === "1").note, /9,000 adds/);
  assert.deepEqual(pickNbaWaivers({ state: { season_type: "pre" } }), []);
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

test("espn-college: seasons, games, team shares and breakout", () => {
  const E = require("../scripts/lib/espn-college");
  const seasons = E.parseSeasons({
    teams: { "ohio-state-buckeyes": { id: "194", shortDisplayName: "Ohio State" } },
    categories: [
      { name: "receiving", names: ["receptions", "receivingYards", "yardsPerReception", "receivingTouchdowns"],
        statistics: [
          { season: { year: 2025 }, teamSlug: "ohio-state-buckeyes", stats: ["87", "1,243", "14.3", "12"] },
          { season: { year: 2024 }, teamSlug: "ohio-state-buckeyes", stats: ["20", "200", "10.0", "1"] },
        ] },
      { name: "defensive", names: ["totalTackles"], statistics: [{ season: { year: 2025 }, teamSlug: "ohio-state-buckeyes", stats: ["1"] }] },
    ],
  });
  assert.deepEqual(seasons.map((s) => [s.year, s.team, s.rec, s.recYds, s.recTd]), [[2024, "Ohio State", 20, 200, 1], [2025, "Ohio State", 87, 1243, 12]]);
  assert.equal(seasons[1].totalTackles, undefined);

  const log = E.parseGamelog({
    names: ["passingYards", "adjQBR"], events: { a: {}, b: {}, c: {} },
    seasonTypes: [{ displayName: "2025 Postseason", categories: [{ totals: ["300", "50.0"] }] }, { displayName: "2025 Regular Season", categories: [{ totals: ["3,000", "78.0"] }] }],
  });
  assert.deepEqual(log, { g: 3, qbr: 78 });

  const team = E.parseTeamTotals({ results: { stats: { categories: [
    { name: "receiving", stats: [{ name: "receivingYards", value: 3755 }, { name: "receivingTouchdowns", value: 33 }] },
    { name: "rushing", stats: [{ name: "rushingYards", value: 2161 }, { name: "totalYards", value: 5916 }] },
    { name: "general", stats: [{ name: "gamesPlayed", value: 14 }] },
  ] } } });
  const sh = E.shares(seasons[1], team);
  assert.equal(sh.recYds, 33.1);
  assert.equal(sh.recTd, 36.4);
  assert.equal(sh.dominator, 34.8);
  assert.equal(sh.rushYds, null);
  assert.equal(E.breakoutYear([{ year: 2024, shares: { dominator: 12 } }, { year: 2025, shares: sh }]), 2025);
});

test("prospects-2027.js has every CLASS_2027 espnId", () => {
  const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const ids = [...src.matchAll(/espnId: "(\d+)"/g)].map((m) => m[1]);
  const sandbox = { window: {} };
  require("vm").runInNewContext(fs.readFileSync(path.join(ROOT, "data/prospects-2027.js"), "utf8"), sandbox);
  for (const id of ids) assert.ok(sandbox.window.PROSPECTS_2027.players[id], `no college stats for espnId ${id}`);
});

const market = require("../scripts/lib/nba-market");

test("nba-market parseTrade: who got what, picks by drafts away, redraft drops picks", () => {
  const tx = {
    type: "trade", status: "complete", transaction_id: "9", status_updated: 1000, roster_ids: [2, 13],
    adds: { 4001: 2, 4002: 13, 4003: 13 },
    draft_picks: [
      { season: "2027", round: 1, roster_id: 13, owner_id: 2, previous_owner_id: 13 },
      { season: "2026", round: 2, roster_id: 2, owner_id: 13, previous_owner_id: 2 }, // already made
    ],
  };
  const t = market.parseTrade(tx, { id: "L", type: 2, size: 12, season: "2026" });
  assert.equal(t.format, "dynasty");
  assert.deepEqual(t.sides, [["4001", "pick-1-1"], ["4002", "4003"]]);
  assert.equal(market.pickInfo("pick-1-1", "2026").label, "2027 1st");
  const r = market.parseTrade(tx, { id: "L", type: 0, size: 12, season: "2026" });
  assert.deepEqual(r.sides, [["4001"], ["4002", "4003"]]);
  assert.equal(market.parseTrade({ ...tx, status: "failed" }, { id: "L", type: 2, season: "2026" }), null);
  assert.equal(market.parseTrade({ ...tx, roster_ids: [1, 2, 3] }, { id: "L", type: 2, season: "2026" }), null);
});

test("nba-market cleanTrades: drops lopsided, oversized, unknown and past a league's cap", () => {
  const prior = { a: 100, b: 90, c: 10, d: 5 };
  const t = (id, sides, league = "L", ts = 1e12) => ({ id, ts, sides, league, weight: 1 });
  const kept = market.cleanTrades([
    t("fair", [["a"], ["b"]]),
    t("lopsided", [["a"], ["d"]]),
    t("unknown", [["a"], ["zz"]]),
    t("big", [["a"], ["b", "c", "d", "c", "d", "c", "d"]]),
  ], prior).map((x) => x.id);
  assert.deepEqual(kept, ["fair"]);
  const many = Array.from({ length: market.LEAGUE_CAP + 5 }, (_, i) => t(`t${i}`, [["a"], ["b"]], "busy", 1e12 + i));
  assert.equal(market.cleanTrades(many, prior).length, market.LEAGUE_CAP);
});

test("nba-market fitValues: trades move values, thin assets stay near the model", () => {
  // The model says A and B are even, but managers keep paying B + C for A.
  const prior = { A: 100, B: 100, C: 40, D: 50 };
  const now = Date.now();
  const trades = Array.from({ length: 30 }, (_, i) => ({ id: String(i), ts: now - i * 86400000, weight: 1, league: String(i), sides: [["A"], ["B", "C"]] }));
  const fit = market.fitValues(trades, prior, { now, halfLife: 30 });
  assert.ok(fit.values.A > fit.values.B * 1.15, "A rises above B");
  assert.ok(Math.abs(fit.values.D - 50) < 0.5, "untraded D keeps its model value");
  // One stud beats two half-as-good players (the consolidation premium).
  assert.ok(market.sideValue({ x: 100, y: 50, z: 50 }, ["y", "z"]) < 100);
  // A single strange trade barely moves anything.
  const one = market.fitValues([{ id: "x", ts: now, weight: 1, league: "q", sides: [["D"], ["A"]] }], prior, { now, halfLife: 30 });
  assert.ok(one.values.A > one.values.D, "one trade doesn't flip A and D");
});

test("nba-market scaleValues and tiers: top is 9999, tiers break at big drops", () => {
  const rows = market.scaleValues({ values: { a: 50, b: 49, c: 30 }, n: { a: 3, b: 0, c: 1 } }, { a: 40, b: 49, c: 30 }, ["a", "b", "c"]);
  assert.deepEqual(rows.map((r) => [r.id, r.v]), [["a", 9999], ["b", 9799], ["c", 5999]]);
  assert.deepEqual(market.tiers(rows), [1, 1, 2]);
});

test("nba-market ageFactor and priorValues: young players climb in dynasty", () => {
  assert.ok(market.ageFactor(21, 3) > 1 && market.ageFactor(34, 3) < 0.8);
  const line = (id, name, gp, pts) => ({ id, name, position: "PG", team: "SAC", gp, stats: { pts } });
  const snap = {
    state: { season: "2026", previous_season: "2025" },
    "season-2026": [line("young", "Young", 10, 300), line("old", "Old", 10, 300)],
    "season-2025": [line("young", "Young", 70, 2100), line("old", "Old", 70, 2100)],
    players: { young: { name: "Young", age: 21, team: "SAC" }, old: { name: "Old", age: 34, team: "SAC" } },
  };
  const d = market.priorValues(snap, "dynasty"), r = market.priorValues(snap, "redraft");
  assert.ok(d.young > d.old * 1.3);
  assert.equal(Math.round(r.young), Math.round(r.old));
  assert.ok(d["pick-1-1"] > 0 && r["pick-1-1"] == null);
});
