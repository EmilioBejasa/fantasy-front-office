// The football Trade Market (data/nfl-market.js, by
// scripts/refresh-nfl-market.js): the site's own dynasty and redraft values,
// fit from real trades in public Sleeper football leagues with the same
// formula as the basketball market (lib/nba-market.js: a side is worth
// (Σ v^α)^(1/α), each trade's ln-ratio miss is Huber-scored and weighted by
// recency, and every asset is pulled toward its model value). What's
// football-specific is here: the four formats, how a trade is read, and the
// model (the prior).
//
// Formats: "dynasty-1qb", "dynasty-sf", "redraft-1qb", "redraft-sf". A league
// is Superflex if its lineup has a SUPER_FLEX slot or two QB slots. Keeper
// leagues count half, and so do TE-premium leagues (the page adds TE premium
// on top of the values itself). Draft picks are dynasty-only, keyed by how
// many rookie drafts away they were when traded ("pick-1-1" is the next
// draft's 1st), so last season's trades count for this year's picks too.
//
// Plain functions with no network, so tests can run them.

const N = require("./nba-market");

const FORMATS = ["dynasty-1qb", "dynasty-sf", "redraft-1qb", "redraft-sf"];
const HALF_LIFE = { dynasty: 45, redraft: 21 }; // days
const KEEPER_WEIGHT = 0.5;
const TEP_WEIGHT = 0.5;
const ROUNDS = 4;
const SKILL = ["QB", "RB", "WR", "TE"];
const SEASON_GAMES = 17;
// Rookie drafts are over by September; a trade before then in a league's
// season is still ahead of that season's draft.
const DRAFT_MONTH = 8; // September (0-based)

const modeOf = (format) => format.split("-")[0];

// League summary fields football needs (kept in the crawl state).
function leagueExtra(l) {
  const slots = l.roster_positions || [];
  const qbs = slots.filter((p) => p === "QB").length;
  return {
    qb: slots.includes("SUPER_FLEX") || qbs >= 2 ? "sf" : "1qb",
    tep: Number(l.scoring_settings?.bonus_rec_te) || 0,
  };
}

const formatOf = (league) => {
  const mode = league.type === 2 || league.type === 1 ? "dynasty" : league.type === 0 ? "redraft" : null;
  return mode && league.qb ? `${mode}-${league.qb}` : null;
};

// Rookie drafts between the trade and a pick's draft: 1 for the next one.
function draftsAway(pickSeason, leagueSeason, ts) {
  const beforeDraft = new Date(ts).getUTCFullYear() === Number(leagueSeason) && new Date(ts).getUTCMonth() < DRAFT_MONTH;
  return Number(pickSeason) - Number(leagueSeason) + (beforeDraft ? 1 : 0);
}

// One Sleeper transaction → a trade, or null. league: the crawl's league
// summary ({ id, type, size, season, qb, tep }).
function parseTrade(tx, league) {
  if (!tx || tx.type !== "trade" || tx.status !== "complete") return null;
  const format = formatOf(league);
  if (!format) return null;
  const rosters = tx.roster_ids || [];
  if (rosters.length !== 2) return null; // three-team trades have no clear "fair"
  const ts = tx.status_updated || tx.created;
  const sides = rosters.map((r) => ({ roster: r, ids: [] }));
  const side = (r) => sides.find((s) => s.roster === r);
  for (const [pid, r] of Object.entries(tx.adds || {})) side(r)?.ids.push(String(pid));
  if (modeOf(format) === "dynasty") {
    for (const p of tx.draft_picks || []) {
      const out = draftsAway(p.season, league.season, ts);
      if (out < 1 || out > 3 || !(p.round >= 1 && p.round <= ROUNDS)) continue;
      side(p.owner_id)?.ids.push(N.pickKey(out, p.round));
    }
  }
  let weight = league.type === 1 ? KEEPER_WEIGHT : 1;
  if (league.tep > 0) weight *= TEP_WEIGHT;
  return {
    id: String(tx.transaction_id), ts, format, weight,
    league: String(league.id), size: league.size || 12, season: String(league.season),
    sides: sides.map((s) => s.ids),
  };
}

// The year of the next rookie draft, as of `now`.
const nextDraftYear = (now = Date.now()) => {
  const d = new Date(now);
  return d.getUTCMonth() < DRAFT_MONTH ? d.getUTCFullYear() : d.getUTCFullYear() + 1;
};
// "pick-1-1" → { year: 2027, round: 1, label: "2027 1st" } (in the 2026 season).
function pickInfo(id, now = Date.now()) {
  const [, out, round] = String(id).split("-").map(Number);
  const year = nextDraftYear(now) + out - 1;
  const nth = ["", "1st", "2nd", "3rd"][round] || `${round}th`;
  return { year, round, label: `${year} ${nth}` };
}

// Model inputs per player: { id: { ppg, avail, age, position, name, team } }.
// players: data/nfl-players.js's map (rostered QB/RB/WR/TE with ages).
// cur, prev: { id: { gp, pts } } PPR season totals, this season and last.
// This season is blended with last (last counts as BLEND − games this season
// games), so a hot or cold month doesn't swing the model; without last
// season, a positional rookie baseline fills in instead.
const BLEND = 8;
const ROOKIE_PPG = { QB: 12, RB: 8, WR: 7, TE: 5 };
function playerInputs({ players, cur, prev }) {
  const teamGames = Math.max(1, ...Object.values(cur).map((s) => s.gp || 0));
  const out = {};
  for (const [id, p] of Object.entries(players)) {
    if (!SKILL.includes(p.position)) continue;
    const c = cur[id], q = prev[id];
    const cgp = c?.gp || 0;
    const base = q && q.gp >= 3 ? q.pts / q.gp : ROOKIE_PPG[p.position] * (p.exp ? 0.8 : 1);
    const k = Math.max(0, BLEND - cgp);
    const ppg = cgp + k > 0 ? ((c?.pts || 0) + base * k) / (cgp + k) : base;
    const avail = Math.min(1, Math.max(0.5,
      teamGames >= 4 && cgp ? cgp / teamGames : q && q.gp ? q.gp / SEASON_GAMES : 0.85));
    out[id] = { ppg, avail, age: p.age || null, position: p.position, name: p.name, team: p.team };
  }
  return { players: out, teamGames };
}

// Production multiplier per year of age, by position (running backs peak
// and fade earliest, quarterbacks last).
const AGE_CURVE = {
  QB: (a) => (a <= 25 ? 1.05 : a <= 32 ? 1 : a <= 35 ? 0.95 : 0.85),
  RB: (a) => (a <= 23 ? 1.06 : a <= 25 ? 1 : a <= 26 ? 0.94 : a <= 27 ? 0.88 : 0.8),
  WR: (a) => (a <= 23 ? 1.07 : a <= 26 ? 1.02 : a <= 29 ? 1 : a <= 30 ? 0.94 : 0.86),
  TE: (a) => (a <= 24 ? 1.08 : a <= 27 ? 1.03 : a <= 30 ? 1 : 0.88),
};
function ageFactor(position, age, years) {
  if (!age || !AGE_CURVE[position]) return 1;
  let f = 1;
  for (let y = 0; y < years; y++) f *= AGE_CURVE[position](age + y);
  return f;
}

// Model values: { id: value }, points above a positional replacement level
// (a 12-team league's waiver wire; Superflex starts about twice as many QBs).
// Redraft: per game above replacement × availability × games left.
// Dynasty: the same over DYNASTY_YEARS seasons with the age curve, each later
// season discounted, plus picks valued as the player at PICK_RANK.
const DYNASTY_YEARS = 4;
const DISCOUNT = 0.75;
const REPLACEMENT = { "1qb": { QB: 14, RB: 30, WR: 42, TE: 14 }, sf: { QB: 30, RB: 30, WR: 42, TE: 14 } };
const MIN_ABOVE = 0.3;
const FLOOR = 0.02;
// A pick's model value: the player at this overall rank, by drafts away and round.
const PICK_RANK = {
  1: { 1: 28, 2: 75, 3: 130, 4: 190 },
  2: { 1: 32, 2: 85, 3: 140, 4: 200 },
  3: { 1: 36, 2: 95, 3: 150, 4: 210 },
};
function priorValues(inputs, format, { week = 1 } = {}) {
  const [mode, qb] = format.split("-");
  const { players } = inputs;
  const repl = {};
  for (const pos of SKILL) {
    const ppgs = Object.values(players).filter((p) => p.position === pos).map((p) => p.ppg).sort((a, b) => b - a);
    repl[pos] = (ppgs[REPLACEMENT[qb][pos] - 1] || 5) * 0.95;
  }
  const gamesLeft = Math.max(SEASON_GAMES - Math.max(0, week - 1), 1);
  const out = {};
  for (const [id, p] of Object.entries(players)) {
    if (mode === "redraft") out[id] = Math.max(p.ppg - repl[p.position], MIN_ABOVE) * p.avail * gamesLeft;
    else {
      let total = 0;
      for (let y = 0; y < DYNASTY_YEARS; y++) {
        total += Math.max(p.ppg * ageFactor(p.position, p.age, y) - repl[p.position], MIN_ABOVE) * (y ? 0.9 : p.avail) * SEASON_GAMES * DISCOUNT ** y;
      }
      out[id] = total;
    }
  }
  const top = Math.max(...Object.values(out));
  for (const id in out) out[id] = Math.max(out[id], top * FLOOR);
  if (mode === "dynasty") {
    const sorted = Object.values(out).sort((a, b) => b - a);
    for (const [y, rounds] of Object.entries(PICK_RANK)) {
      for (const [r, rank] of Object.entries(rounds)) out[N.pickKey(y, r)] = sorted[rank - 1] || top * FLOOR;
    }
  }
  return out;
}

// The page's pick keys ("2027-1-early"), like the other value files: Sleeper
// trades don't say where a future pick lands, so the trades fit one value per
// round and early/late are this spread around it.
const SLOT_SPREAD = { 1: [1.25, 0.8], 2: [1.15, 0.87], 3: [1.1, 0.9], 4: [1.08, 0.92] };
function pagePickValues(id, v, now) {
  const { year, round } = pickInfo(id, now);
  const [early, late] = SLOT_SPREAD[round] || [1, 1];
  return {
    [`${year}-${round}-early`]: Math.round(Math.min(N.TOP, v * early)),
    [`${year}-${round}-mid`]: v,
    [`${year}-${round}-late`]: Math.round(v * late),
  };
}

// The Trade Database (data/nfl-trades.js): every trade the fit used, for the
// page to browse and judge. usable: { format: [trade] } (cleanTrades' lists);
// names: { id: name }. A trade is [ts, format index, league size, side A,
// side B], newest first. Picks become their draft ("p2027-1"), since a
// "pick-1-1" means a different draft depending on when it was traded.
function tradeDatabase(usable, names, now = Date.now()) {
  const asset = (id, ts) => {
    if (!N.isPick(id)) return id;
    const [, out, round] = id.split("-").map(Number);
    return `p${nextDraftYear(ts) + out - 1}-${round}`;
  };
  const trades = [];
  const seen = new Set();
  for (const [format, list] of Object.entries(usable)) {
    const f = FORMATS.indexOf(format);
    if (f < 0) continue;
    for (const t of list) trades.push([t.ts, f, t.size || 12, ...t.sides.map((s) => s.map((id) => asset(id, t.ts)))]);
  }
  trades.sort((a, b) => b[0] - a[0]);
  for (const t of trades) for (const s of [t[3], t[4]]) for (const id of s) if (id[0] !== "p") seen.add(id);
  const used = Object.fromEntries([...seen].sort().map((id) => [id, names[id] || "Unknown player"]));
  return { updatedOn: new Date(now).toISOString().slice(0, 10), draftYear: nextDraftYear(now), formats: FORMATS, names: used, trades };
}

module.exports = {
  FORMATS, HALF_LIFE, ROUNDS, modeOf, leagueExtra, formatOf, draftsAway, parseTrade,
  nextDraftYear, pickInfo, playerInputs, ageFactor, priorValues, pagePickValues, tradeDatabase,
  // The fit is the basketball market's, unchanged.
  isPick: N.isPick, cleanTrades: N.cleanTrades, fitValues: N.fitValues, scaleValues: N.scaleValues, tiers: N.tiers, THIN: N.THIN,
};
