// The basketball Trade Market (data/nba-market.js, by
// scripts/refresh-nba-market.js): KeepTradeCut-style values worked out from
// real trades in public Sleeper basketball leagues, since no outside site
// publishes basketball trade values.
//
// The idea is KTC's "tradesourced" values: if managers keep trading A for
// B + C, A is worth about what B and C are worth together, consolidation
// premium included. Every completed trade is one such comparison, and the fit
// finds the values that make the trades look as fair as possible:
//
// - A side's worth is S = (Σ v^α)^(1/α) with α = ALPHA (> 1), so one star
//   beats a pile of fillers that add up to the same total, as on KTC.
// - Each trade's miss is ln S(side A) − ln S(side B), scored with a Huber
//   loss (one strange trade can only pull so hard) and weighted by recency.
// - Every asset is pulled toward its model value (the prior: stats, age and
//   games left), so a rarely traded player stays near the model and a heavily
//   traded one goes wherever the trades say.
//
// Formats: dynasty (Sleeper league type 2, keeper leagues at half weight) and
// redraft (type 0). Draft picks are dynasty-only, keyed by how many drafts
// away they are ("pick-1-1" is next year's 1st), so trades from last season
// count for this year's picks too.
//
// Everything here is plain functions with no network, so tests can run them.

const ALPHA = 1.4;
const HUBER = 0.35;           // ln-ratio past which a trade's pull stops growing
const PRIOR_WEIGHT = 1.5;     // the prior counts like this many trades
const HALF_LIFE = { dynasty: 45, redraft: 21 }; // days
const KEEPER_WEIGHT = 0.5;
const MAX_SIDE = 6;           // assets per side; bigger trades are roster dumps
const LOPSIDED = 4;           // model-value ratio past which a trade is dropped
const LEAGUE_CAP = 12;        // trades per league per 30 days that count
const THIN = 5;               // effective trades below this: "thin" value
const TOP = 9999;
const TIER_GAP = 0.06;
const DAY = 86400000;

const STANDARD = { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 };
const points = (stats, w = STANDARD) => Object.entries(w).reduce((s, [k, x]) => s + x * ((stats || {})[k] || 0), 0);

const formatOf = (leagueType) => (leagueType === 2 ? "dynasty" : leagueType === 1 ? "dynasty" : leagueType === 0 ? "redraft" : null);
const pickKey = (yearsOut, round) => `pick-${yearsOut}-${round}`;
const isPick = (id) => String(id).startsWith("pick-");
// "pick-1-1" in the 2026 season → { season: 2027, round: 1, label: "2027 1st" }.
function pickInfo(id, season) {
  const [, out, round] = String(id).split("-").map(Number);
  const year = Number(season) + out;
  const nth = ["", "1st", "2nd", "3rd"][round] || `${round}th`;
  return { year, round, label: `${year} ${nth}` };
}

// One Sleeper transaction → a trade, or null.
// league: { id, type (Sleeper settings.type), size, season }.
// Each side is what one roster received: players from `adds` (player id →
// roster id), picks from `draft_picks[].owner_id`.
function parseTrade(tx, league) {
  if (!tx || tx.type !== "trade" || tx.status !== "complete") return null;
  const format = formatOf(league.type);
  if (!format) return null;
  const rosters = tx.roster_ids || [];
  if (rosters.length !== 2) return null; // three-team trades have no clear "fair"
  const sides = rosters.map((r) => ({ roster: r, players: [], picks: [] }));
  const side = (r) => sides.find((s) => s.roster === r);
  for (const [pid, r] of Object.entries(tx.adds || {})) side(r)?.players.push(String(pid));
  for (const p of tx.draft_picks || []) {
    const out = Number(p.season) - Number(league.season);
    if (out < 1 || out > 3) continue; // this year's picks are already made
    side(p.owner_id)?.picks.push(pickKey(out, p.round));
  }
  if (format === "redraft") for (const s of sides) s.picks = [];
  return {
    id: String(tx.transaction_id),
    ts: tx.status_updated || tx.created,
    format,
    weight: league.type === 1 ? KEEPER_WEIGHT : 1,
    league: String(league.id),
    size: league.size || 12,
    season: String(league.season),
    sides: sides.map((s) => [...s.players, ...s.picks]),
  };
}

// Players' model inputs from the NBA snapshot data:
// { id: { fpg, gp, avail, age, team } } with this season blended with last
// (last season counts as BLEND − games this season games of weight, like the
// page's nbaTradeRows).
const BLEND = 15;
const TEAM_GAMES = 82;
const ROOKIE_FPG = 22;
function playerInputs(snapshot) {
  const state = snapshot.state;
  const cur = snapshot[`season-${state.season}`] || [];
  const prev = snapshot[`season-${state.previous_season}`] || [];
  const byCur = Object.fromEntries(cur.map((p) => [p.id, p]));
  const byPrev = Object.fromEntries(prev.map((p) => [p.id, p]));
  const teamGames = Math.max(0, ...cur.map((p) => p.gp));
  const out = {};
  for (const id of new Set([...Object.keys(byCur), ...Object.keys(byPrev), ...Object.keys(snapshot.players || {})])) {
    const c = byCur[id], p = byPrev[id];
    const cgp = c ? c.gp : 0;
    // Without last season (a rookie), the blend fills in with ROOKIE_FPG
    // instead, so a hot first week doesn't make him a star.
    const pf = p && p.gp ? points(p.stats) / p.gp : c ? ROOKIE_FPG : null;
    const k = pf != null ? Math.max(0, BLEND - cgp) : 0;
    const fpg = cgp + k > 0 ? ((c ? points(c.stats) : 0) + (pf || 0) * k) / (cgp + k) : 0;
    const avail = Math.min(1, Math.max(0.5, cgp >= 10 && teamGames ? cgp / teamGames : p ? p.gp / TEAM_GAMES : 0.8));
    const now = (snapshot.players || {})[id];
    out[id] = { fpg, gp: cgp + (p ? p.gp : 0), avail, age: now?.age || null, active: !!now, name: now?.name || (c || p)?.name, team: now?.team || null, position: now?.position || (c || p)?.position };
  }
  return { players: out, teamGames };
}

// Age multiplier on a season's production, from `age` to `age + years`.
function ageFactor(age, years) {
  if (!age) return 1;
  let f = 1;
  for (let y = 0; y < years; y++) {
    const a = age + y;
    f *= a <= 24 ? 1.06 : a <= 29 ? 1 : a <= 32 ? 0.95 : 0.9;
  }
  return f;
}

// Model values: { id: value }. Production above a replacement level, so a
// 20-point bench player is worth a fraction of a 50-point star (the market is
// steep at the top, like KTC's values).
// Redraft: points above replacement per game × games left × availability.
// Dynasty: the same over DYNASTY_YEARS seasons with the age curve, each later
// season discounted by DISCOUNT, plus picks from PICK_SHARE.
const DYNASTY_YEARS = 4;
const DISCOUNT = 0.8;
const REPLACEMENT_RANK = 160;  // about 12 teams × 13 roster spots
const FLOOR = 0.03;            // share of the top value every listed asset keeps
// A pick's model value as the value of the player at this rank (by
// yearsOut-round); further-out picks are worth a little less.
const PICK_RANK = { "1-1": 45, "1-2": 110, "1-3": 170, "2-1": 55, "2-2": 125, "2-3": 180, "3-1": 65, "3-2": 135, "3-3": 190 };
function priorValues(snapshot, format) {
  const { players, teamGames } = playerInputs(snapshot);
  const gamesLeft = format === "redraft" ? Math.max(TEAM_GAMES - teamGames, 1) : TEAM_GAMES;
  const fpgs = Object.values(players).filter((p) => p.active).map((p) => p.fpg).sort((a, b) => b - a);
  const repl = (fpgs[REPLACEMENT_RANK] || 15) * 0.85;
  const out = {};
  for (const [id, p] of Object.entries(players)) {
    const above = Math.max(p.fpg - repl, 0.5);
    let v = above * p.avail;
    if (format === "redraft") v *= gamesLeft;
    else {
      let total = 0;
      for (let y = 0; y < DYNASTY_YEARS; y++) total += Math.max(p.fpg * ageFactor(p.age, y + 1) - repl, 0.5) * p.avail * TEAM_GAMES * DISCOUNT ** y;
      v = total;
    }
    out[id] = v;
  }
  const top = Math.max(...Object.values(out));
  for (const id in out) out[id] = Math.max(out[id], top * FLOOR);
  if (format === "dynasty") {
    const sorted = Object.entries(out).filter(([id]) => players[id].active).map(([, v]) => v).sort((a, b) => b - a);
    for (const [k, rank] of Object.entries(PICK_RANK)) {
      const [y, r] = k.split("-");
      out[pickKey(y, r)] = sorted[rank - 1] || top * FLOOR;
    }
  }
  return out;
}

// Ln of a side's worth and each asset's share of it (the gradient of ln S
// with respect to each ln v): a softmax at ALPHA.
function sideLog(u, ids) {
  const m = Math.max(...ids.map((id) => u[id]));
  const e = ids.map((id) => Math.exp(ALPHA * (u[id] - m)));
  const sum = e.reduce((s, x) => s + x, 0);
  return { log: m + Math.log(sum) / ALPHA, share: e.map((x) => x / sum) };
}
const sideValue = (values, ids) => Math.exp(sideLog(Object.fromEntries(ids.map((id) => [id, Math.log(values[id])])), ids).log);

// Drops trades that can't tell us much: an empty or oversized side, an asset
// with no model value, wildly lopsided on the model (collusion, a dump, a
// mistake), or past a league's cap, so one busy league can't dominate.
function cleanTrades(trades, prior) {
  const kept = [];
  const perLeague = {};
  for (const t of [...trades].sort((a, b) => b.ts - a.ts)) {
    if (t.sides.some((s) => s.length === 0 || s.length > MAX_SIDE)) continue;
    if (t.sides.some((s) => s.some((id) => !(prior[id] > 0)))) continue;
    const [a, b] = t.sides.map((s) => sideValue(prior, s));
    if (Math.max(a, b) / Math.min(a, b) > LOPSIDED) continue;
    const key = `${t.league}|${Math.floor(t.ts / (30 * DAY))}`;
    perLeague[key] = (perLeague[key] || 0) + 1;
    if (perLeague[key] > LEAGUE_CAP) continue;
    kept.push(t);
  }
  return kept;
}

// The fit (see the header). trades: cleanTrades' list for one format.
// Returns { values: { id: v }, n: { id: effective trades } }, in the prior's
// units, for every asset in the prior.
function fitValues(trades, prior, { now = Date.now(), halfLife = 30, iterations = 500, rate = 0.05 } = {}) {
  const ids = Object.keys(prior);
  const u = {}, anchor = {}, n = {};
  for (const id of ids) { u[id] = anchor[id] = Math.log(prior[id]); n[id] = 0; }
  const ws = trades.map((t) => t.weight * Math.pow(0.5, Math.max(0, now - t.ts) / (halfLife * DAY)));
  trades.forEach((t, i) => { for (const s of t.sides) for (const id of s) n[id] += ws[i]; });

  // Adam on the ln values.
  const m = {}, v = {};
  for (const id of ids) { m[id] = 0; v[id] = 0; }
  const b1 = 0.9, b2 = 0.999;
  for (let it = 1; it <= iterations; it++) {
    const g = {};
    for (const id of ids) g[id] = 2 * PRIOR_WEIGHT * (u[id] - anchor[id]);
    trades.forEach((t, i) => {
      const [A, B] = t.sides.map((s) => sideLog(u, s));
      const r = A.log - B.log;
      const psi = Math.abs(r) <= HUBER ? r : HUBER * Math.sign(r);
      t.sides[0].forEach((id, j) => { g[id] += 2 * ws[i] * psi * A.share[j]; });
      t.sides[1].forEach((id, j) => { g[id] -= 2 * ws[i] * psi * B.share[j]; });
    });
    for (const id of ids) {
      m[id] = b1 * m[id] + (1 - b1) * g[id];
      v[id] = b2 * v[id] + (1 - b2) * g[id] * g[id];
      u[id] -= (rate * (m[id] / (1 - b1 ** it))) / (Math.sqrt(v[id] / (1 - b2 ** it)) + 1e-8);
    }
  }
  return { values: Object.fromEntries(ids.map((id) => [id, Math.exp(u[id])])), n };
}

// Values on KTC's 0-9999 scale (the top asset is 9999), for the ids in
// `keep`. Returns [{ id, v, prior, n }] best first. The prior gets its own
// 0-9999 scale (its top asset at 9999 too), since the model is steeper at the
// top than the market, so market vs model compares standing, not units.
function scaleValues(fit, prior, keep) {
  const ids = keep.filter((id) => fit.values[id] != null);
  const k = TOP / Math.max(...ids.map((id) => fit.values[id]));
  const kp = TOP / Math.max(...ids.map((id) => prior[id] || 0));
  return ids
    .map((id) => ({ id, v: Math.round(fit.values[id] * k), prior: Math.round((prior[id] || 0) * kp), n: Math.round(fit.n[id] * 10) / 10 }))
    .sort((a, b) => b.v - a.v);
}

// Tier numbers (1 = best) for rows sorted best first: a new tier starts
// wherever the drop to the next value is more than TIER_GAP of it, or the
// value falls below TIER_SPAN of the tier's best (so smooth stretches still
// break up), down to TIER_FLOOR, below which everyone shares the last tier.
const TIER_SPAN = 0.82;
const TIER_FLOOR = 500;
function tiers(rows) {
  let tier = 1, head = rows[0]?.v;
  return rows.map((r, i) => {
    if (i > 0 && r.v >= TIER_FLOOR && (rows[i - 1].v - r.v > TIER_GAP * rows[i - 1].v || r.v < head * TIER_SPAN)) { tier++; head = r.v; }
    else if (i > 0 && r.v < TIER_FLOOR && rows[i - 1].v >= TIER_FLOOR) { tier++; head = r.v; }
    return tier;
  });
}

module.exports = {
  ALPHA, THIN, TOP, HALF_LIFE, MAX_SIDE, LOPSIDED, LEAGUE_CAP,
  formatOf, pickKey, isPick, pickInfo, parseTrade, playerInputs, ageFactor, priorValues,
  sideValue, cleanTrades, fitValues, scaleValues, tiers,
};
