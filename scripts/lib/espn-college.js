// College stats for the 2027 Class prospects, from ESPN's public (keyless)
// college football API. Used by scripts/refresh-prospects.js only; the page
// reads the baked result from data/prospects-2027.js.
//
// Endpoints (no key, JSON):
// - site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/<id>
//   Bio (height, weight, class) and this season's national stat ranks.
// - …/athletes/<id>/stats
//   Season totals by category (passing, rushing, receiving), one row per
//   season and team, postseason included.
// - …/athletes/<id>/gamelog?season=<year>
//   One event per game played, so its length is games played; the regular
//   season's totals also carry ESPN's adjusted QBR.
// - site.api.espn.com/apis/site/v2/sports/football/college-football/teams/<teamId>/statistics?season=<year>
//   Team season totals (postseason included, like the player rows), for the
//   share-of-offense metrics.

const ATHLETE = "https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/";
const TEAM = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/";

// ESPN's stat names → this app's short keys, per category.
const STAT_KEYS = {
  passing: { completions: "cmp", passingAttempts: "att", passingYards: "passYds", passingTouchdowns: "passTd", interceptions: "int", QBRating: "rating" },
  rushing: { rushingAttempts: "car", rushingYards: "rushYds", rushingTouchdowns: "rushTd" },
  receiving: { receptions: "rec", receivingYards: "recYds", receivingTouchdowns: "recTd" },
};

const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
const pct = (part, whole) => (whole > 0 && part != null ? Math.round((part / whole) * 1000) / 10 : null);

// One row per season and team: { year, teamSlug, teamId, team, ...stats }.
function parseSeasons(statsJson) {
  const rows = new Map();
  for (const cat of statsJson.categories || []) {
    const keys = STAT_KEYS[cat.name];
    if (!keys) continue;
    for (const st of cat.statistics || []) {
      const year = st.season?.year;
      const team = statsJson.teams?.[st.teamSlug] || {};
      const key = `${year}|${st.teamSlug}`;
      if (!rows.has(key)) rows.set(key, { year, teamSlug: st.teamSlug, teamId: team.id || null, team: team.shortDisplayName || team.location || st.teamSlug });
      const row = rows.get(key);
      cat.names.forEach((n, i) => { if (keys[n]) row[keys[n]] = num(st.stats[i]); });
    }
  }
  return [...rows.values()].sort((a, b) => a.year - b.year);
}

// Games played and regular-season adjusted QBR from one season's game log.
function parseGamelog(gamelogJson) {
  const g = Object.keys(gamelogJson.events || {}).length;
  const qbrAt = (gamelogJson.names || []).indexOf("adjQBR");
  const regular = (gamelogJson.seasonTypes || []).find((t) => /Regular Season/.test(t.displayName));
  const qbr = qbrAt >= 0 && regular ? num(regular.categories?.[0]?.totals?.[qbrAt]) : null;
  return { g, qbr: Number.isFinite(qbr) ? qbr : null };
}

function parseTeamTotals(teamJson) {
  const out = {};
  for (const c of teamJson.results?.stats?.categories || []) for (const s of c.stats) out[`${c.name}.${s.name}`] = s.value;
  return {
    g: out["general.gamesPlayed"] ?? null,
    recYds: out["receiving.receivingYards"] ?? null,
    recTd: out["receiving.receivingTouchdowns"] ?? null,
    rushYds: out["rushing.rushingYards"] ?? null,
    totalYds: out["rushing.totalYards"] ?? null,
  };
}

// Share-of-offense metrics for one season row against its team's totals:
// receiving yards and TD shares, the dominator rating (their average), rushing
// yards share, and scrimmage yards as a share of the team's total yards.
function shares(row, team) {
  if (!team) return null;
  const recYds = pct(row.recYds, team.recYds);
  const recTd = pct(row.recTd, team.recTd);
  return {
    recYds,
    recTd,
    dominator: recYds != null && recTd != null ? Math.round(((recYds + recTd) / 2) * 10) / 10 : null,
    rushYds: pct(row.rushYds, team.rushYds),
    scrimmage: row.rushYds != null || row.recYds != null ? pct((row.rushYds || 0) + (row.recYds || 0), team.totalYds) : null,
  };
}

// The first season a WR or TE hit a 20% dominator rating, the usual
// "breakout" line for college receivers.
const BREAKOUT_DOMINATOR = 20;
function breakoutYear(seasons) {
  return seasons.find((s) => s.shares?.dominator >= BREAKOUT_DOMINATOR)?.year ?? null;
}

// "6' 4\"" → "6-4".
const fmtHeight = (h) => (h ? h.replace(/(\d+)' (\d+)"/, "$1-$2") : null);

// This season's national ranks, e.g. [{ stat: "YDS", value: "763", rank: "15th" }].
const parseRanks = (athlete) =>
  (athlete.statsSummary?.statistics || []).filter((s) => s.rankDisplayValue).map((s) => ({ stat: s.abbreviation, value: s.displayValue, rank: s.rankDisplayValue }));

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 3) throw new Error(`${res.status} from ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

// Everything the page shows for one prospect. `teamCache` is shared across
// prospects so each team-season is fetched once.
async function fetchProspect(espnId, position, teamCache = new Map()) {
  const [{ athlete }, stats] = await Promise.all([getJson(`${ATHLETE}${espnId}`), getJson(`${ATHLETE}${espnId}/stats`)]);
  const seasons = parseSeasons(stats);
  const years = [...new Set(seasons.map((s) => s.year))];
  const logs = Object.fromEntries(await Promise.all(years.map(async (y) => [y, parseGamelog(await getJson(`${ATHLETE}${espnId}/gamelog?season=${y}`))])));
  for (const s of seasons) {
    const oneTeam = seasons.filter((o) => o.year === s.year).length === 1;
    s.g = oneTeam ? logs[s.year].g : null; // a mid-season transfer's games can't be split by team
    if (position === "QB") s.qbr = oneTeam ? logs[s.year].qbr : null;
    if (s.teamId) {
      const key = `${s.teamId}|${s.year}`;
      if (!teamCache.has(key)) teamCache.set(key, getJson(`${TEAM}${s.teamId}/statistics?season=${s.year}`).then(parseTeamTotals).catch(() => null));
      s.shares = shares(s, await teamCache.get(key));
    }
    delete s.teamSlug;
    delete s.teamId;
  }
  return {
    espnId: String(espnId),
    height: fmtHeight(athlete.displayHeight),
    weight: num(String(athlete.displayWeight || "").replace(/ lbs/, "")),
    classYear: athlete.displayExperience || null,
    ranks: parseRanks(athlete),
    breakout: position === "WR" || position === "TE" ? breakoutYear(seasons) : null,
    seasons,
  };
}

module.exports = { parseSeasons, parseGamelog, parseTeamTotals, shares, breakoutYear, BREAKOUT_DOMINATOR, fetchProspect };
