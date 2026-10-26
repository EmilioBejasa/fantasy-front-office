# Fantasy Front Office

*Run your fantasy team like a GM.* (Formerly FF ValueDiff. The local repo
folder and the `ff-valuediff:` browser-storage keys still use the old name,
so saved settings carry over.)

A fantasy football companion. Three tabs cover this season, on one shared player pool:
**Weekly Scores** (real results by week, or a full-season grid),
**Waiver Wire Targets** (live Sleeper trending activity plus a hand-picked
pickup list), and **Injuries** (a live weekly injury report, plus who's out for the season or on IR/PUP,
and the earliest week each player can return). Three more cover dynasty
leagues: **Dynasty Values** (live trade values for every player and rookie
pick), a **Trade Calculator** (plus every team in a Sleeper league ranked by
value), and a **2027 Class** preview of next year's rookies.

There's also a **basketball** side for season-long (redraft) points
leagues, with five rooms: Scoreboard, Waiver Desk, Training Room, Big Board
and Trade Desk. See "Basketball" below. A Football | Basketball switch in
the header moves between the two sports.

## Running it

**Live site:** https://emiliobejasa.github.io/fantasy-front-office/ — hosted free on
GitHub Pages and deployed by `.github/workflows/deploy.yml` (Pages' source is
set to "GitHub Actions"). It runs `scripts/build.js`, which writes `dist/`:
the same files, except `index.html`'s JSX is compiled and minified ahead of
time with esbuild and Tailwind is a prebuilt `tailwind.css`. Visitors don't
download Babel (~630KB) or the Tailwind Play CDN script, or wait for them to
run. Local scripts get a content hash in their URL (`?v=`), and the data
files the page loads on demand get the deploy's `BUILD_ID`, so an update is
never stuck behind a cached copy. The deploy runs on every push to `master`
and after each data-refresh Action (a push made by a workflow's own token
doesn't start other workflows, so it listens for them with `workflow_run`).
So the live site picks up new scores and values on its own.

`index.html` itself is never rewritten by the build. It still runs as is
(in-browser Babel and the Tailwind CDN) when double-clicked or served
locally, and the refresh scripts keep editing its data blocks in place. To
try the built version locally: `npm install --no-save esbuild@0.24.0
tailwindcss@3.4.17`, `node scripts/build.js`, then serve `dist/`.

**On a phone:** open the live site, then Share → **Add to Home Screen**
(Safari) or ⋮ → **Install app** (Chrome). It opens full screen like an
app, with the FFO icon. That's set up by `manifest.webmanifest` and the
`icon-*.png` / `apple-touch-icon.png` files; there's no service worker, since
the site needs live data anyway.

**Link previews:** the Open Graph tags in `<head>` give the link a title card
with `og-image.png` (1200×630) when it's pasted in Discord, iMessage or X.
The tags use absolute URLs to the live site, so update them if the address
ever changes.

To run it locally instead: no build step, no install. Just open `index.html` in a browser (double-click it,
or drag it into a browser window). It loads React and Babel from a CDN and
transforms the JSX in-browser.

The live data (the basketball side, and the "Trending on Sleeper" panel on
Waiver Wire Targets) needs the page served over http(s) with network
access, since `fetch` calls from a `file://` page hit browser restrictions
that a real server doesn't. From a double-clicked file the basketball pages
fall back to the daily snapshot in `data/nba-snapshot.js` instead. Any static file server
works, e.g. `python -m http.server` from this directory, then open
`http://localhost:8000/index.html`. Everything else in the app (Weekly
Scores, the hand-picked Waiver Wire list, Injured Reserve) works fine from a
plain double-clicked file too.

## Site layout

The page is laid out like a website, themed as an **executive front office**
(the site shell section at the bottom of `index.html`, styles in `<head>`):

- **Look:** navy and brass. There's a navy header with a brass trim line and
  a brass nameplate logo ("FFO"). Light mode uses warm paper tones and dark
  mode a night-office navy. Page and section titles are set in the Fraunces
  serif, body text in Inter (both from Google Fonts).
- **Every tool is a room in the office** (the `short` name in `PAGES`):
  | Room | Tool |
  |---|---|
  | Scoreboard | Weekly Scores |
  | Waiver Desk | Waiver Wire Targets |
  | Training Room | Injuries |
  | Film Room | Weekly Rankings (and Start / Sit) |
  | Boardroom | My Leagues |
  | Value Board | Dynasty Values |
  | Trade Desk | Trade Calculator |
  | Scouting Dept. | 2027 Rookie Class |

  The nav, home folder tabs, page labels and browser tab titles use the room
  name. The page heading still says what the tool is.
- **Home page** (the Lobby, `#/`): a "Run your fantasy team like a GM"
  intro and buttons into the Trade Desk and Scoreboard. Each tool is a
  **manila folder** card with its room on the tab. Below them are the
  biggest 30-day risers in dynasty value.
- **Sport switch:** a Football | Basketball control next to the logo
  (`SportSwitch`), green for football and orange for basketball like
  Sleeper's sport colors (`color` in `SPORTS`). The same color carries
  through the site as `--sport` (set by `data-sport` on `<html>`): the
  header trim, active nav underline, Trade Desk and other main buttons,
  links, row and menu hovers and focus rings. The logo and home headline
  stay brass. Switching keeps you in the same room when the other sport
  has one (Scoreboard → Scoreboard), otherwise it opens that sport's first
  room. On the home page it just changes which sport the nav shows
  (remembered in `ff-valuediff:sport`).
- **Sticky top navigation** with two dropdowns per sport: *Game week* and
  *Dynasty* for football, *Game week* and *Front office* for basketball
  (`NavDropdown`). Each lists its rooms with an icon and a one-line
  description. They open on hover or click and close on outside click,
  Escape or picking a room. A brass **Trade Desk** button sits on the right.
  Below 768px wide it all becomes a hamburger menu. A sun/moon
  button switches light and dark. It follows the OS until used, then
  remembers the choice (`ff-valuediff:theme`). The choice is applied in
  `<head>` before render, so there's no flash.
- **Every page has its own URL**: `#/scores`, `#/waivers`, `#/injuries`,
  `#/leagues`, `#/values`, `#/trade`, `#/2027`, and for basketball `#/nba/scores`,
  `#/nba/waivers`, `#/nba/injuries`, `#/nba/rankings`, `#/nba/trade`. So the
  back button, bookmarks and reloads all work. A trade link (`#trade=…`, or
  `#nbatrade=…` for basketball) opens that Trade Desk with the trade, and
  leaving and coming back keeps it.
- **Player search (the Front Desk):** a "Search players" box in the header
  (a magnifier icon on smaller screens), also opened with Ctrl/Cmd+K or `/`
  from any page (`PlayerSearch`). Results show a headshot, position, team and
  injury tag; arrow keys and Enter open the player's file. A Football | Basketball
  switch picks which players it searches. Football searches Sleeper's player
  list plus the dynasty values, and valued players rank first. Basketball
  loads the NBA data the first time it's searched, and ranks by points this
  season. A name matches when each word you type starts one of its words
  ("jef", "jus jef"), then when the name just contains it.
- **Phone tab bar:** below 768px a navy bar at the bottom of the screen links
  the rooms people open most (`MobileTabBar`, `TAB_BAR`). Football: Scoreboard,
  Waiver Desk, Film Room, Trade Desk, Boardroom. Basketball: Scoreboard, Waiver
  Desk, Big Board, Trade Desk, Training Room. The hamburger still lists every
  room. On the home page, phones get the Football | Basketball switch under the
  intro (the header one is desktop-only), and the chosen sport's rooms are
  listed first, matching the tab bar.
- **Week pickers** stay on one line and scroll sideways on narrow screens,
  with the selected week scrolled into view (`PillGroup`'s `scroll`).
- A **footer** with links to every room and the data sources (Sleeper,
  FantasyCalc, DraftSharks, Yahoo Sports).
- **Color:** each tool keeps its own color and icon (`PAGE_STYLE`), used on
  its folder, its nav underline and the label above its title.
  - **Controls match their page:** every filter, setting and toggle on a page
    fills with that page's color (`--page-hue` on `<main>`, darkened a little
    as `--page-accent` so white labels stay readable), so no lone switch
    stands out. Only the Football | Basketball switches use the sport colors.
  - The `PosBadge` chips in tables use position colors (QB blue, RB orange,
    WR green, TE gold, picks pink, `POS_PILL_COLOR`). Trade sides are blue (A)
    and orange (B).
  - Value trends are green up and red down.
- **Favicon:** `favicon.svg`, a navy plaque with a brass "F" monogram.
- **Segmented controls:** each group of filter or setting options (format,
  QB, teams, scoring, TE premium, positions, weeks, views, adds/drops) is one
  rounded track. The highlight slides to the selected option (`PillGroup`,
  `.segmented` / `.seg`), in the page's color.
- **Less boxy pages:** the longer "where this data comes from" notes under
  each page title sit behind an **About this data** toggle (`AboutData`).
  The Sleeper league instructions stay visible. Panels have rounder corners,
  lighter edges and a soft shadow, and table headers have a tinted band.
- **Buttons:** standalone toggles (Raw values, Clear trade, +A / +B) use one shared `.pill` style. It
  tints on hover, presses down on click, and when selected fills with its
  color (set through `--pill-accent`) and a soft glow. Main actions are
  polished brass buttons that lift on hover, and table and team rows
  highlight on hover.

## Weekly Scores

Every player in the database for a given week, ranked highest to lowest by
that week's actual PPR fantasy points, or as a full Week 1-18 season grid
with a running total/average. The position filter defaults to **RB**, and
its buttons are ordered RB, WR, QB, TE, ALL — skill positions people are
actually checking waivers/streamers for first, the unfiltered view last.
Each week's by-week view also shows that week's real bye teams (the full
2026 schedule, Weeks 5-14, hard-coded in `BYE_WEEKS` in `index.html`) —
that part is known for the whole season in advance, so it's shown
regardless of whether the week's games have happened.

Scores themselves are **real results, not projections or fabricated
numbers**, from Sleeper's stats API (`https://api.sleeper.com/stats/nfl/2026/<week>`,
the `pts_ppr` field). They **update automatically**: on every page load the
app asks Sleeper for the current week (`/v1/state/nfl`) and pulls every
week played so far, so new weeks, in-progress games and stat corrections
show up without editing anything. Each week's trimmed result is cached in
`localStorage` (finished weeks for 6 hours, the current week for 5 minutes).
While a week is in progress, the by-week view lists the teams **still to
play**; their players stay blank until their game is in. The by-week
selector only offers weeks with real scores and opens on the latest one. The
season grid still shows all 18 week columns, blank until played.

The fetch-and-match logic lives in `scripts/lib/sleeper-scores.js`, which
the page loads with a plain `<script>` tag. Players are matched to Sleeper by
name and position, plus a short `SLEEPER_ID_OVERRIDES` list for names that
differ (e.g. "Kenny" Gainwell, "Cam" Ward). Sleeper's `WAS` is mapped to this
app's `WSH`. If you add a player whose Sleeper name differs, add them there.

`WEEKLY_SCORES` and `DID_NOT_PLAY` in `index.html` are a **baked-in
snapshot**, shown until live data arrives and used if Sleeper can't be
reached. To refresh the snapshot, run `node scripts/refresh-scores.js` (Node
18+, `--dry-run` to preview). A GitHub Action
(`.github/workflows/refresh-scores.yml`) also runs it daily at 10:00 UTC
and commits `index.html` when scores change; it can be run by hand from
the repo's Actions tab too. As of 2026-10-06 it holds all of Weeks 1-4,
including the Monday night NO@ATL game.

**OUT and IR instead of 0.** `WEEKLY_SCORES` only lists players who
actually played. Players whose team played but who didn't are listed in
`DID_NOT_PLAY` and show **OUT**, both in the grid and at the bottom of the
by-week table. Weeks inside an Injured Reserve stint show **IR** instead,
including future weeks up to the player's earliest possible return (or the
rest of the season for season-ending injuries). OUT and IR weeks don't
count toward GP or AVG.

**Usage columns.** On desktop the by-week table also shows each scorer's
opponent, share of the team's offensive snaps, targets and carries, from the
same live feed (`details` in `summarizeWeek`). They're blank on the saved
snapshot.

## Weekly Rankings (Film Room)

`#/rankings` (`NflRankings`) ranks every QB, RB, WR and TE by Sleeper's
projected points for the week (`fetchWeekProjections`), in the shared
Scoring setting: Sleeper's own `pts_ppr`, `pts_half_ppr` or `pts_std`. TE
premium adds its bonus for each projected TE catch (`projectedPoints`).
Each row shows the position rank, team, matchup and the player's Sleeper
injury designation. The matchup (`Matchup`) is home or away and the game
day, from Sleeper's season schedule (`fetchNflSchedule`, no kickoff times),
plus a tag: **Good** when the opponent is one of the 8 defenses allowing the
most PPR points per game to that position this season, **Tough** for the 8
allowing the least (`defenseRanks`, built from `allowed` in the live weekly
stats; hover for the numbers). Players on bye have no projection, so they aren't
listed. It opens on the current week (`/state/nfl`), with the next week one
click away, and shows the top 150 for the chosen position.

**Start / Sit** sits above the table. Add two to four players, from the
search box or each row's **+**. The best projection among those who can play
gets **Start**. The rest get **Sit**, with how many points they trail by.
Anyone out for the season, on IR, PUP or the suspended list, or ruled Out is
marked to sit with the reason (`sidelinedReason`), whatever their projection.

## Waiver Wire Targets

Two parts, one live and one hand-curated:

**Trending on Sleeper** (top of the page) is a **live** panel — Sleeper's
API sends an open CORS header, so a browser tab can call it directly with no
refresh script or extension needed. It shows the top players being added
(or, via the toggle, dropped) across real Sleeper leagues in the last 24
hours, straight from Sleeper's own trending-add/drop endpoint, refetched on
every page load. This is raw community activity — add/drop counts only, no
reasoning — which is what distinguishes it from the curated list below.

Turning player IDs into names (and the live injury report) needs Sleeper's
`/players/nfl` list: ~15MB, ~2.5MB gzipped. So `scripts/refresh-players.js`
trims it to rostered QB/RB/WR/TE and the fields the app uses
(`scripts/lib/sleeper-players.js`) and writes `data/nfl-players.js` (~150KB,
~30KB gzipped). `.github/workflows/refresh-players.yml` runs it every 3 hours,
since injury designations change through the day. The page loads that file
on demand (`fetchSleeperPlayerMap`) and caches it in `localStorage` for 6
hours (`SLEEPER_PLAYERS_CACHE_KEY`). Only if the file is missing or more
than 12 hours old does it fetch the full list from Sleeper itself.

**Your league** (`MyLeagueBar`, both Waiver Desks): connect a Sleeper
username (or league ID) and pick a league. **Available only** then hides
anyone already on a roster in it, and **Everyone** shows them tagged
"Rostered". The choice is saved per sport (`ff-valuediff:my-league`:
league ID, name, user ID and the toggle; rosters are fetched fresh each
visit and on the refresh tick, `useMyLeagueState`). It also stars **your**
players (★) wherever a player name link appears, puts a "Your league" link on
the home page, and can be set from a Boardroom league page (**Make this my
league**).

Below that is the **hand-picked** list, labeled with the week it's for
(`WAIVER_TARGETS_WEEK`) and when it was updated. Once Sleeper's current week
moves past that week, an amber note says the list hasn't been rebuilt yet,
so stale notes don't pass as current. Each entry is tagged with a priority
(Must Add / Speculative / Streamer / Deep League) and a one-line reason.
It's a single **always-current** list (`WAIVER_TARGETS` in `index.html`, a
flat array) meant to reflect this week's best targets, replaced wholesale as
the season moves on rather than accumulating a new dated list every week —
sorted by priority (Must Add first, Deep League last) regardless of the
order entries were added in. There's no live ownership/snap-share source to
pull this part from (that's what the Sleeper panel above is for), so it's
edited by hand — update `WAIVER_TARGETS` (and `WAIVER_TARGETS_WEEK` /
`WAIVER_TARGETS_UPDATED_ON`) as real in-season news (injuries, depth-chart
moves, snap counts) comes in.

If `WAIVER_TARGETS` is ever emptied out, the page shows an explicit
"nothing added yet" state rather than a guess. As of this writing (2026-10-20) it holds
20 Week 7 targets, based on Week 3-6 usage, Sleeper's injury designations
and its most-added list rather than preseason guesses: injury vacancies
(Davante Adams out 6-10 weeks; Pittman, Doubs, Shipley and Bigsby on IR; Barkley,
Monangai and Bateman out; Hurts out for the season), target/snap share winners,
and streamers. BUF, JAX, LAC and WSH are on bye in Week 7, so none of their
players are listed.

## Injuries

**This Week's Injury Report** (top of the tab) is **live**: every player in
the pool, plus the waiver targets, whose current Sleeper designation is
Questionable, Doubtful, Out or not active (e.g. Lamar Jackson, questionable
with an ankle injury). Each row shows the injury and how the player's most
recent game went. It comes from the same `/players/nfl` payload as the
trending panel, now cached for 6 hours instead of 24 because designations
change daily. Official injury reports come out Wednesday through Friday, so
early in the week a designation may be carried over from the last game.

Below that, the hand-kept IR lists: every fantasy-relevant player who's out for the season or on injured
reserve or reserve/PUP (`INJURED_RESERVE` in `index.html`). Both lists mean
at least four games out. Each entry has the injury, the week the current
absence started (`sinceWeek`, 1 for players who started the season there)
and, unless it's season-ending, the **earliest return** week: four team
games after `sinceWeek`, skipping the team's bye (`irReturnWeek`). That
date is a minimum, and many players take longer.

As of 2026-10-21 it holds 51 players, from Sleeper's injury designations
(IR/PUP) plus team news (newest: Davante Adams, ruptured hamstring and
surgery, back Week 12 at the earliest after the Rams' Week 11 bye). Nine are season-ending: Achane (torn ACL), Dart
(knee surgery), Jayden Higgins (torn ACL), Pearsall (PCL surgery), Hurts
(blood clots), Jayden Reed (neck surgery), Jaylin Lane (ankle fracture),
Durham Smythe (torn Achilles) and Josh Oliver (torn biceps). Entries can
use an extra player's `sl-` id too. Edit the list by hand as
players are placed on or activated from IR. The same list drives the IR
cells in Weekly Scores.

## Dynasty tabs

**Values default to KeepTradeCut.** Every football value in the app (Value
Board, War Room, Trade Desk, league pages, profiles, home-page risers) is
KTC's (`applyMarketValues` in `useDynastyValues`), from the daily
`data/market-values.js` (see "Consensus across calculators" below):

- dynasty uses KTC's dynasty values, and KTC's redraft values for the
  this-season comparisons (Win-now / Future tags, a team's lean); redraft
  uses KTC redraft for both;
- FantasyCalc still supplies the player list (names, ages, teams, picks).
  Players KTC doesn't list keep FantasyCalc's value, rescaled to KTC's scale
  by the KTC ÷ FantasyCalc ratio of the 10 players nearest them in value
  (`marketRescaler`). FantasyCalc's generic "2027 1st" is KTC's mid 1st;
- the 30-day trend is KTC's (`trends` in `data/market-values.js`, from the
  weekly history), falling back to FantasyCalc's;
- KTC's values don't change with league size or scoring, so those settings
  only affect the FantasyCalc fallbacks and the trade calculator's
  roster-spot credit. TE premium is applied on top as before;
- FantasyCalc's own values stay on each row (`fcValue`, `fcRedraftValue`)
  for the trade calculator's consensus. If `data/market-values.js` is
  missing, the app falls back to FantasyCalc's values throughout.

The player list and fallback values are **FantasyCalc's** trade values
(`https://api.fantasycalc.com/values/current?isDynasty=<true|false>&numQbs=<1|2>&numTeams=<8-14>&ppr=<0|0.5|1>`),
built from real trades on fantasy platforms. FantasyCalc sends an open CORS
header, so the page fetches them directly on load, the same way it fetches
Sleeper. Each settings combination's trimmed list (dynasty: about 400
players plus 24 generic rookie picks like "2027 1st (Early)"; redraft: about
200 players, no picks) is cached in `localStorage` for 2 hours, and an open page re-checks
when you return to the tab and every 30 minutes. Players are
keyed by their **Sleeper player_id**, which FantasyCalc includes, so nothing
is matched by name.

**League settings** sit at the top of Dynasty Values and the Trade
Calculator. They're shared between the tabs and remembered in the browser
(`DYNASTY_SETTINGS_KEY`):

| Setting | Options | How it's applied |
|---|---|---|
| Format | Dynasty · Redraft | FantasyCalc's `isDynasty`. Redraft has no picks |
| QB | 1QB · Superflex | `numQbs` |
| Teams | 8 · 10 · 12 · 14 · 16+ | `numTeams` (FantasyCalc stops at 14, so 16+ uses its 14-team values) and the trade calculator's roster-spot credit |
| Scoring | PPR · Half · Std | `ppr` |
| TE premium | None · +0.5 · +1.0 · +1.5 per catch | **An estimate**: FantasyCalc has no TE-premium values, so TE values are boosted by 10% / 20% / 30% for the top TE, scaling down to half that for fringe TEs (`TEP_BOOST`, `applyTePremium`) |

Loading a Sleeper league on the Trade Calculator sets all five from the
league (`settingsFromLeague`). Keeper leagues count as dynasty, and guillotine leagues as redraft. The 2027 Class
tab only uses the QB setting and always uses dynasty values.

The fetch-and-trim logic lives in `scripts/lib/fantasycalc.js`, loaded with
a plain `<script>` tag like `sleeper-scores.js`. `DYNASTY_VALUES` in
`index.html` is a **baked-in snapshot** of the 12-team PPR dynasty values in
both QB formats, shown until live data arrives and used if FantasyCalc can't
be reached (for other settings the page says the snapshot is only an
approximation). Each row is stored as
a compact array in `DYNASTY_FIELDS` order to keep the file small. To
refresh it, run `node scripts/refresh-dynasty.js` (`--dry-run` to
preview). A GitHub Action (`.github/workflows/refresh-dynasty.yml`) runs
it every Tuesday at 11:00 UTC and commits on change. It shares a
concurrency group with the scores Action so the two never push over each
other. Both scripts use `scripts/lib/bake.js` to rewrite their block of
`index.html`.

### Dynasty Values

Every player and pick, ranked by value for the selected league settings,
filterable by position (or Picks, in dynasty) and searchable by name or team. Each row shows position rank, age, value (with a
bar relative to #1) and the 30-day trend. It also shows the player's live Sleeper
injury designation, from the same cached `/players/nfl` map as the
Injuries tab. Two tags compare redraft value (this season
only) with dynasty value, for players worth at least 1,500:
**Win-now** when redraft value is 15%+ higher (older producers a contender
should buy), **Future** when it's under half and the player is 25 or younger
(young stashes, and anyone out for the season).

### Trade Calculator

Add players or picks to what each team gets. Each side shows its plain value,
any adjustments, and an adjusted total. Trades that aren't one-for-one are
adjusted the way the big calculators do it (`evaluateTrade`, constants in
`TRADE_FORMULA`):

- **Stud adjustment** (like KeepTradeCut and DynastyDaddy): each asset
  counts toward a "trade score" at 20% (filler) to 40% (the best player in
  the league) of its value. The share is higher the closer the asset is to
  the best asset in the trade and in the league. The side with the lower
  score is behind by the value of the one extra player it would need to catch
  up, found by bisection as KTC does.
- **Roster spot credit** (like FantasyCalc): the side getting fewer players
  can fill each open spot from waivers. So it's credited with the value of
  about the (teams × 25)th-best player, a slightly better one for each extra
  spot. That's where **league size** matters: in 8 teams the free agent is
  worth about 900, in 14 teams under 100. Bigger leagues credit less, so
  depth matters more.

The constants were tuned against reference trades. A 2-for-1 of equal value
favors the 1 side by about 15-20% in 12 teams, and four mid players don't
beat a star on volume. That lands between FantasyCalc (credit only) and KTC
(a much steeper stud premium). It's this app's own blend, not any one site's
exact formula. Within 5% (or 250) is "fair", and up to 15% "slightly
favors". **Raw values** turns both adjustments off. A collapsible "How this
is calculated" note on the page shows the current waiver-level player and
value. "To even it out" re-runs the whole formula for every candidate to find
the three closest.

The trade is stored in the URL hash (`#trade=<ids>|<ids>`), so a reload
keeps it and the link can be shared. A link with a trade in it opens
straight on this tab.

**League team values** (below the calculator): enter a Sleeper username
(then pick a league) or a league ID. Every team is ranked by the value of its
roster plus the rookie picks it owns, with a bar split by position, and
"starters": the best lineup it can field for the league's roster slots.
Sleeper only lists picks that have changed hands (`/traded_picks`), so each
team starts with its own picks for the next three drafts (rounds 1-4) and
trades are applied on top. Picks are valued as FantasyCalc's generic
mid-round pick for that year. Loading a league syncs the settings above to
it. Expand a team and use **+A / +B** to drop any player or pick into the
trade.

### My Leagues

**Week N matchup** (`useWeekMatchups`, `WeekMatchup`), on every league page
from the draft until the end of the season, above the standings. It shows the
league's current week (`settings.leg`) from the lineups the managers have set.
Your starters and your opponent's line up slot by slot. Bold points are
already scored. Italic points are Sleeper's projection in the league's own
scoring (`starterProjection`, also used by the standings sims). Each team
has a projected total and its win odds (`winOdds`): a normal model with
`STANDINGS_SPREAD` of each side's unplayed points as the spread. Below that,
"Around the league" lists every other matchup with its projected scores and
the favorite's odds. Team names open that team's roster. It re-checks with
the page's refresh tick, so live scores move.

The **Boardroom** (`MyLeagues`) has two kinds of page:

- **`#/leagues`** lists your leagues. Enter a Sleeper username (remembered in `ff-valuediff:sleeper-user`) to list
  every football league that user is in this season, each tagged with its format, size, QB format, scoring and TE
  premium. A league ID opens that league directly.
- **`#/leagues/<id>`** is one league's own page. It has a link back to all leagues, works with the browser's back
  button and bookmarks, and the browser tab shows the league's name. A loaded league is kept, so reopening it is
  instant.

A league page values the league with **its own settings**, not the shared ones above. It loads a separate FantasyCalc
value set through the same `useDynastyValues` cache. From top to bottom, the page has your team, trade targets,
position rooms and lineup, bench, power rankings and the settings table:

- **Values follow the league's own type** (no switch): dynasty and keeper leagues use dynasty values and show each
  team's lean (Contender / In the mix / Rebuilding); redraft and guillotine leagues (Sleeper type 3) use redraft
  values.
- **Your team** is the user's roster (any team can be picked). It shows ranks among the league for roster value
  (dynasty, including owned picks), lineup value and record/points. Dynasty adds a **This season** rank (the lineup's
  redraft values) and a lean (Contender / In the mix / Rebuilding, `teamLean`). The lean goes by the standings
  first: 60%+ projected playoff odds (`LEAN_CONTEND_ODDS`) makes a contender even with a bottom-half roster, and 20%
  or less (`LEAN_TANK_ODDS`) a seller even with a top-half roster. Without projections (season over, or they didn't
  load), after 3 games a winning record in a playoff spot or the bottom third of the standings does the same.
  Otherwise it's by thirds of the league on this season's lineup. The lean also steers the trade targets. Redraft
  shows bench depth instead. It also shows each position room's rank against the league
  average, the best lineup in the league's slots (`bestLineup`), and the bench.
- **Injuries count** (`sidelinedReason`, the same designations as the Injuries tab). Players out long-term (out for the
  season per `seasonOverIds`, or on Sleeper's IR, PUP or suspended list) are left out of the lineup behind the
  lineup-value and this-season ranks, power rankings and trade ideas (a target out long-term adds nothing to a lineup).
  The **Best lineup, week N** card (N is the league's current week) also leaves out players ruled Out (or NA) this
  week and anyone on a bye, and lists the **sidelined starters** with the reason. Doubtful and Questionable players
  still start.
- **Other teams open as dropdowns** in the power rankings (`RosterBreakdown`): click a team to see its QB, RB, WR
  and TE (best first) and, in dynasty, its picks, each with value, age and injury tag. Several can be open at once.
  Team names in the standings and trade ideas open (and scroll to) that team's dropdown. The panel up top is always
  your team; opened by league ID with no Sleeper user, a **Your team** menu picks which one that is.
- **Trade targets** (`suggestTrades`) suggest deals for whichever team is shown, grouped by position (QB, RB, WR, TE) with up to three per position, weakest room first. Each deal is a player on another
  team, alone or with a second player from that team, plus an offer from this roster that the Trade Desk's formula
  (`evaluateTrade`, same league size) calls fair or a slight overpay. Offers are the roster's 14 most valuable assets,
  one or two at a time; 2-for-2s are left to the Trade Desk. What counts as a better deal depends on the team:
  - In redraft, and for a dynasty team in the mix, it's the biggest gain in best-lineup value. The gain must be at
    least 250, or 10% of the target's value if that's more.
  - For a dynasty contender, it's the same, scored on this season's (redraft) values.
  - For a dynasty rebuilder, it's players who are cheap now but valuable later, paid for with veterans (26 and up).
    The deal must make the roster at least two years younger on average. Picks aren't suggested. Targets are:
    - young players, 24 and under
    - players 27 and under who are **out for the season but back next year**, bought while the price is down. An
      injured player counts as three extra years of age drop, since this season is all a rebuilder gives up. A player
      counts as out for the season if:
      - `INJURED_RESERVE` marks them `seasonEnding`, or
      - Sleeper has them on IR/PUP with an ACL or Achilles injury (`outForYearIds`).

      Low redraft value alone isn't used, because rookies on short IR stints have it too. These players are never
      suggested to other teams as lineup upgrades.

  **Deals are built around the other team.** Every offer has to fix something for them (`partnerHelps`). It can do
  that in three ways:
  - fill a position where they're in the league's bottom 40%; a rebuilding team gets only 40% credit for a veteran
    (27 and up)
  - bring a rebuilding team picks or players 24 and under
  - make a contending team's lineup better

  Each deal's base score is multiplied by fit factors (`FIT`), strongest first:
  1. how badly the other team needs what's offered (0.45× to 1.9×)
  2. whether the target comes from a room where they have plenty (1.35×) or are thin (0.7×)
  3. this team's own need at the target's position (0.8× to 1.3×)
  4. whether the two teams' windows complement each other: a contender trading with a rebuilder gets 1.35×, while two
     contenders or two rebuilders get 0.75×
  5. for a dynasty team in the mix, whether the target's age matches its core's value-weighted age (young under 25.5,
     veteran over 27.5)

  Each card explains the deal from the other team's side first. It names the hole the offer fills ("Chabuda is 10th
  of 10 at WR: Emeka Egbuka fills that"), the room they can spare the target from, and their window. It then gives
  this team's need and who moves to the bench.

  To keep the ideas varied, each position's deals come from different trade partners with different offers, no
  player is targeted twice, and no asset is offered in more than three deals overall. A position with nothing fair
  says so. **Open in Trade Desk** loads the trade with the league's settings.
- **Standings** (`ProjectedStandings`, above the power rankings) show this season's record, points for, points
  against and max points for, from Sleeper. **End of season** (the default) projects them through the regular season:
  - the remaining weeks are played on the league's real schedule (Sleeper's matchups), using Sleeper's weekly
    projections scored in the league's own scoring (each stat line × `scoring_settings`, so TE premium, IDP and K/DEF
    count);
  - each future week a team scores its best projected lineup in the league's slots (taxi squads left out), times how
    close to its best lineup it has started so far (PF ÷ max PF, kept between 75% and 100%). That best lineup is its
    projected max PF;
  - a week already under way uses the lineups actually set, with points already scored in place of projections;
  - players out for the season score nothing (`seasonOverIds`: season-ending entries in `INJURED_RESERVE`, plus
    Sleeper IR/PUP players with a torn ACL or Achilles). Sleeper's weekly projections sit out the four-game IR
    minimum, then bring every player back, season-ending or not;
  - 2,000 seasons are simulated (each team-week drawn around its projection, 18% as one standard deviation) for the
    average record, PF and PA, playoff odds and 1-seed odds. Median leagues get the extra game vs the median. Seeds
    go by wins, then points for. A dashed line marks the playoff cutoff.

  **Today** shows the current standings only. Projections are about 2 MB per week, fetched when a league page opens
  and kept for the visit. Hidden for guillotine leagues and before the draft.
- **Power rankings** rank every team by total value in dynasty, or by best lineup in redraft. Each team has a bar split
  by position.
- **Use in Trade Desk** copies the league's settings to the shared settings and opens the Trade Desk with that
  league's ID filled in.
- A **League settings** table, at the bottom, shows each setting, what the league uses and how it's applied:
  - format
  - teams (over 14 uses 14-team values)
  - QB (Superflex or 2QB both get Superflex values)
  - points per catch (nearest of PPR/half/std)
  - TE premium (the TEP estimate)
  - starting slots and roster size

  Settings FantasyCalc has no option for are listed but not modeled: 6-point passing TDs, and K/DEF/IDP slots.

### 2027 Class

A hand-curated list (`CLASS_2027` in `index.html`, like
`WAIVER_TARGETS`) of the top 2027 rookie prospects, with their 1QB and
Superflex rookie-draft ranks, school, size and a short note. It's sorted by
whichever format is selected. There's no live source for college
prospects, so ranks and notes are copied from published rankings, listed in
`CLASS_2027_SOURCES` and linked at the bottom of the tab. As of 2026-10-07
it holds 31 prospects from DraftSharks' Oct 1, 2026 1QB and Superflex
rankings and Yahoo's Sep 3, 2026 big board. Replace it wholesale as new
rankings come out.

The top of the tab is live: what each 2027 1st and 2nd (early/mid/late) is
worth right now, and the player with the closest value. Each prospect also
shows the pick his rank lines up with in a 12-team league (ranks 1-4 early
1st, 5-8 mid, 9-12 late, and so on) at its current value.

### Consensus across calculators

Under the trade verdict (which uses KTC, like the rest of the app), the
Trade Calculator re-runs the same trade with each calculator's values,
through this app's own formula: KeepTradeCut, FantasyCalc (live, in the
league's size and scoring), and in dynasty DynastyProcess and Dynasty
Superflex (redraft: KTC redraft and FantasyCalc only). The **consensus**
on top averages each calculator's signed margin (gap ÷ bigger side) and
reads it with the same fair / slight / favors thresholds
(`consensusVerdict`), with a count of how many calculators make the same
call and a note when KTC alone disagrees. None of these sites let a web page fetch
their values, so they come from
[Dynasty Daddy](https://dynasty-daddy.com), which collects them:
`dynasty-daddy.com/api/v1/player/all/today?market=<n>` (0 KeepTradeCut, 2
DynastyProcess, 3 Dynasty Superflex, 4 KeepTradeCut redraft), keyed by
Sleeper player_id. `scripts/refresh-market-values.js` writes them to
`data/market-values.js`, and the **Refresh market values** Action runs it
daily at 10:30 UTC. These are 12-team PPR values in 1QB and Superflex only,
with no league size, scoring or TE-premium options; FantasyCalc's generic
"2027 1st" picks use the mid pick.

## Basketball

Season-long (redraft) **points leagues** only. No dynasty, no category
leagues. Everything is live from Sleeper's public NBA API
(`scripts/lib/sleeper-nba.js`, loaded with a plain `<script>` tag as
`window.SleeperNBA`). The data loads the first time a basketball page
opens and is cached in `localStorage` (`ff-valuediff:nba-v1:*`):
- the NBA state (10 minutes)
- this season's totals (1 hour) and last season's (1 day)
- the trimmed player list with injuries (6 hours)
- each fantasy week (1 day, or 10 minutes for the current week)

**Snapshot.** If a request to Sleeper fails (Sleeper is down, no network,
or a double-clicked `file://` page), the pages fall back to
`data/nba-snapshot.js` and show a "saved snapshot" banner. The page loads
that file only on the first failure, so football visitors never download
it. It holds the NBA state, both seasons' totals, the player list and this
season's last 3 fantasy weeks. Every week would grow to ~4MB by April, and
older weeks still load live. To refresh it, run `node scripts/refresh-nba.js`
(`--dry-run` to preview). A GitHub Action
(`.github/workflows/refresh-nba.yml`) runs it daily at 11:00 UTC, after
the late West Coast games, and commits the file when the data changed. It
can be run by hand from the Actions tab too.

**Seasons.** Sleeper names a season by the year it starts ("2025" is
2025-26). Until the current season has games (2026-27 tips off Oct 20,
2026), every page shows last season and says so. It switches over on its
own once games are played.

**Scoring** (a setting on each page, remembered in
`ff-valuediff:nba-settings-v1`). Fantasy points are computed from the box
score, not taken from Sleeper's own number:

| Preset | Points |
|---|---|
| Standard (the NBA's official fantasy scoring, Yahoo's default) | PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO −1 |
| ESPN (ESPN's default points league) | PTS 1, 3PM 1, FGM 2, FGA −1, FTM 1, FTA −1, REB 1, AST 2, STL 4, BLK 4, TO −2 |

Presets live in `SCORING` in `sleeper-nba.js`. Sleeper's own NBA default
isn't documented anywhere I could find, so there's no Sleeper preset.

**Rooms:**
- **Scoreboard** (`NbaScoreboard`): one fantasy week (Monday to Sunday), with
  every player's points for each game, games played, points per game and
  the week total. The data comes from Sleeper's per-game feed
  (`/stats/nba/<season>/<week>`). A game counts only if the player logged
  minutes, because sat-out games come through with empty stats. The older
  `/v1/stats/nba/regular/<season>/<week>` feed only returns each player's
  last game of the week, so it isn't used. A finished season has 25 weeks.
  A new week opens Monday before its first game, so until then the page
  opens on last week. A **Top scorers** view (`NbaTopScorers`) ranks the
  season's top 50 by total fantasy points, sortable by FPG or real points
  per game (those two need the Big Board's minimum games). On phones the
  Pos, Games, GP and FPG columns fold into a line under each name, so the
  Total stays on screen.
- **Waiver Desk** (`NbaWaivers`): Sleeper's live trending adds and drops,
  with each player's points per game and his team's games left this fantasy
  week and next (`nbaTeamGames`, green at 4+). A **Heating up** list shows
  players whose last two fantasy weeks with games (2+ games, 20+ points per
  game) beat their games before that by the most. Early in the season, while
  a player has fewer than 3 earlier games, it compares against last season
  instead, so the two numbers are never the same games. The **Your league**
  bar works as on football.
- **Training Room** (`NbaInjuries`): everyone with a current Sleeper
  designation. The order is Out and IR, then suspended, doubtful,
  questionable, game-time decision (GTD) and day-to-day (DTD). You can
  filter to fantasy-relevant players (15+ points per game) or everyone.
- **Big Board** (`NbaRankings`): every player ranked by fantasy points per
  game, with games played, total and per-game PTS / REB / AST / STL / BLK /
  3PM / TO. A player needs 20 games for a finished season, or a third of the
  games played so far mid-season. During the season, **G left** and **Next**
  show the team's games still to play this fantasy week and next week,
  from Sleeper's schedule (`fetchSchedule`, cached 6 hours and saved in the
  snapshot).
- **Trade Desk** (`NbaTrade`): the football Trade Desk's formula
  (`evaluateTrade`, same stud adjustment and roster spot credit) with
  13-man rosters. Values are **projected rest-of-season fantasy points**
  (`nbaTradeRows`):
  - points per game × team games left × availability
  - points per game blends this season with last season's average, which
    counts as (15 − games played) games and fades out after 15 games
  - availability is games played ÷ team games, kept between 50% and 100%
  - rookies have no value until they've played

## Player profiles

Every player has a profile page, football at `#/player/<Sleeper id>` and
basketball at `#/nba/player/<Sleeper id>`. Nothing is written per player: the
page pulls that player's own feeds from Sleeper when it opens (CORS-open, kept
in memory for 10 minutes):

- `api.sleeper.com/stats/nfl/player/<id>?season=<year>&grouping=week` (and
  `grouping=season`, for this season's and last season's totals and position
  ranks), plus `api.sleeper.com/projections/nfl/player/<id>?...&grouping=week`
  for weekly projections.
- `api.sleeper.com/stats/nba/player/<id>?season=<year>&grouping=week`, every
  game of the season.

Football profiles also graph **dynasty value over time**, one line per site
(1M / 3M / 6M / All, hover for any day's values):

- FantasyCalc, live and daily since Jan 1, in your league size, scoring and
  QB format: `api.fantasycalc.com/trades/implied/<FantasyCalc id>?isDynasty=true&numQbs=..&numTeams=..&ppr=..`
  (CORS-open; the id is FantasyCalc's own, kept on each value row as `fcId`).
- KeepTradeCut, DynastyProcess and Dynasty Superflex, one point a week for
  up to a year, from `data/market-history.js`. The daily **Refresh market
  values** Action adds each day's values from Dynasty Daddy; it was started
  with `node scripts/refresh-market-values.js --backfill`, which pulls each
  player's last ~180 days from `dynasty-daddy.com/api/v1/player/<name_id>?isAllTime=false`
  (one request per player, so it's only for starting over). The file is
  loaded only when a profile opens.

The graph is always dynasty value (no redraft history is kept) without TE
premium.

Football profiles show bio and injury status, dynasty (or redraft) value,
rank, 30-day trend and Draft Board slot in your league settings, fantasy
points by week against Sleeper's projection in your scoring, a game log, the
next three games, last season and players of similar value. Basketball
profiles show trade value, FPG, availability, the last 20 games, the full game
log, season averages and similar players. Headshots come from
`sleepercdn.com`. There's no separate profiles tab: player names in every
tab link to their profile, and the profile's back link returns to the tab you
came from. Football tabs that use this app's short ids (Weekly Scores, Waiver
Wire, Injuries) are matched to Sleeper ids by name and position, the same way
the live scores are. Rookie picks and 2027 prospects have no profile.

## The shared player pool

The three season tabs read from one list, `samplePlayers` in `index.html` (the dynasty tabs use FantasyCalc's own player list instead):
id/name/team/position for the top 200 overall players, plus 8 IR players
added on 2026-09-28 (Conner, Benson, Njoku, Stowers, Tonges, Kirk, Pearsall,
Kalinic) so every Injured Reserve entry also appears in Weekly Scores. To
change what's shown, edit that array directly rather than anything in the
browser (every table in the app is read-only).

**Weekly Scores ranks everyone, not just that list.** Any QB/RB/WR/TE who
has scored fantasy points this season but isn't in `samplePlayers`
(waiver-wire breakouts, backup QBs who started, etc.) is added
automatically from Sleeper's stats, as `sl-<Sleeper id>` (`mergeExtras` in
`scripts/lib/sleeper-scores.js`; baked copy in `EXTRA_PLAYERS`). Players
who've only ever logged zeros (blockers, kneel-down QBs) are left out. These
added players never show OUT: they're blank in weeks they didn't play. As of
2026-10-05 that's 218 extra players. Each week's top 24 QBs/TEs and top 50
RBs/WRs match Sleeper's own numbers exactly.

Each entry also still carries an `adp` field left over from this app's
original ADP-comparison tool (see "History" below); nothing reads it
anymore; it's simply unused.

## History

The app also had a **Props** tab (sportsbook lines turned into implied
fantasy points, compared with Sleeper and ESPN projections, fed by
`scripts/refresh-props.js`). It was removed on 2026-09-28 along with its
script; both are in git history if it's ever wanted back.

### The original ADP Comparison tool

This app started as a pure ADP-comparison tool — a table and scatter chart
comparing each player's Average Draft Position across Yahoo, ESPN, Sleeper,
and FantasyPros' consensus, refreshed live from BeatADP via
`scripts/refresh-adp.js` (or the extension's background worker). That tool
has since been **removed** from `index.html` in favor of the three
results/target-driven tabs described above.

Its refresh script (`scripts/refresh-adp.js`, `scripts/lib/parse-beatadp.js`)
and the Chrome extension version of the tool (`extension/`) stayed behind,
unused, until they were deleted on 2026-10-22. All three are in git history
if ADP comparison is ever brought back.
