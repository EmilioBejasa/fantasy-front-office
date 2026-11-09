#!/usr/bin/env node
// The basketball Trade Market: crawls public Sleeper basketball leagues for
// completed trades and fits KeepTradeCut-style values from them (see
// lib/nba-market.js for the method). Writes:
// - data/nba-market.js: today's dynasty and redraft values (0-9999), the
//   model value, effective trade count, tier and 7/30-day change per asset.
// - data/nba-market-history.js: one point a week per asset, for profiles.
// - data/nba-trades-recent.js: the latest trades, for the page's feed.
// and keeps its working state in cache/ (committed, not deployed):
// - cache/nba-market-crawl.json: every league found so far and how far its
//   trades have been read, plus users still to look up.
// - cache/nba-trades.json: every trade collected (a year's worth).
//
// Usage: node scripts/refresh-nba-market.js [--budget N] [--backfill] [--dry-run]
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

const ROOT = path.join(__dirname, "..");
const CRAWL = path.join(ROOT, "cache", "nba-market-crawl.json");
const TRADES = path.join(ROOT, "cache", "nba-trades.json");
const SNAPSHOT = path.join(ROOT, "data", "nba-snapshot.js");
const OUT = path.join(ROOT, "data", "nba-market.js");
const HISTORY_OUT = path.join(ROOT, "data", "nba-market-history.js");
const RECENT_OUT = path.join(ROOT, "data", "nba-trades-recent.js");

const API = "https://api.sleeper.app/v1";
const SEED_USER = "asterisk387";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BACKFILL = args.includes("--backfill");
const BUDGET = Number(args[args.indexOf("--budget") + 1]) || (BACKFILL ? 16000 : 3500);
const CONCURRENCY = 5;
const MIN_GAP_MS = 1000;        // per worker, so about five requests a second
const DISCOVER_SHARE = 0.35;    // of the budget, for finding new leagues
const MAX_FRONTIER = 20000;
const KEEP_DAYS = 365;
const MIN_TRADES = 300;         // below this a format's values are the model's
const RECENT = 150;
const HISTORY_WEEKS = 53;
const SEASON_WEEKS = 25;
const DAY = 86400000;

const today = new Date().toISOString().slice(0, 10);
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let spent = 0;
async function get(url) {
  if (spent >= BUDGET) return undefined;
  spent++;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API + url);
      if (res.status === 429) { await sleep(5000); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { await sleep(1000); }
  }
  return null;
}

// Runs fn over items CONCURRENCY at a time, spacing each worker's requests.
async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length && spent < BUDGET) {
      const item = items[i++];
      const t = Date.now();
      await fn(item);
      const left = MIN_GAP_MS - (Date.now() - t);
      if (left > 0) await sleep(left);
    }
  }));
}

function loadSnapshot() {
  const text = fs.readFileSync(SNAPSHOT, "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).data;
}

// league summary kept in the crawl state.
const leagueMeta = (l) => ({
  type: l.settings?.type ?? 0, size: l.total_rosters || 12, season: String(l.season),
  prev: l.previous_league_id && l.previous_league_id !== "0" ? String(l.previous_league_id) : null,
  scanned: -1, at: 0,
});

async function discover(crawl, season, budget) {
  const stop = spent + budget;
  const seen = new Set(crawl.usersDone);
  // Everyone's been looked up: start again from the members of known leagues,
  // whose other leagues may be new since.
  if (!crawl.frontier.length) {
    const sample = Object.keys(crawl.leagues).sort(() => Math.random() - 0.5).slice(0, 60);
    for (const id of sample) for (const m of (await get(`/league/${id}/users`)) || []) crawl.frontier.push(m.user_id);
    seen.clear();
  }
  // One hop at a time (users → their leagues → those leagues' users) until
  // the discovery budget runs out or nobody new turns up.
  let i = 0;
  let queue = [...new Set(crawl.frontier)].filter((u) => !seen.has(u));
  while (queue.length && spent < stop) {
    const next = [];
    const done = new Set();
    await pool(queue, async (uid) => {
      done.add(uid);
      if (spent >= stop) { next.push(uid); return; }
      if (seen.has(uid)) return;
      seen.add(uid);
      i++;
      const leagues = await get(`/user/${uid}/leagues/nba/${season}`);
      for (const l of leagues || []) {
        if (crawl.leagues[l.league_id] || spent >= stop) continue;
        crawl.leagues[l.league_id] = leagueMeta(l);
        const members = await get(`/league/${l.league_id}/users`);
        for (const m of members || []) if (!seen.has(m.user_id)) next.push(m.user_id);
      }
    });
    for (const uid of queue) if (!done.has(uid)) next.push(uid);
    queue = [...new Set(next)].filter((u) => !seen.has(u)).slice(0, MAX_FRONTIER);
    if (spent >= stop) break;
  }
  crawl.usersDone = [...seen];
  crawl.frontier = queue;
  console.log(`Looked up ${i} users: ${Object.keys(crawl.leagues).length} leagues known, ${crawl.frontier.length} users queued`);
}

// Reads trades for one league from its last scanned week (again, in case of
// late trades) through `week`.
async function scanLeague(id, l, week, store) {
  const from = Math.max(0, l.scanned);
  for (let w = from; w <= week; w++) {
    const txs = await get(`/league/${id}/transactions/${w}`);
    if (txs === undefined) return; // out of budget: pick up here next time
    for (const tx of txs || []) {
      const t = M.parseTrade(tx, { id, type: l.type, size: l.size, season: l.season });
      if (t) store[t.id] = t;
    }
    l.scanned = w;
  }
  l.at = Date.now();
}

async function backfillPrevious(crawl, store) {
  const todo = Object.entries(crawl.leagues).filter(([, l]) => l.prev && !l.prevDone);
  console.log(`Backfill: ${todo.length} previous seasons to read`);
  await pool(todo, async ([, l]) => {
    const prev = await get(`/league/${l.prev}`);
    if (prev === undefined) return;
    if (prev) {
      const meta = { ...leagueMeta(prev), scanned: 0 };
      await scanLeague(l.prev, meta, SEASON_WEEKS + 2, store);
      if (meta.scanned < SEASON_WEEKS + 2) return;
    }
    l.prevDone = true;
  });
}

function writeIfChanged(file, name, data, compareOn, header) {
  const body = `// Generated by scripts/refresh-nba-market.js — don't edit by hand.\nwindow.${name} = ${JSON.stringify(data)};\n`;
  try {
    const before = fs.readFileSync(file, "utf8");
    const m = new RegExp(`window\\.${name} = (.*);\\s*$`, "s").exec(before);
    if (m && JSON.stringify(compareOn(JSON.parse(m[1]))) === JSON.stringify(compareOn(data))) {
      return console.log(`${path.basename(file)} unchanged.`);
    }
  } catch (e) {}
  console.log(`${path.basename(file)}: ${(body.length / 1024).toFixed(0)} KB${DRY_RUN ? " (dry run, not written)" : ""}`);
  if (!DRY_RUN) fs.writeFileSync(file, body);
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

// History: { dates: [...], dynasty: { id: [values aligned to dates] }, redraft: {...} }.
// A new point each week; within a week the newest point moves forward.
function addPoint(history, date, byFormat) {
  const { dates } = history;
  const n = dates.length;
  const daysBack = n >= 2 ? (Date.parse(dates[n - 1]) - Date.parse(dates[n - 2])) / DAY : 99;
  if (n && dates[n - 1] === date) {
    // overwrite
  } else if (n >= 2 && daysBack < 7) dates[n - 1] = date;
  else {
    dates.push(date);
    for (const f of ["dynasty", "redraft"]) for (const s of Object.values(history[f])) s.push(null);
  }
  const col = dates.length - 1;
  for (const f of ["dynasty", "redraft"]) {
    for (const r of byFormat[f] || []) {
      const s = (history[f][r.id] ||= dates.map(() => null));
      s[col] = r.v;
    }
  }
  // Trim to a year of points, and drop assets with nothing left.
  const cut = Math.max(0, dates.length - HISTORY_WEEKS);
  if (cut) {
    dates.splice(0, cut);
    for (const f of ["dynasty", "redraft"]) for (const s of Object.values(history[f])) s.splice(0, cut);
  }
  for (const f of ["dynasty", "redraft"]) for (const [id, s] of Object.entries(history[f])) if (s.every((x) => x == null)) delete history[f][id];
  return history;
}

// Change over about `days`: today's value minus the history point nearest
// that far back. { id: change }.
function trend(history, format, days) {
  const { dates } = history;
  const last = dates.length - 1;
  let then = -1;
  for (let i = 0; i < last; i++) {
    const back = (Date.parse(dates[last]) - Date.parse(dates[i])) / DAY;
    if (back < days * 0.6) continue;
    if (then < 0 || Math.abs(back - days) < Math.abs((Date.parse(dates[last]) - Date.parse(dates[then])) / DAY - days)) then = i;
  }
  const out = {};
  if (then < 0) return out;
  for (const [id, s] of Object.entries(history[format])) if (s[last] != null && s[then] != null) out[id] = s[last] - s[then];
  return out;
}

async function main() {
  const snapshot = loadSnapshot();
  const season = snapshot.state.season;
  const week = snapshot.state.season_type === "regular" ? snapshot.state.week : snapshot.state.season_type === "post" ? SEASON_WEEKS + 2 : 0;
  const crawl = readJson(CRAWL, { leagues: {}, frontier: [], usersDone: [] });
  const store = Object.fromEntries((readJson(TRADES, [])).map((t) => [t.id, t]));
  const before = Object.keys(store).length;

  // A new season starts the walk over (the league ids change each season).
  if (crawl.season && crawl.season !== season) { crawl.leagues = {}; crawl.usersDone = []; }
  crawl.season = season;
  if (!crawl.frontier.length && !crawl.usersDone.length) {
    const me = await get(`/user/${SEED_USER}`);
    if (me) crawl.frontier.push(me.user_id);
  }

  await discover(crawl, season, Math.round(BUDGET * DISCOVER_SHARE));
  const order = Object.entries(crawl.leagues).sort((a, b) => a[1].at - b[1].at);
  await pool(order, ([id, l]) => scanLeague(id, l, week, store));
  // Last season only with what's left, so this season's trades come first.
  if (BACKFILL) await backfillPrevious(crawl, store);
  console.log(`${spent} requests. Trades: ${before} → ${Object.keys(store).length}`);

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
      addPoint(history, d, point);
    }
    console.log(`Backfilled ${points.length} history points`);
  }
  history = addPoint(history, today, Object.fromEntries(["dynasty", "redraft"].filter((f) => !fits[f].building).map((f) => [f, fits[f].rows])));

  const formats = {}, trends = {}, stats = {};
  for (const f of ["dynasty", "redraft"]) {
    formats[f] = Object.fromEntries(fits[f].rows.map((r) => [r.id, [r.v, r.prior, r.n, r.tier]]));
    const t7 = trend(history, f, 7), t30 = trend(history, f, 30);
    trends[f] = Object.fromEntries(fits[f].rows.filter((r) => t7[r.id] || t30[r.id]).map((r) => [r.id, [t7[r.id] || 0, t30[r.id] || 0]]));
    stats[f] = { trades: fits[f].trades, leagues: fits[f].leagues, building: fits[f].building };
  }
  stats.leaguesKnown = Object.keys(crawl.leagues).length;

  // The feed: the latest usable trades with each side's players' names (some
  // may have since retired, so the page can't look them all up).
  const names = {};
  for (const [id, p] of Object.entries(M.playerInputs(snapshot).players)) names[id] = p.name;
  const recent = [...fits.dynasty.usable, ...fits.redraft.usable].sort((a, b) => b.ts - a.ts).slice(0, RECENT)
    .map((t) => ({ ts: t.ts, format: t.format, size: t.size, sides: t.sides.map((s) => s.map((id) => (M.isPick(id) ? [id] : [id, names[id] || "Unknown"]))) }));

  writeIfChanged(OUT, "NBA_MARKET", { updatedOn: today, season, stats, formats, trends }, (d) => ({ formats: d.formats, stats: d.stats }));
  writeIfChanged(HISTORY_OUT, "NBA_MARKET_HISTORY", history, (d) => d);
  writeIfChanged(RECENT_OUT, "NBA_TRADES_RECENT", recent, (d) => d);
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(CRAWL), { recursive: true });
    fs.writeFileSync(CRAWL, JSON.stringify(crawl));
    fs.writeFileSync(TRADES, JSON.stringify(trades));
  }
}

function readHistory() {
  try {
    const m = /window\.NBA_MARKET_HISTORY = (.*);\s*$/s.exec(fs.readFileSync(HISTORY_OUT, "utf8"));
    return JSON.parse(m[1]);
  } catch (e) {
    return { dates: [], dynasty: {}, redraft: {} };
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
