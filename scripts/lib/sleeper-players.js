// Sleeper's full NFL player list (api.sleeper.app/v1/players/nfl, ~15MB, ~2.5MB
// gzipped), trimmed to rostered QB/RB/WR/TE with only the fields the app uses
// (~150KB). Shared by index.html (loaded with a plain <script> tag, which
// exposes `window.SleeperPlayers`) and scripts/refresh-players.js, which bakes
// the trimmed map into data/nfl-players.js so most visits never download the
// full list.
(function (root) {
  const URL = "https://api.sleeper.app/v1/players/nfl";
  const SKILL_POSITIONS = ["QB", "RB", "WR", "TE"];

  function trimPlayers(all) {
    const trimmed = {};
    for (const id in all) {
      const p = all[id];
      if (p && SKILL_POSITIONS.includes(p.position) && p.team) {
        trimmed[id] = {
          name: p.full_name, position: p.position, team: p.team, status: p.injury_status || null,
          injury: p.injury_body_part || null, notes: p.injury_notes || null,
          // Bio lines for player profiles.
          age: p.age || null, number: p.number ?? null, height: p.height || null, weight: p.weight || null,
          college: p.college || null, exp: p.years_exp ?? null,
        };
      }
    }
    return trimmed;
  }

  async function fetchPlayers() {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Sleeper player lookup failed (${res.status})`);
    return trimPlayers(await res.json());
  }

  const api = { trimPlayers, fetchPlayers };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SleeperPlayers = api;
})(typeof window !== "undefined" ? window : globalThis);
