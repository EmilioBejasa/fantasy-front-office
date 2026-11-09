// The page's own math, run straight out of index.html (see load-app.js).
// Run with: node --test tests/

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./load-app");

const app = loadApp();
// Arrays made inside the sandbox have its own Array prototype, so compare them as plain JSON.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A league-wide value curve, best first, roughly like KTC's: 400 players from ~10,000 down.
const curve = Array.from({ length: 400 }, (_, i) => Math.round(10000 * Math.exp(-i / 90)));
const ctx = (teams = 12, extra = {}) => ({ topValue: curve[0], playerValues: curve, teams, raw: false, ...extra });

test("evaluateTrade: one-for-one at equal value is fair", () => {
  const r = app.evaluateTrade([[5000], [5000]], ctx());
  assert.equal(r.verdict, "fair");
  assert.ok(Math.abs(r.gap) < 1);
});

test("evaluateTrade: an empty side is incomplete", () => {
  assert.equal(app.evaluateTrade([[5000], []], ctx()).verdict, "incomplete");
});

test("evaluateTrade: a 2-for-1 of equal raw value favors the 1 side", () => {
  // A gets one 6,000 player, B gets two 3,000 players.
  const r = app.evaluateTrade([[6000], [3000, 3000]], ctx());
  assert.equal(r.winner, 0);
  assert.ok(r.stud[0] > 0 && r.credit[0] > 0);
});

test("evaluateTrade: four mid players don't beat a star on volume", () => {
  const r = app.evaluateTrade([[9000], [2500, 2500, 2500, 2500]], ctx());
  assert.equal(r.winner, 0);
});

test("evaluateTrade: bigger leagues give a smaller roster spot credit", () => {
  const small = app.evaluateTrade([[6000], [3000, 3000]], ctx(8));
  const big = app.evaluateTrade([[6000], [3000, 3000]], ctx(14));
  assert.ok(small.credit[0] > big.credit[0]);
});

test("evaluateTrade: raw values turn both adjustments off", () => {
  const r = app.evaluateTrade([[6000], [3000, 3000]], ctx(12, { raw: true }));
  assert.deepEqual(plain(r.stud), [0, 0]);
  assert.deepEqual(plain(r.credit), [0, 0]);
  assert.equal(r.verdict, "fair");
});

test("irReturnWeek: four team games from the start of the stint, skipping the bye", () => {
  const byes = app.BYE_WEEKS;
  const team = Object.keys(byes).find((t) => byes[t] === 7);
  // Out from Week 5: games in 5, 6, 8, 9 (7 is the bye), back for Week 10.
  assert.equal(app.irReturnWeek({ sinceWeek: 5 }, team), 10);
  // No bye in the way: 1, 2, 3, 4, back Week 5.
  assert.equal(app.irReturnWeek({ sinceWeek: 1 }, team), 5);
  assert.equal(app.irReturnWeek({ sinceWeek: 3, seasonEnding: true }, team), null);
});

test("settingsFromLeague reads format, QB, size, scoring and TE premium", () => {
  const s = app.settingsFromLeague({
    settings: { type: 2 }, total_rosters: 11, roster_positions: ["QB", "RB", "WR", "SUPER_FLEX"],
    scoring_settings: { rec: 0.5, bonus_rec_te: 0.75 },
  });
  assert.equal(s.mode, "dynasty");
  assert.equal(s.qb, "sf");
  assert.equal(s.teams, 10); // nearest option to 11, ties go to the first
  assert.equal(s.ppr, 0.5);
  assert.equal(s.tep, 0.5);
  assert.equal(app.settingsFromLeague({ settings: { type: 3 }, roster_positions: ["QB"] }).mode, "redraft");
  assert.equal(app.settingsFromLeague({ settings: { type: 0 }, roster_positions: ["QB", "QB"] }).qb, "sf");
});

test("normalCdf and winOdds", () => {
  assert.ok(Math.abs(app.normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(app.normalCdf(1.96) - 0.975) < 1e-3);
  assert.equal(app.winOdds({ mean: 100, open: 0 }, { mean: 90, open: 0 }), 1);
  const even = app.winOdds({ mean: 100, open: 100 }, { mean: 100, open: 100 });
  assert.ok(Math.abs(even - 0.5) < 1e-6);
  const a = app.winOdds({ mean: 110, open: 100 }, { mean: 100, open: 100 });
  const b = app.winOdds({ mean: 100, open: 100 }, { mean: 110, open: 100 });
  assert.ok(Math.abs(a + b - 1) < 1e-6 && a > 0.5);
});

test("consensusVerdict uses the trade desk's thresholds", () => {
  assert.equal(app.consensusVerdict([0.02, -0.01]).verdict, "fair");
  assert.equal(app.consensusVerdict([0.1, 0.12]).verdict, "slight");
  const r = app.consensusVerdict([-0.3, -0.2]);
  assert.equal(r.verdict, "favors");
  assert.equal(r.winner, 1);
});

test("searchPlayers: word starts first, then contains, the more valuable player first", () => {
  const list = [
    { name: "Justin Jefferson", rank: 9000 },
    { name: "Van Jefferson", rank: 100 },
    { name: "Jeff Wilson", rank: 50 },
    { name: "Josh Allen", rank: 9500 },
  ].map((p) => ({ ...p, folded: app.foldName(p.name) }));
  const names = (q) => plain(app.searchPlayers(list, q).map((p) => p.name));
  assert.deepEqual(names("jef"), ["Justin Jefferson", "Van Jefferson", "Jeff Wilson"]);
  assert.deepEqual(names("jus jef"), ["Justin Jefferson"]);
  assert.deepEqual(names("efferso"), ["Justin Jefferson", "Van Jefferson"]);
  assert.deepEqual(names(""), []);
});

test("every page key has a style and a route", () => {
  for (const p of app.PAGES) {
    if (p.hidden || p.key === "home") continue;
    assert.ok(app.PAGE_STYLE[p.key], `PAGE_STYLE is missing ${p.key}`);
    assert.equal(app.pageFromHash(p.hash), p.key, `${p.hash} doesn't route to ${p.key}`);
  }
});

// A small league: week 1-4 scores for two backs on one team, with the starter hurt.
function waiverFixture() {
  const players = [
    { id: "sl-1", name: "Star Back", team: "DET", position: "RB", extra: true },
    { id: "sl-2", name: "Bench Back", team: "DET", position: "RB", extra: true },
  ];
  const scores = { 1: { "sl-1": 20 }, 2: { "sl-1": 22 }, 3: { "sl-2": 14 }, 4: { "sl-2": 16 } };
  const use = (snap, car, tgt) => ({ opp: "GB", snap, car, tgt });
  const details = { 1: { "sl-1": use(80, 20, 4) }, 2: { "sl-1": use(80, 20, 4) }, 3: { "sl-2": use(75, 18, 3) }, 4: { "sl-2": use(78, 19, 4) } };
  const teams = Object.keys(app.BYE_WEEKS);
  const teamsPlayed = Object.fromEntries([1, 2, 3, 4].map((w) => [w, teams.filter((t) => app.BYE_WEEKS[t] !== w)]));
  const sleeperPlayers = { 1: { name: "Star Back", position: "RB", team: "DET", status: "IR", injury: "Torn ACL" }, 2: { name: "Bench Back", position: "RB", team: "DET", status: null } };
  return { data: { scores, details, teamsPlayed, players }, sleeperPlayers, resolve: app.nflIdResolver(sleeperPlayers) };
}

test("waiverWeek: the week after the latest once it's been played", () => {
  const { data } = waiverFixture();
  assert.equal(app.waiverWeek(data), 5);
  assert.equal(app.waiverWeek({ ...data, teamsPlayed: { ...data.teamsPlayed, 4: ["DET"] } }), 4);
  assert.equal(app.waiverWeek({ scores: {}, teamsPlayed: {} }), null);
});

test("buildLivePicks: a backup who took over for an injured starter", () => {
  const { data, sleeperPlayers, resolve } = waiverFixture();
  const picks = app.buildLivePicks({ data, sleeperPlayers, resolve, adds: { 2: 50000 }, skip: () => false });
  assert.equal(picks.week, 5);
  assert.deepEqual(plain(picks.rows.map((r) => r.name)), ["Bench Back"]); // the starter is on IR, so he's left off
  const [r] = picks.rows;
  assert.match(r.note, /^Star Back is on IR \(torn acl\); snaps up from 0% to 77%/);
  assert.match(r.note, /added in 50,000 Sleeper leagues/);
  assert.equal(r.priority, "Must Add");
  assert.equal(app.buildLivePicks({ data, sleeperPlayers, resolve, adds: {}, skip: () => true }).rows.length, 0);
});

test("mergeInjuredList: adds Sleeper's IR players and drops hand entries who are active again", () => {
  const { data, sleeperPlayers, resolve } = waiverFixture();
  const list = app.mergeInjuredList({ pool: data.players, scores: data.scores, sleeperPlayers, resolve });
  const auto = list.filter((r) => r.auto);
  assert.deepEqual(plain(auto), [{ id: "sl-1", list: "IR", injury: "Torn ACL", sinceWeek: 3, seasonEnding: true, auto: true }]);
  // Nothing loaded from Sleeper yet: the hand-kept list as is.
  assert.equal(app.mergeInjuredList({ pool: data.players, scores: data.scores, sleeperPlayers: {}, resolve }), app.INJURED_RESERVE);
  // A hand-kept, not season-ending entry whose player is healthy again is dropped.
  const entry = app.INJURED_RESERVE.find((r) => !r.seasonEnding && !r.id.startsWith("sl-"));
  const p = app.samplePlayers.find((x) => x.id === entry.id);
  const healthy = { 99: { name: p.name, position: p.position, team: p.team, status: null } };
  const merged = app.mergeInjuredList({ pool: [p], scores: {}, sleeperPlayers: healthy, resolve: app.nflIdResolver(healthy) });
  assert.ok(!merged.some((r) => r.id === entry.id));
});

test("withCurrentTeams: a traded player takes Sleeper's team, others are left as is", () => {
  const pool = [
    { id: "a", name: "Traded Guy", team: "ARI", position: "WR" },
    { id: "b", name: "Stays Put", team: "DET", position: "RB" },
    { id: "c", name: "To Washington", team: "NYG", position: "TE" },
    { id: "sl-9", name: "Extra Guy", team: "BUF", position: "WR", extra: true },
  ];
  const sleeper = {
    1: { name: "Traded Guy", position: "WR", team: "HOU" },
    2: { name: "Stays Put", position: "RB", team: "DET" },
    3: { name: "To Washington", position: "TE", team: "WAS" },
    9: { name: "Extra Guy", position: "WR", team: "MIA" },
  };
  const out = app.withCurrentTeams(pool, sleeper, app.nflIdResolver(sleeper));
  assert.deepEqual(plain(out.map((p) => p.team)), ["HOU", "DET", "WSH", "BUF"]);
  assert.equal(out[1], pool[1]);
  // Nothing loaded yet, or nothing changed: the same array back.
  assert.equal(app.withCurrentTeams(pool, {}, app.nflIdResolver({})), pool);
  assert.equal(app.withCurrentTeams([pool[1]], sleeper, app.nflIdResolver(sleeper))[0], pool[1]);
});

test("SEASON_ENDING_INJURY reads Sleeper's injury text", () => {
  for (const t of ["Knee - ACL", "Torn ACL", "Achilles", "Knee - Patellar Tendon", "Foot - Lisfranc"]) assert.ok(app.SEASON_ENDING_INJURY.test(t), t);
  for (const t of ["Hamstring", "Knee - MCL", "Placement"]) assert.ok(!app.SEASON_ENDING_INJURY.test(t), t);
});

test("nbaLeagueTeams: record, points for and best-lineup value", () => {
  const league = { roster_positions: ["PG", "SG", "UTIL", "BN", "BN", "IR"] };
  const rows = [{ id: "1", value: 900, fpg: 40 }, { id: "2", value: 500, fpg: 30 }, { id: "3", value: 300, fpg: 20 }, { id: "4", value: 100, fpg: 10 }];
  const rosters = [
    { roster_id: 1, owner_id: "u1", players: ["4", "1", "2", "3"], settings: { wins: 3, losses: 1, fpts: 1200, fpts_decimal: 50 } },
    { roster_id: 2, owner_id: "u2", players: ["9"], settings: {} },
  ];
  const users = [{ user_id: "u1", display_name: "one", metadata: { team_name: "The Ones" } }, { user_id: "u2", display_name: "two" }];
  const { teams, slots } = app.nbaLeagueTeams({ league, rosters, users, rows, players: { 9: { name: "Nine", position: "C", team: "BOS" } } });
  assert.equal(slots, 3);
  assert.equal(teams[0].name, "The Ones");
  assert.equal(teams[0].value, 1700); // the best three: 900 + 500 + 300
  assert.equal(teams[0].pf, 1200.5);
  assert.deepEqual(plain(teams[0].players.map((p) => p.id)), ["1", "2", "3", "4"]);
  assert.equal(teams[1].name, "two");
  assert.equal(teams[1].players[0].name, "Nine"); // no games yet: no value, but named
  assert.equal(teams[1].value, 0);
});

test("nbaMatchupPairs: points so far plus games left, and odds that add up to 1", () => {
  const byId = { a: { team: "BOS", fpg: 40, avail: 1 }, b: { team: "LAL", fpg: 40, avail: 1 } };
  const games = { BOS: { left: 3 }, LAL: { left: 0 } };
  const matchups = [
    { roster_id: 1, matchup_id: 1, points: 100, starters: ["a"], players_points: { a: 100 } },
    { roster_id: 2, matchup_id: 1, points: 150, starters: ["b", "0"], players_points: { b: 150 } },
    { roster_id: 3, matchup_id: null, points: 0, starters: [] },
  ];
  const pairs = app.nbaMatchupPairs(matchups, byId, games);
  assert.equal(pairs.length, 1);
  const [x, y] = pairs[0];
  assert.equal(x.open, 120); // 40 a game × 3 games left
  assert.equal(x.mean, 220);
  assert.equal(y.open, 0);
  assert.equal(y.starters.length, 1); // empty slots ("0") are skipped
  assert.ok(x.odds > 0.5 && Math.abs(x.odds + y.odds - 1) < 1e-9);
});

test("nbaLeagueScoring keeps the stats the app has, else standard", () => {
  assert.deepEqual(plain(app.nbaLeagueScoring({ scoring_settings: { pts: 1, reb: 1.2, bonus_pt_40p: 2, dd: 1 } })), { pts: 1, reb: 1.2, dd: 1 });
  assert.equal(app.nbaLeagueScoring({}), "standard");
  assert.equal(app.nbaPoints({ pts: 10, reb: 5 }, { pts: 1, reb: 2 }), 20);
});

test("diffStatuses: a designation change is an alert, a first sighting isn't", () => {
  const players = { 1: { name: "A", status: "Out", injury: "Ankle" }, 2: { name: "B", status: null }, 3: { name: "C", status: "Questionable" } };
  const seen = { "nfl:1": "Questionable", "nfl:2": "IR", "nfl:9": "Out" };
  const { changes, next } = app.diffStatuses("nfl", new Set(["1", "2", "3"]), players, seen);
  assert.deepEqual(plain(changes.map((c) => [c.name, c.from, c.to])), [["A", "Questionable", "Out"], ["B", "IR", null]]);
  assert.deepEqual(plain(next), { "nfl:1": "Out", "nfl:2": null, "nfl:3": "Questionable" });
  assert.equal(app.alertStatusLabel(null), "Active");
  assert.equal(app.alertStatusLabel("GTD"), "Game-time decision");
});

test("prospectHeadline: one line per position, and prospect pages route", () => {
  const wr = { year: 2026, g: 7, rec: 52, recYds: 984, recTd: 12, shares: { dominator: 49 } };
  assert.deepEqual(plain(app.prospectHeadline("WR", wr)), { line: "52-984-12", sub: "49% dominator", season: "2026 · 7 G" });
  const qb = { year: 2026, g: 7, passYds: 2151, passTd: 22, int: 1, qbr: 89.8 };
  assert.equal(app.prospectHeadline("QB", qb).line, "2,151 yds, 22 TD, 1 INT");
  assert.equal(app.prospectHeadline("RB", { year: 2026, car: 135, rushYds: 763, rushTd: 13 }).sub, null);
  assert.equal(app.pageFromHash("#/prospect/5079720"), "prospect");
});

test("likelyRosteredIds: established scorers before the last two weeks, not breakouts", () => {
  const players = [
    { id: "vet", name: "Vet", team: "DET", position: "WR" },
    { id: "breakout", name: "Breakout", team: "DET", position: "WR" },
  ];
  const scores = { 1: { vet: 20, breakout: 1 }, 2: { vet: 18, breakout: 2 }, 3: { vet: 19, breakout: 25 }, 4: { vet: 21, breakout: 24 } };
  const ids = app.likelyRosteredIds({ players, scores });
  assert.ok(ids.has("vet"));
  assert.ok(ids.has("breakout")); // only two players, so both are in the top 120
  const many = Array.from({ length: 130 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, team: "DET", position: "RB" }));
  const sc = {};
  for (const w of [1, 2, 3, 4]) sc[w] = Object.fromEntries(many.map((p, i) => [p.id, w <= 2 ? 30 - i * 0.2 : 5]));
  sc[3].late = 30; sc[4].late = 30; sc[1].late = 1; sc[2].late = 1;
  const top = app.likelyRosteredIds({ players: [...many, { id: "late", name: "Late", team: "DET", position: "RB" }], scores: sc });
  assert.equal(top.size, 120);
  assert.ok(top.has("p0"));
  assert.ok(!top.has("late")); // a breakout in the last two weeks isn't counted as rostered
});

test("tradeMovers: biggest risers and fallers worth a roster spot", () => {
  const row = (id, value, trend30, position = "WR") => ({ id, name: id, position, value, trend30 });
  const m = app.tradeMovers([row("up", 5000, 900), row("up2", 3000, 300), row("down", 6000, -800), row("cheap", 900, 2000), row("pick", 4000, 999, "PICK")]);
  assert.deepEqual(plain(m.rising.map((r) => r.id)), ["up", "up2"]);
  assert.deepEqual(plain(m.falling.map((r) => r.id)), ["down"]);
});

test("valuedIds: top players by redraft value, picks left out", () => {
  const rows = Array.from({ length: 160 }, (_, i) => ({ id: `${i}`, position: "WR", value: 9000 - i, redraftValue: i }));
  rows.push({ id: "pick", position: "PICK", value: 99999, redraftValue: 99999 });
  const ids = app.valuedIds(rows);
  assert.equal(ids.size, 150);
  assert.ok(ids.has("159") && !ids.has("0") && !ids.has("pick")); // ranked by redraftValue, not dynasty value
});

test("tradeBlock: starter-level veterans by PPG for contenders, young players for rebuilders", () => {
  const row = (id, position, age, value, redraftValue, trend30 = 0) => ({ id, name: id, position, age, value, redraftValue, trend30, posRank: 1 });
  const rows = [
    row("star", "WR", 23, 9000, 8000),
    row("vet", "WR", 29, 4000, 5000), row("vetSlow", "WR", 30, 4000, 5000), row("vetPricey", "WR", 28, 6000, 5000),
    row("hurt", "WR", 27, 4000, 6000),
  ];
  const ppg = { vet: { ppg: 18, gp: 7, rank: 5 }, vetSlow: { ppg: 6, gp: 7, rank: 80 }, vetPricey: { ppg: 20, gp: 7, rank: 3 }, star: { ppg: 15, gp: 7, rank: 12 } };
  const sidelined = (r) => (r.id === "hurt" ? { longTerm: true } : null);
  const wr = (b) => b.find((p) => p.pos === "WR");
  const withStats = wr(app.tradeBlock(rows, sidelined, new Set(), ppg, 12));
  assert.deepEqual(plain(withStats.winNow.map((r) => r.id)), ["vet"]); // starter PPG, cheaper in dynasty, healthy
  assert.equal(withStats.winNow[0].stat.ppg, 18);
  assert.deepEqual(plain(withStats.youth.map((r) => r.id)), ["star"]);
  // Before stats load: worth 10%+ more this season than in dynasty, by redraft value.
  const noStats = wr(app.tradeBlock(rows, sidelined, new Set()));
  assert.deepEqual(plain(noStats.winNow.map((r) => r.id)), ["vet", "vetSlow"]);
});

test("teamHeadline: a streak, points rank and dynasty standouts, at most three", () => {
  const team = (rosterId, pf, ages, picks, trend30) => ({
    rosterId, record: { wins: 1, losses: 1, ties: 0, pf },
    lineup: ages.map((age) => ({ player: { age } })),
    assets: [{ position: "WR", value: 5000, trend30 }, ...Array.from({ length: picks }, () => ({ position: "PICK", name: "2027 1st", value: 3000 }))],
  });
  const a = team(1, 900, [22, 23], 5, 800), b = team(2, 800, [28, 29], 1, -100), c = team(3, 700, [26, 26], 2, 0);
  const facts = app.teamHeadline(a, [a, b, c], { streak: "3W", standing: { playoffs: 0.8 }, isDynasty: true, hasRecord: true });
  assert.deepEqual(plain(facts), ["3-game win streak", "1st in points scored", "80% playoff odds"]);
  const old = app.teamHeadline(b, [a, b, c], { streak: "1L", standing: null, isDynasty: true, hasRecord: false });
  assert.deepEqual(plain(old), ["Oldest lineup in the league"]);
});

test("teamValueSeries: weekly sums, a rookie counting his first value", () => {
  const history = { dates: ["d1", "d2", "d3"], players: { sf: { a: { ktc: [100, 110, 120] }, b: { ktc: [null, 50, 60] } } } };
  const team = { assets: [{ id: "a", position: "WR" }, { id: "b", position: "RB" }, { id: "p", position: "PICK" }] };
  assert.deepEqual(plain(app.teamValueSeries(team, history, "sf", 2)), [{ t: "d2", v: 160 }, { t: "d3", v: 180 }]);
  assert.deepEqual(plain(app.teamValueSeries(team, history, "sf").map((p) => p.v)), [150, 160, 180]);
  assert.deepEqual(plain(app.teamValueSeries(team, null, "sf")), []);
});

test("valueTrade: what each side got, with a verdict for two teams", () => {
  const teams = [{ rosterId: 1, name: "A" }, { rosterId: 2, name: "B" }];
  const byId = { x: { id: "x", name: "X", position: "WR", value: 6000 }, y: { id: "y", name: "Y", position: "RB", value: 2000 } };
  const pickRow = (year, round) => ({ id: `pick-${year}-${round}`, value: round === 1 ? 3000 : 1000 });
  const ctx = { topValue: 10000, playerValues: [10000, 6000, 2000], teams: 12 };
  const tx = { transaction_id: "t", roster_ids: [1, 2], adds: { x: 1, y: 2 }, draft_picks: [{ season: "2027", round: 1, owner_id: 2 }], status_updated: 5 };
  const tr = app.valueTrade(tx, teams, byId, pickRow, ctx);
  assert.deepEqual(plain(tr.sides.map((s) => [s.name, s.total, s.gets.map((g) => g.name)])), [["A", 6000, ["X"]], ["B", 5000, ["2027 1st", "Y"]]]);
  assert.ok(tr.result && ["fair", "slight", "favors"].includes(tr.result.verdict));
});

test("sinceLastVisit: value, rank and record changes", () => {
  const prev = { total: 100000, rank: 5, wins: 2, losses: 3, ties: 0 };
  const now = { total: 103000, rank: 4, wins: 3, losses: 3, ties: 0 };
  assert.deepEqual(plain(app.sinceLastVisit(prev, now).map((c) => c.text)), ["value ▲ 3.0%", "roster rank 5th → 4th", "went 1-0"]);
  assert.deepEqual(plain(app.sinceLastVisit(prev, prev)), []);
  assert.deepEqual(plain(app.sinceLastVisit(null, now)), []);
});

test("returnWatch: stints that open this week or next, plus IR players back at practice", () => {
  const byes = app.BYE_WEEKS;
  const team = Object.keys(byes).find((t) => byes[t] === 7);
  const byId = Object.fromEntries(["a", "b", "c", "d", "e"].map((id) => [id, { id, name: id.toUpperCase(), team, position: "WR" }]));
  const injured = [
    { id: "a", list: "IR", injury: "Knee", sinceWeek: 5 }, // games 5, 6, 8, 9 (bye 7): back Week 10
    { id: "b", list: "IR", injury: "Ankle", sinceWeek: 6 }, // 6, 8, 9, 10: back Week 11
    { id: "c", list: "IR", injury: "Hamstring", sinceWeek: 8 }, // back Week 12: too far off
    { id: "d", list: "IR", injury: "Torn ACL", sinceWeek: 2, seasonEnding: true },
    { id: "e", list: "IR", injury: "Foot", sinceWeek: 8 }, // too far off, but practicing again
  ];
  const statuses = { e: "Questionable", d: "Questionable" };
  const rows = app.returnWatch(injured, byId, 10, (p) => ({ status: statuses[p.id] || "IR" }));
  assert.deepEqual(plain(rows.map((r) => [r.id, r.back, r.practicing])), [["e", 12, true], ["a", 10, false], ["b", 11, false]]);
});

test("mineFirst: your players first, order kept within each group", () => {
  const rows = ["a", "b", "c", "d"];
  assert.deepEqual(plain(app.mineFirst(rows, (r) => r === "c" || r === "a")), ["a", "c", "b", "d"]);
});

test("checkInjuries: flags entries Sleeper or the scores disagree with", () => {
  const { checkInjuries, upcomingWeek } = require("../scripts/check-injuries");
  const pool = [
    { id: "healed", name: "Healed", team: "DET", position: "WR" },
    { id: "played", name: "Played", team: "DET", position: "RB" },
    { id: "late", name: "Late", team: "DET", position: "TE" },
    { id: "fine", name: "Fine", team: "DET", position: "WR" },
    { id: "missing", name: "Missing", team: "DET", position: "RB" },
  ];
  const list = [
    { id: "healed", list: "IR", injury: "Ankle sprain", sinceWeek: 1 },
    { id: "played", list: "IR", injury: "Knee", sinceWeek: 3 },
    { id: "late", list: "IR", injury: "Foot (fracture)", sinceWeek: 1 },
    { id: "fine", list: "IR", injury: "Torn ACL", sinceWeek: 2, seasonEnding: true },
    { id: "ghost", list: "IR", injury: "Hip", sinceWeek: 4 },
  ];
  const sleeper = {
    1: { status: null }, 2: { status: "IR" }, 3: { status: "IR" }, 4: { status: "IR" }, 5: { status: "IR", injury: "Wrist" },
  };
  const sid = { healed: "1", played: "2", late: "3", fine: "4", missing: "5" };
  const result = checkInjuries({
    list, pool, sleeper, scores: { 4: { played: 12.3, healed: 8.1 } }, week: 9,
    resolve: (id) => sid[id], returnWeek: (r) => (r.seasonEnding ? null : r.sinceWeek + 4),
  });
  const ids = (k) => plain(result[k].map((r) => r.id));
  assert.deepEqual(ids("activeAgain"), ["healed"]);
  // A healthy player who has played since (and is past his return week) shows up once.
  assert.match(result.activeAgain[0].detail, /scored in Wk 4/);
  assert.deepEqual(ids("scoredSince"), ["played"]);
  assert.deepEqual(ids("pastReturn"), ["late"]);
  assert.deepEqual(ids("notListed"), ["missing"]);
  assert.deepEqual(ids("vague"), ["played"]);
  assert.deepEqual(ids("unknown"), ["ghost"]);

  // The upcoming week moves on once most teams have played the latest one.
  const teams = Array.from({ length: 28 }, (_, i) => ({ id: `p${i}`, team: `T${i}` }));
  const week = (n) => Object.fromEntries(teams.slice(0, n).map((p) => [p.id, 1]));
  assert.equal(upcomingWeek({ 8: week(28) }, teams), 9);
  assert.equal(upcomingWeek({ 8: week(28), 9: week(4) }, teams), 9);
});

const faabLeague = (extra = {}) => ({ settings: { waiver_type: 2, waiver_budget: 100, leg: 8, playoff_week_start: 15, ...extra } });
// A league that's spent exactly at an even pace by Week 8: 7 of 14 weeks left, so $50 each.
const faabRosters = (used = 50) => [
  { owner_id: "me", settings: { waiver_budget_used: used } },
  { owner_id: "them", settings: { waiver_budget_used: used } },
];
const wonBid = (bid, extra = {}) => ({ type: "waiver", status: "complete", settings: { waiver_bid: bid }, ...extra });

test("faabMarket: only FAAB leagues, with what's left and only won, paid bids", () => {
  assert.equal(app.faabMarket({ league: faabLeague({ waiver_type: 0 }), rosters: [], txs: [], userId: "me" }), null);
  assert.equal(app.faabMarket({ league: faabLeague({ waiver_budget: 0 }), rosters: [], txs: [], userId: "me" }), null);
  const m = app.faabMarket({
    league: faabLeague(),
    rosters: [{ owner_id: "me", settings: { waiver_budget_used: 80 } }, { owner_id: "them", settings: { waiver_budget_used: 20 } }],
    txs: [wonBid(9), wonBid(3), wonBid(0), wonBid(50, { status: "failed" }), { type: "free_agent", status: "complete", settings: {} }],
    userId: "me",
  });
  assert.equal(m.remaining, 20);
  assert.equal(m.topOther, 80);
  assert.equal(m.avgLeft, 50);
  assert.equal(m.pace, 1);
  assert.deepEqual(plain(m.bids), [3, 9]);
});

test("faabMarket: leftover money raises the pace and a spent league lowers it, within limits", () => {
  assert.equal(app.faabMarket({ league: faabLeague(), rosters: faabRosters(0), txs: [], userId: "me" }).pace, 1.5);
  assert.equal(app.faabMarket({ league: faabLeague(), rosters: faabRosters(95), txs: [], userId: "me" }).pace, 0.75);
});

test("faabBid: a share of the budget until the league has enough bids, then the league's own", () => {
  const few = app.faabMarket({ league: faabLeague(), rosters: faabRosters(), txs: [wonBid(90)], userId: "me" });
  assert.deepEqual(plain(app.faabBid("Must Add", few)), { low: 15, high: 30, fromLeague: false, capped: false });
  // Eight winning bids of $1 to $8.
  const known = app.faabMarket({ league: faabLeague(), rosters: faabRosters(), txs: [1, 2, 3, 4, 5, 6, 7, 8].map((b) => wonBid(b)), userId: "me" });
  const must = app.faabBid("Must Add", known);
  assert.equal(must.fromLeague, true);
  assert.deepEqual([must.low, must.high], [6, 8]);
  const deep = app.faabBid("Deep League", known);
  assert.ok(deep.high < must.low, "lower tiers bid less");
});

test("faabBid: never more than you have, never an inverted range, and a percent with no league", () => {
  const broke = app.faabMarket({ league: faabLeague(), rosters: [{ owner_id: "me", settings: { waiver_budget_used: 96 } }, { owner_id: "them", settings: { waiver_budget_used: 0 } }], txs: [], userId: "me" });
  const b = app.faabBid("Must Add", broke);
  assert.equal(b.capped, true);
  assert.equal(b.high, 4);
  assert.ok(b.low <= b.high);
  assert.deepEqual(plain(app.faabBid("Must Add", null)), { low: 15, high: 30, percent: true });
  assert.equal(app.faabBid("Unknown tier", null), null);
  assert.equal(app.faabLabel({ low: 6, high: 8 }), "Bid $6-8");
  assert.equal(app.faabLabel({ low: 4, high: 4 }), "Bid $4");
  assert.equal(app.faabLabel({ low: 15, high: 30, percent: true }), "Bid 15-30% of FAAB");
});

test("playoffWeeks: rounds from the playoff teams and round type, within the season", () => {
  assert.deepEqual(plain(app.playoffWeeks(null)), [15, 16, 17]);
  const weeks = (s) => plain(app.playoffWeeks({ settings: s }));
  assert.deepEqual(weeks({ playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 0 }), [15, 16, 17]);
  assert.deepEqual(weeks({ playoff_week_start: 15, playoff_teams: 4, playoff_round_type: 1 }), [15, 16, 17]);
  assert.deepEqual(weeks({ playoff_week_start: 14, playoff_teams: 8, playoff_round_type: 0 }), [14, 15, 16]);
  assert.deepEqual(weeks({ playoff_week_start: 15, playoff_teams: 6, playoff_round_type: 2 }), [15, 16, 17, 18]);
});

test("playoffOutlook: rates a schedule by the defenses a position faces", () => {
  const def = (rank) => ({ WR: { rank, avg: 30 - rank / 2, of: 32 } });
  const ranks = { EASY: def(2), SOFT: def(6), MID: def(16), HARD: def(30), WALL: def(31) };
  const game = (opp, home = true) => ({ opp, home, date: "2026-12-20" });
  const schedule = {
    15: { WSH: game("EASY"), DAL: game("HARD") },
    16: { WSH: game("SOFT", false), DAL: game("WALL") },
    17: { DAL: game("MID") },
  };
  const good = app.playoffOutlook("WAS", "WR", [15, 16, 17], schedule, ranks); // WAS is the same team as WSH
  assert.equal(good.label, "Good");
  assert.equal(good.avgRank, 4);
  assert.equal(good.games[0].tag.label, "Good");
  assert.equal(good.games[1].home, false);
  assert.equal(good.games[2].bye, true);
  assert.equal(app.playoffOutlook("DAL", "WR", [15, 16], schedule, ranks).label, "Tough");
  assert.equal(app.playoffOutlook("DAL", "WR", [17], schedule, ranks).label, "Neutral");
  // Before stats load: the opponents, no rating. Before the schedule loads, or with no team: nothing.
  const unrated = app.playoffOutlook("DAL", "WR", [15], schedule, {});
  assert.equal(unrated.label, null);
  assert.equal(unrated.games[0].opp, "HARD");
  assert.equal(app.playoffOutlook("DAL", "WR", [15], {}, ranks), null);
  assert.equal(app.playoffOutlook(null, "WR", [15], schedule, ranks), null);
});

test("nbaReturnEstimate: the report's words beat ESPN's date", () => {
  const entry = (date, shortComment, extra = {}) => ({
    date: "2026-11-03T22:00Z", shortComment, longComment: "",
    details: { returnDate: date, fantasyStatus: { abbreviation: "OUT" }, ...extra },
  });
  const today = "2026-11-04";
  const est = app.nbaReturnEstimate(entry("2026-11-06", "Landale is out with a left hip strain."), today);
  assert.equal(est.kind, "date");
  assert.equal(est.days, 2);
  assert.equal(app.nbaReturnEstimate(entry("2027-07-01", "Torn ACL.", { fantasyStatus: { abbreviation: "OFS" } }), today).kind, "season");
  assert.equal(app.nbaReturnEstimate(entry("2026-11-08", "Carter is without a timetable for a return."), today).kind, "none");
  // A stated timeline well past the date replaces it...
  const gueye = app.nbaReturnEstimate(entry("2026-11-20", "Gueye will be re-evaluated by medical staff in 3-to-4 months."), today);
  assert.equal(gueye.kind, "stated");
  assert.equal(app.nbaReturnLabel(gueye), "Re-evaluation in 3-to-4 months");
  // ...and one that agrees with it stays beside the date.
  const duren = app.nbaReturnEstimate(entry("2026-11-17", "Duren will be re-evaluated in two weeks."), today);
  assert.equal(duren.kind, "date");
  assert.equal(duren.stated.label, "Re-evaluation in two weeks");
  assert.equal(app.nbaReturnEstimate({ details: {} }, today), null);
  // A teammate's timeline in the long comment isn't this player's.
  const teammate = entry("2027-01-02", "Sheppard will miss months after knee surgery.");
  teammate.longComment = "With Tyrese Haliburton (hamstring) expected to miss at least two weeks, Jackson should play more.";
  assert.equal(app.nbaReturnEstimate(teammate, today).stated, null);
  const noDate = entry("2027-01-02", "Sheppard had surgery.");
  noDate.longComment = "Sheppard is without a definitive timetable for a return.";
  assert.equal(app.nbaReturnEstimate(noDate, today).kind, "none");
});

test("statedTimeline: ranges and words, not other numbers", () => {
  assert.equal(app.statedTimeline("will miss at least 8-10 weeks").label, "Expected out 8-10 weeks");
  assert.equal(app.statedTimeline("will miss at least 8-10 weeks").days, 56);
  assert.equal(app.statedTimeline("is expected to miss six months").days, 180);
  assert.equal(app.statedTimeline("re-evaluated in one week").label, "Re-evaluation in one week");
  assert.equal(app.statedTimeline("will miss his third straight game"), null);
  assert.equal(app.statedTimeline("averaged 12 points over two weeks"), null);
  assert.equal(app.statedTimeline(""), null);
});

test("nbaReturnLabel and name keys", () => {
  assert.equal(app.nbaReturnLabel(null), "–");
  assert.equal(app.nbaReturnLabel({ kind: "season" }), "Out for season");
  assert.equal(app.nbaReturnLabel({ kind: "date", date: "2026-11-01", days: -3 }), "Estimate passed");
  assert.match(app.nbaReturnLabel({ kind: "date", date: "2026-11-20", days: 16 }), /· 2 weeks$/);
  assert.match(app.nbaReturnLabel({ kind: "date", date: "2026-11-04", days: 0 }), /· today$/);
  assert.equal(app.nbaNameKey("Kristaps Porziņģis"), app.nbaNameKey("Kristaps Porzingis"));
  assert.equal(app.nbaNameKey("Jimmy Butler III"), app.nbaNameKey("Jimmy Butler"));
  assert.equal(app.nbaNameKey("Yanic Konan Niederhäuser"), app.nbaNameKey("Yanic Konan Niederhauser"));
});

test("leagueWaiverCall: re-tiers and tags a waiver target for the league's format", () => {
  const base = { isDynasty: false, superflex: false, tep: 0, teams: 12, keeper: () => false, roomRank: () => null };
  const qb = { id: "q", name: "Q", position: "QB", priority: "Streamer" };
  // Redraft 1QB: unchanged.
  assert.equal(app.leagueWaiverCall(qb, base).priority, "Streamer");
  // Superflex moves a QB up a tier and says why.
  const sf = app.leagueWaiverCall(qb, { ...base, superflex: true });
  assert.equal(sf.priority, "Speculative");
  assert.deepEqual(plain(sf.tags), ["Superflex QB"]);
  // Dynasty: a keeper moves up (never past Must Add); a low-value streamer is a rental.
  const must = { id: "m", name: "M", position: "WR", priority: "Must Add" };
  assert.equal(app.leagueWaiverCall(must, { ...base, isDynasty: true, keeper: () => true }).priority, "Must Add");
  assert.deepEqual(plain(app.leagueWaiverCall(qb, { ...base, isDynasty: true }).tags), ["Short-term only"]);
  // A bottom-third room gets flagged; a middling one doesn't.
  const rb = { id: "r", name: "R", position: "RB", priority: "Deep League" };
  assert.deepEqual(plain(app.leagueWaiverCall(rb, { ...base, roomRank: () => 11 }).tags), ["Your RB room: 11th of 12"]);
  assert.deepEqual(plain(app.leagueWaiverCall(rb, { ...base, roomRank: () => 6 }).tags), []);
});

test("leagueWaiverTips and bestAvailable follow the league", () => {
  const league = (settings, extra = {}) => ({ total_rosters: 12, settings, scoring_settings: { rec: 1 }, roster_positions: ["QB", "RB"], ...extra });
  const redraft = app.leagueWaiverTips(league({ type: 0, waiver_type: 0 }), { isDynasty: false });
  assert.match(redraft[0], /^Redraft/);
  assert.ok(redraft.some((t) => /Waiver priority/.test(t)));
  const dyn = app.leagueWaiverTips(league({ type: 2, waiver_type: 2, best_ball: 1 }, { roster_positions: ["QB", "SUPER_FLEX"] }), { isDynasty: true });
  assert.match(dyn[0], /^Dynasty/);
  assert.ok(dyn.some((t) => /^Best ball/.test(t)) && dyn.some((t) => /^Superflex/.test(t)) && dyn.some((t) => /^FAAB/.test(t)));

  const rows = [
    { id: "1", position: "RB", value: 900, redraftValue: 100 },
    { id: "2", position: "WR", value: 500, redraftValue: 800 },
    { id: "3", position: "WR", value: 700, redraftValue: 700 },
    { id: "9", position: "PICK", value: 5000 },
  ];
  const ids = (opts) => plain(app.bestAvailable(rows, { 3: "Team" }, opts).map((r) => r.id));
  assert.deepEqual(ids({ isDynasty: true }), ["1", "2"]);
  assert.deepEqual(ids({ isDynasty: false }), ["2", "1"]);
  assert.deepEqual(ids({ isDynasty: true, skip: (r) => r.id === "1" }), ["2"]);
});

test("nbaGridRows: weekly totals, season total and points per game", () => {
  const scoring = { pts: 1 };
  const g = (pts) => ({ date: "2026-10-20", stats: { pts } });
  const weeks = [
    [{ id: "a", name: "A", position: "PG", team: "BOS", games: [g(10), g(20)] }, { id: "b", name: "B", position: "C", team: "NYK", games: [g(50)] }],
    null,
    [{ id: "a", name: "A", position: "PG", team: "LAL", games: [g(30)] }],
  ];
  const rows = plain(app.nbaGridRows(weeks, { scoring }));
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.equal(rows[0].ttl, 60);
  assert.equal(rows[0].avg, 20);
  assert.equal(rows[0].team, "LAL");
  assert.deepEqual(rows[0].cells, [{ pts: 30, gp: 2 }, null, { pts: 30, gp: 1 }]);
  assert.deepEqual(plain(app.nbaGridRows(weeks, { scoring, sortBy: "avg" })).map((r) => r.id), ["b", "a"]);
  assert.deepEqual(plain(app.nbaGridRows(weeks, { scoring, pos: "C" })).map((r) => r.id), ["b"]);
});
