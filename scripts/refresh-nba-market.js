#!/usr/bin/env node
// The basketball Trade Market: crawls public Sleeper basketball leagues for
// completed trades and fits KeepTradeCut-style values from them (see
// lib/nba-market.js for the method). Writes:
// - data/nba-market.js: today's dynasty and redraft values (0-9999), the
//   model value, effective trade count, tier and 7/30-day change per asset.
// - data/nba-market-history.js: one point a week per asset, for profiles.
// - data/nba-trades.js: the Trade Database, every trade the fit used (see
//   tradeDatabase in lib/nba-market.js).
// and keeps its working state in cache/ (committed, not deployed):
// - cache/nba-market-crawl.json: every league found so far and how far its
//   trades have been read, plus users still to look up.
// - cache/nba-trades.json: every trade collected (a year's worth).
//
// Usage: node scripts/refresh-nba-market.js [--budget N] [--backfill] [--no-crawl] [--dry-run]
// (--no-crawl refits from the trades already collected, reading no leagues.)
//
// Each run spends at most --budget Sleeper requests (default 3500, about five
// a second, well under Sleeper's 1000 a minute): first finding new leagues by
// walking league → its managers → their other leagues (starting from
// SEED_USER), then reading trades, leagues read longest ago first.
// --backfill also reads each league's previous season (all its weeks) and
// rebuilds the weekly history from those trades, so trends work right away.
// The values are refit from scratch on every run.

const fs = require("fs");
const path = require("path");
const M = require("./lib/nba-market");
const C = require("./lib/sleeper-crawl");

const ROOT = path.join(__dirname, "..");
const CRAWL = path.join(ROOT, "cache", "nba-market-crawl.json");
const TRADES = path.join(ROOT, "cache", "nba-trades.json");
const SNAPSHOT = path.join(ROOT, "data", "nba-snapshot.js");
const OUT = path.join(ROOT, "data", "nba-market.js");
const HISTORY_OUT = path.join(ROOT, "data", "nba-market-history.js");
const DB_OUT = path.join(ROOT, "data", "nba-trades.js");

const SEED_USER = "asterisk387";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BACKFILL = args.includes("--backfill");
const NO_CRAWL = args.includes("--no-crawl");
const BUDGET = Number(args[args.indexOf("--budget") + 1]) || (BACKFILL ? 16000 : 3500);
const DISCOVER_SHARE = 0.35;    // of the budget, for finding new leagues
const KEEP_DAYS = 365;
const MIN_TRADES = 300;         // below this a format's values are the model's
const HISTORY_WEEKS = 53;
const SEASON_WEEKS = 25;
const DAY = 86400000;
const FORMATS = ["dynasty", "redraft"];

const today = new Date().toISOString().slice(0, 10);
const crawler = C.createCrawler({ sport: "nba", budget: BUDGET, parseTrade: M.parseTrade });

function loadSnapshot() {
  const text = fs.readFileSync(SNAPSHOT, "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).data;
}

// Values for one format from the trades up to `asOf`.
function fitFormat(format, trades, prior, keep, asOf) {
  const usable = M.cleanTrades(trades.filter((t) => t.format === format && t.ts <= asOf && asOf - t.ts < KEEP_DAYS * DAY), prior);
  const building = usable.length < MIN_TRADES;
  const fit = M.fitValues(building ? [] : usable, prior, { now: asOf, halfLife: M.HALF_LIFE[format] });
  const rows = M.scaleValues(fit, prior, keep);
  const tierOf = M.tiers(rows);
  return { rows: rows.map((r, i) => ({ ...r, tier: tierOf[i] })), trades: usable.length, leagues: new Set(usable.map((t) => t.league)).size, building, usable };
}

async function main() {
  const snapshot = loadSnapshot();
  const season = snapshot.state.season;
  const week = snapshot.state.season_type === "regular" ? snapshot.state.week : snapshot.state.season_type === "post" ? SEASON_WEEKS + 2 : 0;
  const crawl = C.readJson(CRAWL, { leagues: {}, frontier: [], usersDone: [] });
  const store = Object.fromEntries((C.readJson(TRADES, [])).map((t) => [t.id, t]));
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
    // Last season only with what's left, so this season's trades come first.
    if (BACKFILL) await crawler.backfillPrevious(crawl, store, SEASON_WEEKS + 2);
  }
  console.log(`${crawler.spent()} requests. Trades: ${before} → ${Object.keys(store).length}`);

  // Keep a year of trades.
  const cutoff = Date.now() - KEEP_DAYS * DAY;
  const trades = Object.values(store).filter((t) => t.ts >= cutoff).sort((a, b) => a.ts - b.ts);

  // Values: every active player plus (dynasty) picks.
  const priors = { dynasty: M.priorValues(snapshot, "dynasty"), redraft: M.priorValues(snapshot, "redraft") };
  // Sleeper lists team defenses (position DEF) as players too; they aren't traded.
  const active = Object.keys(snapshot.players).filter((id) => snapshot.players[id].position !== "DEF");
  const keep = { dynasty: [...active, ...Object.keys(priors.dynasty).filter(M.isPick)], redraft: active };
  const now = Date.now();
  const fits = {};
  for (const f of ["dynasty", "redraft"]) {
    fits[f] = fitFormat(f, trades, priors[f], keep[f], now);
    const top = fits[f].rows.slice(0, 12).map((r) => `${r.id.startsWith("pick") ? r.id : snapshot.players[r.id]?.name} ${r.v}`);
    console.log(`${f}: ${fits[f].trades} trades from ${fits[f].leagues} leagues${fits[f].building ? " (building: model values)" : ""}\n  ${top.join(", ")}`);
  }

  let history = BACKFILL ? { dates: [], dynasty: {}, redraft: {} } : readHistory();
  if (BACKFILL) {
    // Refit at each of the last weeks' Wednesdays from the trades known then.
    const first = trades.length ? trades[0].ts : now;
    const points = [];
    for (let t = now - 7 * DAY; t > first && points.length < HISTORY_WEEKS - 1; t -= 7 * DAY) points.unshift(t);
    for (const t of points) {
      const d = new Date(t).toISOString().slice(0, 10);
      // A format still building (too few trades by then) records nothing, so
      // trends never compare the market with model-only values.
      const point = {};
      for (const f of ["dynasty", "redraft"]) {
        const fit = fitFormat(f, trades, priors[f], keep[f], t);
        if (!fit.building) point[f] = fit.rows;
      }
      C.addPoint(history, d, point, FORMATS, HISTORY_WEEKS);
    }
    console.log(`Backfilled ${points.length} history points`);
  }
  history = C.addPoint(history, today, Object.fromEntries(FORMATS.filter((f) => !fits[f].building).map((f) => [f, fits[f].rows])), FORMATS, HISTORY_WEEKS);

  const formats = {}, trends = {}, stats = {};
  for (const f of ["dynasty", "redraft"]) {
    formats[f] = Object.fromEntries(fits[f].rows.map((r) => [r.id, [r.v, r.prior, r.n, r.tier]]));
    const t7 = C.trend(history, f, 7), t30 = C.trend(history, f, 30);
    trends[f] = Object.fromEntries(fits[f].rows.filter((r) => t7[r.id] || t30[r.id]).map((r) => [r.id, [t7[r.id] || 0, t30[r.id] || 0]]));
    stats[f] = { trades: fits[f].trades, leagues: fits[f].leagues, building: fits[f].building };
  }
  stats.leaguesKnown = Object.keys(crawl.leagues).length;

  // Players' names for the Trade Database (some may have since retired, so
  // the page can't look them all up).
  const names = {};
  for (const [id, p] of Object.entries(M.playerInputs(snapshot).players)) names[id] = p.name;

  const opts = { dryRun: DRY_RUN, by: "scripts/refresh-nba-market.js" };
  C.writeIfChanged(OUT, "NBA_MARKET", { updatedOn: today, season, stats, formats, trends }, { ...opts, compareOn: (d) => ({ formats: d.formats, stats: d.stats }) });
  C.writeIfChanged(HISTORY_OUT, "NBA_MARKET_HISTORY", history, opts);
  const db = M.tradeDatabase({ dynasty: fits.dynasty.usable, redraft: fits.redraft.usable }, names, now);
  C.writeIfChanged(DB_OUT, "NBA_TRADES", db, { ...opts, compareOn: (d) => d.trades });
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(CRAWL), { recursive: true });
    fs.writeFileSync(CRAWL, JSON.stringify(crawl));
    fs.writeFileSync(TRADES, JSON.stringify(trades));
  }
}

const readHistory = () => C.readGlobal(HISTORY_OUT, "NBA_MARKET_HISTORY", { dates: [], dynasty: {}, redraft: {} });

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
