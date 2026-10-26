// NBA data from Sleeper for the basketball (season-long / redraft) side of
// the site. Loaded by index.html with a plain <script> tag, which exposes
// `window.SleeperNBA`.
//
// Endpoints (all send an open CORS header):
// - api.sleeper.app/v1/state/nba — the current season ("2026" = 2026-27),
//   season type (pre / regular / post) and fantasy week.
// - api.sleeper.com/stats/nba/<season>?season_type=regular — season totals,
//   one row per player, with `gp` and the player's name/team/positions.
// - api.sleeper.com/stats/nba/<season>/<week>?season_type=regular — every
//   game in one fantasy week (Monday to Sunday), one row per player per game
//   with its date. A game a player sat out comes through with empty stats, so
//   a game counts only if `sp` (seconds played) is above 0. (The older
//   api.sleeper.app/v1/stats/nba/regular/<season>/<week> feed only returns each
//   player's last game of the week, so it isn't used.)
// - api.sleeper.app/v1/players/nba — every player with injury designations
//   (~2.5MB; trimmed and cached, as Sleeper asks).
// - api.sleeper.app/v1/players/nba/trending/<add|drop> — Sleeper add/drop counts.
// - api.sleeper.app/schedule/nba/regular/<season> — every game of the season
//   with its date, fantasy week, teams and status (finished games also carry
//   box scores, so it's trimmed before caching).
// - api.sleeper.com/projections/nba/<season>?season_type=regular — Sleeper's
//   season projections: one per-game stat line per player (`gp` is 1), plus
//   its redraft ADP (`adp_std`).
(function (root) {
  const API = "https://api.sleeper.app/v1";
  const STATS = "https://api.sleeper.com/stats/nba";

  // Points-league scoring presets. Standard is the NBA's official fantasy
  // scoring, which Yahoo uses as its default; ESPN is ESPN's default points
  // league (2020 onward), which also charges for missed shots.
  const SCORING = {
    standard: { pts: 1, reb: 1.2, ast: 1.5, stl: 3, blk: 3, to: -1 },
    espn: { pts: 1, tpm: 1, fgm: 2, fga: -1, ftm: 1, fta: -1, reb: 1, ast: 2, stl: 4, blk: 4, to: -2 },
  };

  // Only the stats the app uses, so cached data stays small.
  const KEEP = ["pts", "reb", "ast", "stl", "blk", "to", "tpm", "fgm", "fga", "ftm", "fta", "dd", "td", "sp"];
  const trim = (stats) => {
    const out = {};
    for (const k of KEEP) if (stats[k]) out[k] = stats[k];
    return out;
  };

  const fantasyPoints = (stats, scoring) =>
    Object.entries(SCORING[scoring] || SCORING.standard).reduce((s, [k, w]) => s + w * (stats[k] || 0), 0);

  const isPlayer = (r) => r && r.player && !String(r.player_id).startsWith("TEAM");
  const info = (r) => ({
    id: String(r.player_id),
    name: `${r.player.first_name} ${r.player.last_name}`,
    position: r.player.position,
    positions: r.player.fantasy_positions || [r.player.position],
    team: r.team || r.player.team || null,
  });

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sleeper request failed (${res.status})`);
    return res.json();
  }

  const fetchState = () => getJson(`${API}/state/nba`);

  // Season totals: [{ id, name, position, positions, team, gp, stats }].
  async function fetchSeason(season) {
    const rows = await getJson(`${STATS}/${season}?season_type=regular`);
    return (rows || [])
      .filter((r) => isPlayer(r) && r.stats && r.stats.gp > 0)
      .map((r) => ({ ...info(r), gp: r.stats.gp, stats: trim(r.stats) }));
  }

  // One fantasy week: [{ id, name, position, positions, team, games: [{ date, opp, stats }] }].
  async function fetchWeek(season, week) {
    const rows = await getJson(`${STATS}/${season}/${week}?season_type=regular`);
    const byPlayer = {};
    for (const r of rows || []) {
      if (!isPlayer(r) || !r.stats || !(r.stats.sp > 0)) continue;
      const p = byPlayer[r.player_id] || (byPlayer[r.player_id] = { ...info(r), games: [] });
      p.games.push({ date: r.date, opp: r.opponent, stats: trim(r.stats) });
    }
    for (const p of Object.values(byPlayer)) p.games.sort((a, b) => (a.date < b.date ? -1 : 1));
    return Object.values(byPlayer);
  }

  // Every rostered NBA player, trimmed: { [id]: { name, position, positions, team, status, injury, notes, age } }.
  async function fetchPlayers() {
    const all = await getJson(`${API}/players/nba`);
    const out = {};
    for (const id in all) {
      const p = all[id];
      if (!p || !p.team || !p.active) continue;
      out[id] = {
        name: p.full_name || `${p.first_name} ${p.last_name}`, position: p.position,
        positions: p.fantasy_positions || [p.position], team: p.team, age: p.age || null,
        status: p.injury_status || null, injury: p.injury_body_part || null, notes: p.injury_notes || null,
      };
    }
    return out;
  }

  // Season projections: [{ id, name, position, positions, team, stats, adp }],
  // stats being a projected per-game line.
  async function fetchProjections(season) {
    const rows = await getJson(`https://api.sleeper.com/projections/nba/${season}?season_type=regular`);
    return (rows || [])
      .filter((r) => isPlayer(r) && r.stats && r.stats.pts > 0)
      .map((r) => ({ ...info(r), stats: trim(r.stats), adp: r.stats.adp_std || null }));
  }

  // The season schedule, trimmed: [{ date, week, home, away, done }].
  async function fetchSchedule(season) {
    const games = await getJson(`https://api.sleeper.app/schedule/nba/regular/${season}`);
    return (games || []).filter((g) => g.home && g.away).map((g) => ({
      date: g.date, week: g.week, home: g.home.team, away: g.away.team, done: g.status === "complete",
    }));
  }

  const fetchTrending = (direction, limit = 25) =>
    getJson(`${API}/players/nba/trending/${direction}?lookback_hours=24&limit=${limit}`);

  const api = { SCORING, fantasyPoints, fetchState, fetchSeason, fetchWeek, fetchPlayers, fetchTrending, fetchProjections, fetchSchedule };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SleeperNBA = api;
})(typeof window !== "undefined" ? window : globalThis);
