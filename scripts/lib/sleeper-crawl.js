// The crawl behind both Trade Markets (scripts/refresh-nba-market.js and
// scripts/refresh-nfl-market.js): finds public Sleeper leagues by walking
// league → its managers → their other leagues, reads their completed trades,
// and keeps the weekly value history. The fit itself is in lib/nba-market.js.
//
// createCrawler({ sport, budget, parseTrade, ... }) returns the
// request-spending helpers, sharing one request budget (about five a second
// by default, well under Sleeper's 1000 a minute). Discovery stops adding
// leagues at maxLeagues. `enrich(trade, league, get, old)`, if given, runs on
// each trade read (async, with the stored copy as `old`) before it's stored.

const fs = require("fs");
const path = require("path");

const API = "https://api.sleeper.app/v1";
const CONCURRENCY = 5;
const MIN_GAP_MS = 1000;        // per worker, so about five requests a second
const MAX_FRONTIER = 20000;
const DAY = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return fallback; } };

// league summary kept in the crawl state. `extra(l)` adds sport-specific
// fields (football's QB format and TE premium).
const leagueMeta = (l, extra) => ({
  type: l.settings?.type ?? 0, size: l.total_rosters || 12, season: String(l.season),
  prev: l.previous_league_id && l.previous_league_id !== "0" ? String(l.previous_league_id) : null,
  scanned: -1, at: 0, ...(extra ? extra(l) : {}),
});

function createCrawler({ sport, budget, parseTrade, leagueExtra, enrich, concurrency = CONCURRENCY, maxLeagues = Infinity }) {
  let spent = 0;

  async function get(url) {
    if (spent >= budget) return undefined;
    spent++;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(API + url, { signal: AbortSignal.timeout(15000) });
        if (res.status === 429) { await sleep(5000); continue; }
        if (!res.ok) return null;
        return await res.json();
      } catch (e) { await sleep(1000); }
    }
    return null;
  }

  // Runs fn over items CONCURRENCY at a time, spacing each worker's requests
  // (an item that made none, such as one skipped, doesn't wait).
  async function pool(items, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (i < items.length && spent < budget) {
        const item = items[i++];
        const t = Date.now(), before = spent;
        await fn(item);
        const left = MIN_GAP_MS * (spent - before) - (Date.now() - t);
        if (left > 0) await sleep(left);
      }
    }));
  }

  const meta = (l) => leagueMeta(l, leagueExtra);

  async function discover(crawl, season, share) {
    const stop = spent + share;
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
    let n = 0;
    let queue = [...new Set(crawl.frontier)].filter((u) => !seen.has(u));
    const full = () => Object.keys(crawl.leagues).length >= maxLeagues;
    while (queue.length && spent < stop && !full()) {
      const next = [];
      const done = new Set();
      await pool(queue, async (uid) => {
        done.add(uid);
        if (spent >= stop) { next.push(uid); return; }
        if (seen.has(uid)) return;
        seen.add(uid);
        n++;
        const leagues = await get(`/user/${uid}/leagues/${sport}/${season}`);
        for (const l of leagues || []) {
          if (crawl.leagues[l.league_id] || spent >= stop || full()) continue;
          crawl.leagues[l.league_id] = meta(l);
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
    console.log(`Looked up ${n} users: ${Object.keys(crawl.leagues).length} leagues known, ${crawl.frontier.length} users queued`);
  }

  // Reads trades for one league from its last scanned week (again, in case of
  // late trades) through `week`.
  async function scanLeague(id, l, week, store) {
    const from = Math.max(0, l.scanned);
    for (let w = from; w <= week; w++) {
      const txs = await get(`/league/${id}/transactions/${w}`);
      if (txs === undefined) return; // out of budget: pick up here next time
      for (const tx of txs || []) {
        const t = parseTrade(tx, { ...l, id });
        if (t && enrich) await enrich(t, { ...l, id }, get, store[t.id]);
        if (t) store[t.id] = t;
      }
      l.scanned = w;
    }
    l.at = Date.now();
  }

  async function backfillPrevious(crawl, store, lastWeek) {
    const todo = Object.entries(crawl.leagues).filter(([, l]) => l.prev && !l.prevDone);
    console.log(`Backfill: ${todo.length} previous seasons to read`);
    await pool(todo, async ([, l]) => {
      const prev = await get(`/league/${l.prev}`);
      if (prev === undefined) return;
      if (prev) {
        const m = { ...meta(prev), scanned: 0 };
        await scanLeague(l.prev, m, lastWeek, store);
        if (m.scanned < lastWeek) return;
      }
      l.prevDone = true;
    });
  }

  return { get, pool, discover, scanLeague, backfillPrevious, spent: () => spent };
}

// Writes `window.<name> = data` unless compareOn(old) equals compareOn(data).
function writeIfChanged(file, name, data, { compareOn = (d) => d, dryRun = false, by } = {}) {
  const body = `// Generated by ${by} — don't edit by hand.\nwindow.${name} = ${JSON.stringify(data)};\n`;
  try {
    const before = fs.readFileSync(file, "utf8");
    const m = new RegExp(`window\\.${name} = (.*);\\s*$`, "s").exec(before);
    if (m && JSON.stringify(compareOn(JSON.parse(m[1]))) === JSON.stringify(compareOn(data))) {
      return console.log(`${path.basename(file)} unchanged.`);
    }
  } catch (e) {}
  console.log(`${path.basename(file)}: ${(body.length / 1024).toFixed(0)} KB${dryRun ? " (dry run, not written)" : ""}`);
  if (!dryRun) fs.writeFileSync(file, body);
}

function readGlobal(file, name, fallback) {
  try {
    const m = new RegExp(`window\\.${name} = (.*);\\s*$`, "s").exec(fs.readFileSync(file, "utf8"));
    return JSON.parse(m[1]);
  } catch (e) {
    return fallback;
  }
}

// History: { dates: [...], <format>: { id: [values aligned to dates] } }.
// A new point each week; within a week the newest point moves forward.
// byFormat: { <format>: rows } for the formats with values today.
function addPoint(history, date, byFormat, formats, maxPoints) {
  for (const f of formats) history[f] ||= {};
  const { dates } = history;
  const n = dates.length;
  const daysBack = n >= 2 ? (Date.parse(dates[n - 1]) - Date.parse(dates[n - 2])) / DAY : 99;
  if (n && dates[n - 1] === date) {
    // overwrite
  } else if (n >= 2 && daysBack < 7) dates[n - 1] = date;
  else {
    dates.push(date);
    for (const f of formats) for (const s of Object.values(history[f])) s.push(null);
  }
  const col = dates.length - 1;
  for (const f of formats) {
    for (const r of byFormat[f] || []) {
      const s = (history[f][r.id] ||= dates.map(() => null));
      s[col] = r.v;
    }
  }
  // Trim to a year of points, and drop assets with nothing left.
  const cut = Math.max(0, dates.length - maxPoints);
  if (cut) {
    dates.splice(0, cut);
    for (const f of formats) for (const s of Object.values(history[f])) s.splice(0, cut);
  }
  for (const f of formats) for (const [id, s] of Object.entries(history[f])) if (s.every((x) => x == null)) delete history[f][id];
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
  for (const [id, s] of Object.entries(history[format] || {})) if (s[last] != null && s[then] != null) out[id] = s[last] - s[then];
  return out;
}

module.exports = { createCrawler, leagueMeta, writeIfChanged, readGlobal, addPoint, trend, readJson, DAY };
