#!/usr/bin/env node
// The football Trade Market: the site's own dynasty and redraft values, fit
// from completed trades in public Sleeper football leagues with the same
// formula as the basketball market (see lib/nfl-market.js and
// lib/nba-market.js). Writes:
// - data/nfl-market.js: today's values (0-9999) per format and QB setting,
//   keyed like data/market-values.js so the page's rankings, trade
//   calculator and league tools use them directly, plus each player's model
//   value, effective trade count and 30-day change.
// - data/nfl-market-history.js: one point a week per player (dynasty), for
//   the value graph on player profiles.
// - data/nfl-trades.js: the Trade Database, every trade the fit used (see
//   tradeDatabase in lib/nfl-market.js).
// and keeps its working state in cache/ (committed, not deployed):
// - cache/nfl-market-crawl.json: the leagues found and how far each has been read.
// - cache/nfl-trades.json: every trade collected (a year's worth).
//
// Usage: node scripts/refresh-nfl-market.js [--budget N] [--concurrency N] [--backfill] [--no-crawl] [--dry-run]
// (--no-crawl refits from the trades already collected, reading no leagues.)
//
// Each run spends at most --budget Sleeper requests (default 6000): first
// finding new leagues (up to MAX_LEAGUES), then reading trades, leagues read
// longest ago first. --backfill also rebuilds the weekly history from the
// trades collected, so trends work right away (and with a bigger default
// budget, also reads last season's leagues).
// The values are refit from scratch on every run.

const fs = require("fs");
const path = require("path");
const M = require("./lib/nfl-market");
const C = require("./lib/sleeper-crawl");

const ROOT = path.join(__dirname, "..");
const CRAWL = path.join(ROOT, "cache", "nfl-market-crawl.json");
const TRADES = path.join(ROOT, "cache", "nfl-trades.json");
const PLAYERS = path.join(ROOT, "data", "nfl-players.js");
const OUT = path.join(ROOT, "data", "nfl-market.js");
const HISTORY_OUT = path.join(ROOT, "data", "nfl-market-history.js");
const DB_OUT = path.join(ROOT, "data", "nfl-trades.js");

const SEED_USER = "asterisk387";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : null; };
const DRY_RUN = args.includes("--dry-run");
const BACKFILL = args.includes("--backfill");
const NO_CRAWL = args.includes("--no-crawl");
const BUDGET = flag("--budget") || (BACKFILL ? 30000 : 6000);
const CONCURRENCY = flag("--concurrency") || 5;
const DISCOVER_SHARE = 0.25;    // of the budget, for finding new leagues
const MAX_LEAGUES = 2500;
const KEEP_DAYS = 365;
const MIN_TRADES = 300;         // below this a format's values are the model's
const HISTORY_WEEKS = 53;
const SEASON_WEEKS = 18;
const DAY = C.DAY;
const HISTORY_FORMATS = ["dynasty-1qb", "dynasty-sf"];

const today = new Date().toISOString().slice(0, 10);
const crawler = C.createCrawler({
  sport: "nfl", budget: BUDGET, parseTrade: M.parseTrade, leagueExtra: M.leagueExtra,
  concurrency: CONCURRENCY, maxLeagues: MAX_LEAGUES,
});

function loadPlayers() {
  const text = fs.readFileSync(PLAYERS, "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).players;
}

// PPR season totals by Sleeper id: { id: { gp, pts } }.
async function seasonTotals(season) {
  const url = `https://api.sleeper.com/stats/nfl/${season}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Sleeper season stats ${season}: ${res.status}`);
  const out = {};
  for (const r of await res.json()) if (r?.stats?.gp) out[r.player_id] = { gp: r.stats.gp, pts: r.stats.pts_ppr || 0 };
  return out;
}

// Values for one format from the trades up to `asOf`. Trades are cleaned
// twice: against the model, then against the first fit, so a trade the model
// alone calls lopsided (a rookie it doesn't know yet) still counts.
function fitFormat(format, trades, prior, keep, asOf) {
  const mode = M.modeOf(format);
  const pool = trades.filter((t) => t.format === format && t.ts <= asOf && asOf - t.ts < KEEP_DAYS * DAY);
  const opts = { now: asOf, halfLife: M.HALF_LIFE[mode] };
  let usable = M.cleanTrades(pool, prior);
  const building = usable.length < MIN_TRADES;
  let fit = M.fitValues(building ? [] : usable, prior, opts);
  if (!building) {
    usable = M.cleanTrades(pool, fit.values);
    fit = M.fitValues(usable, prior, opts);
  }
  const rows = M.scaleValues(fit, prior, keep);
  const tierOf = M.tiers(rows);
  return { rows: rows.map((r, i) => ({ ...r, tier: tierOf[i] })), usable, trades: usable.length, leagues: new Set(usable.map((t) => t.league)).size, building };
}

async function main() {
  const state = await (await fetch("https://api.sleeper.app/v1/state/nfl")).json();
  const season = state.league_season || state.season;
  const week = state.season_type === "regular" ? state.week : state.season_type === "post" ? SEASON_WEEKS + 1 : 0;
  const crawl = C.readJson(CRAWL, { leagues: {}, frontier: [], usersDone: [] });
  const store = Object.fromEntries(C.readJson(TRADES, []).map((t) => [t.id, t]));
  const before = Object.keys(store).length;

  // A new season starts the walk over (the league ids change each season).
  if (crawl.season && crawl.season !== season) { crawl.leagues = {}; crawl.usersDone = []; }
  crawl.season = season;
  if (!crawl.frontier.length && !crawl.usersDone.length) {
    const me = await crawler.get(`/user/${SEED_USER}`);
    if (me) crawl.frontier.push(me.user_id);
  }

  if (!NO_CRAWL) {
    await crawler.discover(crawl, season, Math.round(BUDGET * DISCOVER_SHARE));
    const order = Object.entries(crawl.leagues).sort((a, b) => a[1].at - b[1].at);
    await crawler.pool(order, ([id, l]) => crawler.scanLeague(id, l, week, store));
    if (BACKFILL) await crawler.backfillPrevious(crawl, store, SEASON_WEEKS + 1);
  }
  console.log(`${crawler.spent()} requests. Trades: ${before} → ${Object.keys(store).length}`);

  const cutoff = Date.now() - KEEP_DAYS * DAY;
  const trades = Object.values(store).filter((t) => t.ts >= cutoff).sort((a, b) => a.ts - b.ts);

  const players = loadPlayers();
  const [cur, prev] = await Promise.all([seasonTotals(state.season), seasonTotals(state.previous_season)]);
  const inputs = M.playerInputs({ players, cur, prev });
  const priors = Object.fromEntries(M.FORMATS.map((f) => [f, M.priorValues(inputs, f, { week })]));
  const ids = Object.keys(inputs.players);
  const keep = (f) => (M.modeOf(f) === "dynasty" ? [...ids, ...Object.keys(priors[f]).filter(M.isPick)] : ids);

  const now = Date.now();
  const fits = {};
  for (const f of M.FORMATS) {
    fits[f] = fitFormat(f, trades, priors[f], keep(f), now);
    const top = fits[f].rows.slice(0, 12).map((r) => `${M.isPick(r.id) ? M.pickInfo(r.id).label : inputs.players[r.id]?.name} ${r.v}`);
    console.log(`${f}: ${fits[f].trades} trades from ${fits[f].leagues} leagues${fits[f].building ? " (building: model values)" : ""}\n  ${top.join(", ")}`);
  }

  let history = BACKFILL ? { dates: [] } : C.readGlobal(HISTORY_OUT, "NFL_MARKET_HISTORY", { dates: [] });
  if (BACKFILL) {
    // Refit at each past week from the trades known then.
    const first = trades.length ? trades[0].ts : now;
    const points = [];
    for (let t = now - 7 * DAY; t > first + 28 * DAY && points.length < HISTORY_WEEKS - 1; t -= 7 * DAY) points.unshift(t);
    for (const t of points) {
      const point = {};
      for (const f of HISTORY_FORMATS) {
        const fit = fitFormat(f, trades, priors[f], ids, t);
        if (!fit.building) point[f] = fit.rows;
      }
      C.addPoint(history, new Date(t).toISOString().slice(0, 10), point, HISTORY_FORMATS, HISTORY_WEEKS);
    }
    console.log(`Backfilled ${points.length} history points`);
  }
  const todayPoint = Object.fromEntries(HISTORY_FORMATS.filter((f) => !fits[f].building).map((f) => [f, fits[f].rows.filter((r) => !M.isPick(r.id))]));
  history = C.addPoint(history, today, todayPoint, HISTORY_FORMATS, HISTORY_WEEKS);

  // { dynasty: { "1qb": { id: v } }, redraft: {...} }, with picks as
  // "2027-1-mid" (and early/late) like data/market-values.js.
  const values = { dynasty: {}, redraft: {} }, model = { dynasty: {}, redraft: {} }, trades_ = { dynasty: {}, redraft: {} };
  const trends = { dynasty: {}, redraft: {} }, stats = {};
  for (const f of M.FORMATS) {
    const [mode, qb] = f.split("-");
    const v = (values[mode][qb] = {}), mv = (model[mode][qb] = {}), n = (trades_[mode][qb] = {});
    for (const r of fits[f].rows) {
      if (M.isPick(r.id)) Object.assign(v, M.pagePickValues(r.id, r.v, now));
      else { v[r.id] = r.v; mv[r.id] = r.prior; n[r.id] = r.n; }
    }
    if (HISTORY_FORMATS.includes(f)) {
      const t30 = C.trend(history, f, 30);
      trends[mode][qb] = Object.fromEntries(Object.entries(t30).filter(([, d]) => d));
    }
    stats[f] = { trades: fits[f].trades, leagues: fits[f].leagues, building: fits[f].building };
  }
  stats.leaguesKnown = Object.keys(crawl.leagues).length;

  const opts = { dryRun: DRY_RUN, by: "scripts/refresh-nfl-market.js" };
  C.writeIfChanged(OUT, "NFL_MARKET", { updatedOn: today, season, stats, values, model, trades: trades_, trends },
    { ...opts, compareOn: (d) => ({ values: d.values, stats: d.stats }) });
  C.writeIfChanged(HISTORY_OUT, "NFL_MARKET_HISTORY", history, opts);
  const names = Object.fromEntries(Object.entries(players).map(([id, p]) => [id, p.name]));
  const db = M.tradeDatabase(Object.fromEntries(M.FORMATS.map((f) => [f, fits[f].usable])), names, now);
  C.writeIfChanged(DB_OUT, "NFL_TRADES", db, { ...opts, compareOn: (d) => d.trades });
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(CRAWL), { recursive: true });
    fs.writeFileSync(CRAWL, JSON.stringify(crawl));
    fs.writeFileSync(TRADES, JSON.stringify(trades));
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
