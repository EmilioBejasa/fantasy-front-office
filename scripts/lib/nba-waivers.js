// Picks the basketball Waiver Desk's daily pickup list (data/nba-waivers.js,
// by scripts/refresh-nba-waivers.js) from Sleeper's data: recent games,
// minutes, Sleeper adds, injured teammates and games left this fantasy week.
// The football list is written by hand once a week; this one changes every
// day, so it's worked out from the numbers and the notes are written from them.
//
// Sleeper doesn't say how widely a player is rostered, so its preseason ADP
// stands in: anyone drafted inside the top LIKELY_ROSTERED_ADP is assumed to
// be on a roster already. (The page's "Your league" bar marks the real owners.)

const LIKELY_ROSTERED_ADP = 130;
const RECENT_GAMES = 5;      // the last few games played, from the last two fantasy weeks
const MIN_MINUTES = 20;      // per game over those games
const STAR_FPG = 30;         // a teammate this good being out opens up minutes
const OUT = ["Out", "IR", "Sus"];
const CAPS = { "Must Add": 6, "Speculative": 5, "Streamer": 5, "Deep League": 5 };
const PRIORITIES = Object.keys(CAPS);

const round1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => n.toFixed(1);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Games per team this fantasy week (not yet played, from `today` on) and next.
function teamGames(schedule, week, today) {
  const out = {};
  for (const g of schedule || []) {
    if (g.week !== week && g.week !== week + 1) continue;
    for (const t of [g.home, g.away]) {
      const c = out[t] || (out[t] = { left: 0, next: 0 });
      if (g.week === week) { if (!g.done && g.date >= today) c.left++; } else c.next++;
    }
  }
  return out;
}

// state: Sleeper's NBA state. season / previous: season totals. weeks: the
// last two fantasy weeks' games (fetchWeek). projections: for ADP. players:
// the trimmed player map (team, injury status). adds: Sleeper's trending adds
// [{player_id, count}]. points: (stats) => fantasy points.
function pickNbaWaivers({ state, season, previous, weeks, projections, players, adds, schedule, points, today }) {
  if (state.season_type !== "regular") return [];
  const adp = Object.fromEntries((projections || []).map((p) => [p.id, p.adp]));
  const addsBy = Object.fromEntries((adds || []).map((a) => [String(a.player_id), a.count]));
  const seasonBy = Object.fromEntries((season || []).map((p) => [p.id, p]));
  const prevBy = Object.fromEntries((previous || []).map((p) => [p.id, p]));
  const games = teamGames(schedule, state.week, today);
  const fpg = (p) => (p && p.gp ? points(p.stats) / p.gp : null);

  // Injured players good enough that their minutes go somewhere, by team.
  const outStars = {};
  for (const [id, p] of Object.entries(players)) {
    if (!OUT.includes(p.status)) continue;
    const cur = seasonBy[id];
    const level = cur && cur.gp >= 3 ? fpg(cur) : fpg(prevBy[id]) ?? fpg(cur);
    if (level >= STAR_FPG) (outStars[p.team] || (outStars[p.team] = [])).push({ name: p.name, level });
  }
  for (const list of Object.values(outStars)) list.sort((a, b) => b.level - a.level);

  const recentGames = {};
  for (const wk of weeks) for (const p of wk) for (const g of p.games) (recentGames[p.id] || (recentGames[p.id] = [])).push(g);

  const rows = [];
  for (const [id, all] of Object.entries(recentGames)) {
    const p = players[id];
    if (!p || OUT.includes(p.status)) continue;
    if (adp[id] && adp[id] <= LIKELY_ROSTERED_ADP) continue;
    const last = all.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, RECENT_GAMES);
    if (last.length < 2) continue;
    const recent = last.reduce((s, g) => s + points(g.stats), 0) / last.length;
    const minutes = last.reduce((s, g) => s + (g.stats.sp || 0), 0) / last.length / 60;
    if (minutes < MIN_MINUTES) continue;
    // The same baseline as the page's "Heating up": this season's other games,
    // or last season while there are fewer than 3 of them.
    const cur = seasonBy[id];
    const earlier = cur ? cur.gp - last.length : 0;
    const base = earlier >= 3
      ? { base: (points(cur.stats) - recent * last.length) / earlier, vs: "before" }
      : prevBy[id] ? { base: fpg(prevBy[id]), vs: "last season" } : { base: null, vs: null };
    const g = games[p.team] || { left: 0, next: 0 };
    rows.push({
      id, name: p.name, team: p.team, position: p.position, status: p.status || null,
      recent, minutes, gp: last.length, ...base, adds: addsBy[id] || 0, left: g.left, next: g.next,
      opening: (outStars[p.team] || [])[0]?.name || null,
    });
  }

  const jump = (r) => (r.base == null ? null : r.recent - r.base);
  const rules = {
    "Must Add": (r) => r.recent >= 30 && (r.adds >= 3000 || jump(r) >= 5 || (r.base == null && r.recent >= 33)),
    "Speculative": (r) => r.recent >= 22 && (r.opening || (jump(r) >= 6 && r.adds >= 2000)),
    "Streamer": (r) => r.recent >= 24 && r.left >= 3,
    "Deep League": (r) => r.recent >= 22,
  };
  // Recent points first, with up to 6 more for being widely added (one per
  // 5,000 adds), so the waiver run of the day isn't squeezed out by the caps.
  const rank = (r) => r.recent + Math.min(r.adds / 5000, 6);
  const picked = [];
  const taken = new Set();
  for (const priority of PRIORITIES) {
    rows
      .filter((r) => !taken.has(r.id) && rules[priority](r))
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, CAPS[priority])
      .forEach((r) => { taken.add(r.id); picked.push({ ...r, priority }); });
  }
  return picked.map((r) => ({
    id: r.id, name: r.name, team: r.team, position: r.position, priority: r.priority, note: noteFor(r),
    recent: round1(r.recent), base: r.base == null ? null : round1(r.base), minutes: round1(r.minutes),
    gp: r.gp, adds: r.adds, left: r.left, next: r.next,
  }));
}

function noteFor(r) {
  const parts = [`${fmt(r.recent)} points a game over his last ${plural(r.gp, "game")} in ${Math.round(r.minutes)} minutes a night`];
  if (r.base != null) parts[0] += r.recent > r.base ? `, up from ${fmt(r.base)} ${r.vs}` : ` (${fmt(r.base)} ${r.vs})`;
  parts[0] += ".";
  if (r.opening) parts.push(`${r.opening} is out.`);
  if (r.adds >= 1000) parts.push(`${r.adds.toLocaleString("en-US")} adds on Sleeper in the last day.`);
  // Games left change through the day, so the page shows them live instead.
  if (r.priority === "Streamer") parts.push(`${r.team} plays ${plural(r.left, "game")} the rest of this week.`);
  if (r.status) parts.push(`Listed ${r.status}.`);
  return parts.join(" ");
}

module.exports = { pickNbaWaivers, teamGames, LIKELY_ROSTERED_ADP, PRIORITIES };
