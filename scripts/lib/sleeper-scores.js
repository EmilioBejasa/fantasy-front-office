// Turns Sleeper's weekly stats feed into this app's WEEKLY_SCORES /
// DID_NOT_PLAY shape. Shared by index.html (loaded with a plain <script> tag,
// which exposes `window.SleeperScores`, so the page refreshes scores live on
// every load) and scripts/refresh-scores.js (require()'d, which bakes the
// same result into index.html as the offline fallback).
//
// Endpoints (both send an open CORS header):
// - api.sleeper.app/v1/state/nfl — the current season and week.
// - api.sleeper.com/stats/nfl/<season>/<week> — one row per player per game,
//   with `stats.gp` set only if they actually played and `stats.pts_ppr`
//   their PPR points (absent when it's 0).
(function (root) {
  const STATE_URL = "https://api.sleeper.app/v1/state/nfl";
  const statsUrl = (season, week) =>
    `https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular`;

  // Players whose Sleeper name doesn't match ours, by Sleeper player_id.
  const SLEEPER_ID_OVERRIDES = {
    "gainwell": "7567",       // "Kenny Gainwell"
    "hunter-travis": "12530", // listed as a DB first
    "ward-cameron": "12522",  // "Cam Ward"
  };

  // Sleeper's team codes that differ from this app's.
  const TEAM_ALIASES = { WAS: "WSH" };
  const normalizeTeam = (t) => TEAM_ALIASES[t] || t;

  const normalizeName = (s) =>
    String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");

  const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];
  // Kickers and team defenses are scored too (as extras: a defense's Sleeper id
  // is its team code, "sl-SEA"), but only skill players count toward `allowed`.
  const FANTASY_POSITIONS = [...SKILL_POSITIONS, "K", "DEF"];
  const roundPts = (pts) => Math.round((pts || 0) * 10) / 10;

  // rows: the raw stats array for one week. players: samplePlayers.
  // Returns { scores: {id: pts}, dnp: [id], teamsPlayed: [team], extras, details, allowed } —
  // scores for anyone who took a snap, DNP for anyone whose team has played
  // but who didn't. Players whose team hasn't played yet (bye, or a game later
  // in the week) are in neither, so they stay blank instead of being guessed
  // at. `extras` is every other QB/RB/WR/TE/K/DEF who played, keyed by Sleeper id
  // ({name, team, position, pts}), so rankings aren't limited to `players`
  // (see mergeExtras). `details` is each scorer's usage, keyed the same way the
  // scores end up ({opp, snap: % of team offensive snaps, tgt, car}); the page
  // shows it next to the points, the refresh script ignores it. `allowed` is
  // the PPR points each defense gave up to each position ({DEF: {WR: pts}}),
  // for the Film Room's matchup tags.
  function summarizeWeek(rows, players) {
    const byId = new Map();
    const byName = new Map();
    const teamsPlayed = new Set();
    const allowed = {};
    for (const r of rows) {
      if (!r || !r.player) continue;
      byId.set(r.player_id, r);
      if (r.stats && r.stats.gp > 0) teamsPlayed.add(normalizeTeam(r.team));
      if (r.stats && r.stats.gp > 0 && r.opponent && SKILL_POSITIONS.includes(r.player.position)) {
        const d = allowed[normalizeTeam(r.opponent)] || (allowed[normalizeTeam(r.opponent)] = {});
        d[r.player.position] = roundPts((d[r.player.position] || 0) + (r.stats.pts_ppr || 0));
      }
      const positions = r.player.fantasy_positions || [r.player.position];
      const key = normalizeName(`${r.player.first_name} ${r.player.last_name}`);
      for (const pos of positions) byName.set(`${key}|${pos}`, r);
    }

    const scores = {};
    const dnp = [];
    const details = {};
    // Kickers and defenses get just the opponent.
    const usage = (st, opp, pos) => SKILL_POSITIONS.includes(pos) ? {
      opp: normalizeTeam(opp) || null,
      snap: st.tm_off_snp ? Math.round((100 * (st.off_snp || 0)) / st.tm_off_snp) : null,
      tgt: st.rec_tgt || 0,
      car: st.rush_att || 0,
    } : { opp: normalizeTeam(opp) || null, snap: null, tgt: null, car: null };
    const matched = new Set();
    for (const p of players) {
      const override = SLEEPER_ID_OVERRIDES[p.id];
      const row = override ? byId.get(override) : byName.get(`${normalizeName(p.name)}|${p.position}`);
      if (row) matched.add(row.player_id);
      if (row && row.stats && row.stats.gp > 0) {
        scores[p.id] = roundPts(row.stats.pts_ppr);
        details[p.id] = usage(row.stats, row.opponent, p.position);
      } else if (teamsPlayed.has(row ? normalizeTeam(row.team) : p.team) || (p.team === "FA" && teamsPlayed.size > 0)) {
        dnp.push(p.id); // free agents count as not playing once the week has started
      }
    }

    const extras = {};
    for (const r of rows) {
      if (!r || !r.player || matched.has(r.player_id) || !(r.stats && r.stats.gp > 0)) continue;
      if (!FANTASY_POSITIONS.includes(r.player.position)) continue;
      extras[r.player_id] = {
        name: `${r.player.first_name} ${r.player.last_name}`,
        team: normalizeTeam(r.team),
        position: r.player.position,
        pts: roundPts(r.stats.pts_ppr),
      };
      details[`sl-${r.player_id}`] = usage(r.stats, r.opponent, r.player.position);
    }
    return { scores, dnp: dnp.sort(), teamsPlayed: [...teamsPlayed].sort(), extras, details, allowed };
  }

  // byWeek: {week: summarizeWeek result}. Folds every week's `extras` into the
  // scores (under "sl-<sleeper id>") and returns the players to add to the
  // pool: anyone who has scored any points this season. Players who only ever
  // logged zeros (blockers, backup QBs who knelt) are left out. Extras get no
  // OUT marks — they're blank in weeks they didn't play.
  function mergeExtras(byWeek) {
    const totals = {};
    const latest = {};
    const weeks = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
    for (const w of weeks) {
      for (const [sid, e] of Object.entries(byWeek[w].extras || {})) {
        totals[sid] = (totals[sid] || 0) + Math.abs(e.pts);
        latest[sid] = e;
      }
    }
    const keep = Object.keys(totals).filter((sid) => totals[sid] > 0);
    const scores = {};
    for (const w of weeks) {
      scores[w] = { ...byWeek[w].scores };
      for (const sid of keep) {
        const e = (byWeek[w].extras || {})[sid];
        if (e) scores[w][`sl-${sid}`] = e.pts;
      }
    }
    const players = keep
      .map((sid) => ({ id: `sl-${sid}`, name: latest[sid].name, team: latest[sid].team, position: latest[sid].position, extra: true }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { scores, players };
  }

  // sleeperPlayers: {sleeperId: {name, position}} (e.g. the trimmed
  // /players/nfl map). Returns {ourId: sleeperId} for every player in `pool`
  // that could be matched.
  function matchSleeperIds(pool, sleeperPlayers) {
    const byName = new Map();
    for (const id in sleeperPlayers) {
      const p = sleeperPlayers[id];
      byName.set(`${normalizeName(p.name)}|${p.position}`, id);
    }
    const out = {};
    for (const p of pool) {
      const id = SLEEPER_ID_OVERRIDES[p.id] || byName.get(`${normalizeName(p.name)}|${p.position}`);
      if (id && sleeperPlayers[id]) out[p.id] = id;
    }
    return out;
  }

  async function fetchState() {
    const res = await fetch(STATE_URL);
    if (!res.ok) throw new Error(`Sleeper state fetch failed (${res.status})`);
    return res.json();
  }

  async function fetchWeek(season, week, players) {
    const res = await fetch(statsUrl(season, week));
    if (!res.ok) throw new Error(`Sleeper Week ${week} stats fetch failed (${res.status})`);
    return summarizeWeek(await res.json(), players);
  }

  // Weeks 1 through Sleeper's current week, during the regular season.
  function weeksToFetch(state) {
    if (state.season_type !== "regular") return state.season_type === "post" ? range(18) : [];
    return range(Math.min(state.week, 18));
  }
  const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

  // Whether a week's games are all over, so its scores can be cached for
  // longer. Sleeper moves `week` on ahead of Monday night's game being final
  // and `display_week` a day or so later, so the earlier of the two is the
  // week still in progress.
  function isWeekFinal(state, week) {
    if (state.season_type === "post") return true;
    return week < Math.min(state.week, state.display_week || state.week);
  }

  const api = { summarizeWeek, mergeExtras, matchSleeperIds, normalizeName, normalizeTeam, fetchState, fetchWeek, weeksToFetch, isWeekFinal, SLEEPER_ID_OVERRIDES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SleeperScores = api;
})(typeof window !== "undefined" ? window : globalThis);
