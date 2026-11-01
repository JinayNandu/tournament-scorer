# Tournament Scorebook — project context

Read this before changing anything. Everything here was either established
by testing or decided deliberately; none of it is a guess.

---

## What this is

A scoring app for tournaments of any shape. A personal side-project - not work, not a client's, and under
nobody's house style but its own.

Published as a Claude Artifact at
**https://claude.ai/artifact/EtW2LUfpNbUgLTaqCjNtxv** — republish to the
same path to update that URL. Source lives here so it stays editable and
could move to self-hosting later, as `railsathi` did.

The format it was built for, and the one that breaks every other app:
**12 teams × 11 players; each tie is 11 doubles matches** labelled `AA`,
`BB`, `CC`, `DD`, `C1D1`, `A1B1`…; single games to 21; group round-robin →
Super 6 in two groups → final.

---

## The words, which are load-bearing

**A MATCH is two teams playing each other. Inside it are GAMES (AA, BB,
C1D1). A game is played over one or more SETS.** The organiser chose
"match" for the team-vs-team level, so everything below it shifted down a
rung: what the code calls a `fixture` is a match, and a `rubber` is a game.
"Meeting" is gone from the interface; a few internal identifiers
(`setupMeeting`, `addToMeeting`, the `meeting: true` route param) still
carry the old name.

Knock-on effects, all deliberate:

- "Sets per game", not "sets per match".
- The point flags say GAME POINT for the point that ends the contest and
  SET POINT for one that ends a set — **except in tennis**, which keeps
  "game point / set point / match point" because that is what every tennis
  scorer reads, and the app's `Game` is a whole tennis match. `zone()`
  branches on the engine for exactly this.
- The Matches tab, "Add matches" and "Remove this match" all now mean the
  team-vs-team thing, which is what they always created.

## Hard rules — do not break these

**Every fixture is a tie holding 1..N rubbers.** Football and cricket are a
tie with exactly one. Nothing outside `engines.js` may branch on sport. The
moment standings or progression asks "is this cricket?", this app has
become five apps.

**Engines are pure folds.** `initialState / reduce / isComplete /
summarize`. `summarize` emits a common shape plus a free-form metrics bag;
everything downstream reads only that. Net run rate is a *comparator*
registered against the metrics bag, not a branch in the table code.

**Log rally winners, not points.** A `{side}` point log cannot express
side-out scoring, where winning a rally may hand over serve instead of
scoring. Logging who won each rally makes the score, the server number, the
side-out, the end change and the whole doubles serve rotation derivable by
the fold.

**The doubles rotation, since it is subtle.** Slot 0 of a side is the player
who began the game in the right-hand court (`startOrder` maps slots to
positions in the rubber's player list). Two rules fix everyone's position
forever after:

- A pair changes court only when they score **while serving** — that is what
  `swaps` counts. A side that wins the serve does not move.
- The serve is played from the right court on an even score.

Under **rally scoring** the server is therefore derived: it is whoever
stands in the court the score names. Under **side-out** it cannot be, because
the second server is the partner, who is in the *other* court — so
`servingSlot` is carried in state there. Do not try to unify these; the
attempt is what made this wrong the first time. The receiver is always the
opponent in the same-handed court, because the serve is diagonal.

**Deuce and the golden point, not "must win by".** Asking a setup screen for
a win-by number is the wrong question: everyone plays two clear, and what
actually varies is whether a golden point gets called on the day. So
`winBy` defaults to 2 and is not asked for; the scoreboard offers a
**golden point** when the game is at deuce, and the next point then ends it
whatever the gap.

It is offered at deuce only — level, and at or past `target - 1` — because
that is the only score where it changes anything: from one point ahead,
winning the next already gives you two clear. Under side-out it fires only
on an actual point, since winning a rally off serve scores nothing. It is
an ordinary event, so undoing the deciding rally leaves it armed and
undoing the call itself takes it back off.

**Undo appends, it never pops.** An undo is an event naming the event it
cancels. Popping an array loses writes when two phones score one match and
destroys the record of what was corrected. Undoing an undo is redo.

**EVERYTHING THE SHARED STORE HANDS BACK IS FROZEN.** The db gives the same
object to every subscriber and will not let it be written to; assigning to
one throws, the snapshot callback dies with it, and whatever that callback
was going to set is never set. `migrate` editing the tournament doc in
place meant the list never arrived and the published app sat on
**"Loading..." for good** - for everyone with existing data, from the
moment SCHEMA_VERSION went to 2. Clone before changing anything that came
out of the store (`JSON.parse(JSON.stringify(doc))`), write the change to
the store, and let the next snapshot bring it back. `healStatuses` does
exactly that.

**Local mode does NOT freeze**, and resolves writes instantly. So this
whole class of bug is invisible on `dev.html` and in the self test.
`tools/shared-mode.js` closes the gap: it is loaded by `dev.html` only
(never published) and makes the local store behave like the shared one -
every snapshot deep-frozen, every write on a timer, so anything that
writes to a snapshot or assumes a write has already landed falls over
locally. `__shared.latency = 500` for bad-wifi pacing, `__shared.off()` to
drop back. Drive the app through it after any change that touches stored
data.

**A summary is a cache, never a source.** Always re-fold from the event log
and rewrite; never increment. A cache can fall behind its log — a write that
never landed, or an engine fix that changes what the same events add up to —
and nothing else can notice, because the table reads fixtures and never
loads a rubber. So `healSummary` re-folds whenever a rubber IS loaded and
rewrites if the stored answer disagrees.

**Work the fixture's status out BEFORE the write, not in its callback.**
`leave()` flushes and then navigates, so by the time a rubber write resolves
`S.fid` is already null. Reading it there returned "no such fixture", the
score was saved and the status silently was not: every played meeting stayed
`scheduled`, so `countsForStandings` rejected it, the table showed nothing
after a full day's play and no later stage could resolve. Anything derived
from screen state belongs on the synchronous side of a promise.
`healStatuses` in `app.js` repairs tournaments already broken this way.

**The last game lives in two places at once.** When a match ends the game is
pushed into `games` AND left in `s.home`/`s.away`, so the board can keep
showing it. `recount` therefore adds the live score only when the match is
NOT complete — adding both put every point of a hand-corrected match into
the table twice, turning 21-10 into 19-42. A game also carries `by` (who won
it), because a golden point is not derivable from 21-20, and a correction
that un-finishes a game pops it back onto court.

**The unit is not always the point.** In a one-set tournament winning takes
the only set, so `unitsDiff` and `unitsFor` are the win count written again
and the default tiebreaks could separate nothing: three teams fifteen points
apart were declared level on everything. `pointDiff` and `pointsFor` are in
`DEFAULT_TIEBREAKS` for that reason; where the unit IS the point — football
goals, cricket runs — they repeat the earlier criteria and change nothing.
For the same reason the table's F/A column, the meeting rows and the bracket
cells show POINTS when every meeting is a single one-set match, and units
otherwise.

**Sort the fixtures on arrival.** The store returns rows in whatever order it
holds them, which listed the semi-finals SF2 before SF1 and let the
round-robin list reshuffle between renders. `byFixture` in `app.js` orders
them by round, then `order`, then label as text, then id.

**Carry-over is a counting set, not a number.** A Super 6 stage's table is
computed over a *fixture set* that includes the group matches between teams
that both qualified. Because those matches are really in the set,
head-to-head, difference and NRR come out right with no special case, and a
group correction propagates on its own. Copying carried points into a field
would make head-to-head silently wrong.

**Progression pulls, never pushes.** Fixture sides are `EntrantRef`s
pointing backwards. Nothing writes forward when a match ends, so a phone
finishing a semi-final never cascades writes and a bracket cannot be left
half-applied.

**A draw must never come out empty.** `clampGroups` in `schedule.js` is the
guard, and it is there rather than in a screen so it stays tested: never
more groups than there are pairs of teams. The original bug was a preset
setting two groups before any teams existed; with two teams entered the
dropdown offered only "one league" but the stored value stayed 2, so each
group got one team and the draw silently produced nothing. Clamp stored
values when the thing they depend on changes — a `<select>` showing the
right option does not mean the state behind it is right.

**An entry in the match template keeps its id for life.** A game on a
court finds its own points target by pointing back at the template entry
it came from (`rubber.templateRubberId`), and `resolveScoring` reads
`scoringOverride` off that entry. `applyTemplate` used to mint fresh ids
on every save, which cut every one of those threads at once - so "this
game is played to 15", set on a game that already existed, never reached
the board and said nothing. Reuse the id at that position; `templateRubber`
also falls back to matching on the label, for templates saved before this.

**A scoring override REPLACES, it does not merge.** `resolveScoring` walks
game to template entry to stage to tournament and takes the first one it
finds WHOLE. Anything writing one carries the entire config
(`U.scoringOverrideFor` does), or win-by-two and the cap quietly revert to
their defaults alongside the points.

**A sheet repaints itself.** `render()` deliberately leaves the overlay
alone, so a snapshot arriving mid-edit cannot close a sheet under
someone's hands. The cost is that anything chosen INSIDE a sheet has to
re-mount its own host - and until `recordingLevel` did, tapping Pro saved
Pro, toasted Pro, and left Advance looking selected. The setting worked;
the screen said it had not, which is the same thing to whoever is holding
the phone.

**A match's line-up is an override, never the squad.** "Jinay was D1, but
today he is not playing" changes ONE match. `fixture.lineup` holds only
what differs from the squad's own category assignment - `SCH.lineupOf`
merges the two, and a slot the override *mentions* wins even when it names
nobody, which is how a dropped player stays dropped. Three things follow,
and all three were got wrong on the first attempt:

- Only real differences are stored. A category left alone keeps following
  the squad, so fixing the squad later still reaches every match.
- A new name typed at a match takes the category only when it is going
  spare (`findOrAddPlayer`). Handing it over while somebody holds it would
  re-point every other match that squad plays.
- The sweep that re-fills the games skips any that already has a score.
  Correcting one of those is a deliberate act on its own scoreboard.

**Never resolve an ambiguous rank
, and never randomise at render time.** If
the tiebreakers leave teams level across a qualification line, resolution
returns `pending` and the organiser stores an order. Two phones must never
show different tables.

**Never re-point a fixture that has already been scored.** A late upstream
correction is reported as a conflict for a human; the teams that actually
played stay. This hangs on `fixture.resolved`, written by `playedSides` the
first time a meeting is scored and never updated after - the whole point is
that it does not follow later resolutions. For a long time nothing wrote
it, so the guard in `progression.js` was dead code and the rule was not
enforced at all. The case that exposed it: adding one more group match
un-finishes the group, so "winner of Group A" stops resolving, and
semi-finals already played went back to reading a placeholder while keeping
their scores. A ref that no longer resolves is NOT a conflict - only a ref
that now names somebody else is.

---

## Setting one up is a walk, not a hunt

`ui-setup.js` is five steps: how many teams and players, the categories
(optional, and the step disappears when it is off), the teams and their
squads, the groups, then the format and the games. Nothing is written to
the store until the last step, so backing out costs nothing, and every one
of them is editable afterwards through the screens that already existed.
This replaced a one-screen create that asked for a name and left the rest
to be hunted down: teams here, categories buried in settings, groups in one
sheet, the game list in another. Everything was reachable and nothing was
obvious.

Three things the steps enforce, because they are the ones that go wrong:

- **No two players share a category.** C and C is not a thing; C1 and C2
  is. Next waits for it.
- **A group split stays the shape it was chosen as.** Move a team out of a
  group of four and Next waits until every group is back to the size asked
  for, naming the ones that are wrong. Custom sizes (4, 4 and 6 out of
  fourteen) are a split of their own, since no even deal makes them.
- **"Everyone plays four of the other five" is the first k rounds of the
  circle method**, not a random draw: the method already gives each team
  one match per round, so truncating is balanced by construction and
  nobody plays twice while someone else sits out.

**How much to record is NOT asked here.** Base, Advance and Pro are a
scoring decision, so the question lives on the scoreboard, under Fix.
Asking it during setup got an answer from somebody who had not yet thought
about it.

## This is for LOCAL tournaments — nothing is REQUIRED up front

An earlier wizard demanded grades, squads, a match template and a group
structure before anyone could score, and it was torn out for it. The one
in `ui-setup.js` today is not that: it **offers** the structure and
defaults every answer, so a name and four taps of Next produce four teams,
one group and one game — the old blank start, reached by walking rather
than hunting. Read the two sections together and the rule is unchanged:

**A name is the only required field, anywhere.** Teams default to "Team A"
and need only a name. Players, colours, badges, categories, several games
in a match and groups are each optional and each addable at any point,
including mid-match. Local tournaments are improvised — teams turn up,
someone decides who plays who, and names get written down as a game
starts — and nothing may stand between that and a score.

The one place the wizard DOES insist is where a half-finished answer would
be wrong rather than merely empty: two players sharing a category, or a
group split that no longer matches the shape it was chosen as. Both are
contradictions, not blanks.

- `ui-teams.js` owns teams. `ui-matches.js` owns building fixtures — one at
  a time (`oneMatch`) or the whole draw (`everyone`).
- `ensureLeague` keeps a default single-group stage holding every team in
  step, so the table works with nobody configuring a stage.
- `fixture.matchCount` is the meeting's own number of matches, overriding
  the tournament default — matches can be added to or removed from one
  meeting without disturbing the rest. `tieResult` reads it.
- `config.useGrades` is off by default. Grades (A1, B2) exist for the
  11-matches-a-tie format and are invisible otherwise.

**And the game list is made FROM the categories.** `M.categoryGames`
turns A1..F1 into the three sets anyone actually wants - each pair
together (AA, BB), the pairs split across (A1B1, A2B2, C1D1) and
everyone in singles - and `U.categoryBuilder` offers them in both game
list editors. Build it ONCE outside paint(): the editors re-render on
every change, and a rebuilt builder forgets which sets are already
picked, so choosing a second one replaced the first.

**The categories are set ONCE for the tournament, not per player.**
`TS.settings.categories` asks how many players a team has and whether
they are named in pairs (A1, A2, B1…) or one each (A, B, C…), and
writes `config.grades`. Every team sheet is then a row per category
waiting for a name, and a pasted list of plain names drops into the
empty ones in order. Asking for "A1 Jinay" on each of 132 lines was
the wrong way round: the structure is identical for all twelve teams,
so it belongs to the tournament and only the names belong to the team.

**Grades are called CATEGORIES in the interface** (A1, A2, B1…), and the
switch for them lives on the team sheet beside the players as well as in
Settings. Buried under Settings alone it was never found, so every squad
anyone entered went unused and games named AA or C1D1 picked nobody. The
team sheet reads `t.config.useGrades` off the clone it is editing, not the
live tournament, so the boxes appear the moment the switch is flicked.
`fillFromCategories` backfills games that were created before the switch
was on — only games with NOBODY in them, so a hand-picked line-up is never
overwritten.

**A label only means something against a grade list.** `config.grades` is
created empty and no screen ever fills it, so `parseRubberLabel(label, [])`
returned null for everything and the auto-fill the graded format exists for
had never once run: AA, BB, C1D1 were decorative text. `M.gradesOf` falls
back to `DEFAULT_GRADES` (A1..F1), `M.slotsForLabel` is the only way a
screen should read a label, and `M.reparseTemplate` re-reads the whole match
list when grades are switched on — a list set up before the switch would
otherwise keep the slots it was parsed with, which is to say none.

**Nothing may re-render the sheet on blur.** A field that commits
`onchange` re-renders, which destroys the button the thumb is already
pressing, and the tap is then delivered to nothing. It cost the Save button
on the team sheet and a whole match list in the meeting editor. Commit on
Enter and on an explicit button, and have Save pick up whatever is still
sitting in the box.

**One box takes one or many.** Teams paste in as a list; so do players,
because typing eleven names into eleven fields twelve times over is where a
132-player tournament dies. The player box reads "A1 Ravi", "Ravi A1" or
just "Ravi", and a leading token only counts as a grade if it really is one.

**Create matches only when the store has answered.** `S.rubbersLoaded`
guards `TS.matches.ensure`. Without it, an empty-but-unloaded rubber list
read as "none yet" and a tie ended up with four copies of every match.

## Detail capture must never slow the scoring down

`config.detail` is `none` (Base), `shots` (Advance) or `players` (Pro).
Above Base, the board asks how each point ended.

**The point is recorded the instant the side is tapped; the reason is a
separate `detail` event annotating that rally by id.** Engines ignore
`detail` entirely, so capture cannot change a result, skipping costs
nothing, and the next point can be scored straight over the prompt. A skip
is still written — with `how: null` — so it stops being asked about, and
`detailsOf` drops those. `lastUndoableId` skips `detail` too: Undo is for
taking the point back, and undoing only its note would look like nothing
happened.

**A winner belongs to the side that won the point; an error to the side
that gave it away.** That asymmetry is the whole reason `kind` is stored
rather than inferred.

The Analysis tab loads every rubber ONCE, on demand, and caches it — the
detail lives in rubber documents, which nothing else loads in bulk.

## Swapping sides is a VIEW, never the data

Players change ends mid-game and the scorer turns round with them, so the
board can flip. `setFlipped` only reorders the two zones; each still scores
its own team. It is kept in **localStorage, per match** rather than in the
shared document, because two scorers standing at opposite ends of one court
want opposite views of the same match.

Everything on the board is correctable without undoing back to it: the Fix
sheet has plus/minus steppers per side per set (Undo only ever reaches the
*last* point, which is not always the wrong one), a one-tap route to the
serve rotation, the side swap, and the lineup.

## Do not gate the scoreboard

Twice now a well-meaning setup step has read as a bug. A full-screen "who
serves first?" on every match looked identical each time, so the app
appeared stuck on the same match. The rule that came out of it: **the board
opens and is scoreable immediately.** Anything the app wants to know is
dismissible, never a step in the way.

`serveSetup` does open by itself again now (`maybeAskServe`, once per
game), and that is NOT a reversal. What was wrong before was the *gate*:
the board renders first and stays live behind the sheet, closing it
leaves the banner and its default, and the first point can be scored
without ever answering. The reason it asks at all is that in doubles a
guess at the server is wrong about half the time, and a wrong guess has
to be noticed before it can be undone. If this ever becomes a
full-screen step again, it is wrong.

Related: names are typed **at the match**, not only in setup, because that
is usually when they are known. `lineupSheet` takes free text and adds
anyone new to that team's squad, matching on name *within the team only* —
two teams may each have a Dev and they are different people.

Serve tracking is optional (`scoring.trackServe`, default on, per
tournament or overridden per match). When off, every trace of it goes: no
chips, no court, no serving highlight — just names.

## Phone rules — this is a phone app

It is used standing next to a court, one-handed. Things that are easy to
undo by accident:

- **Never let a field be under 16px.** iOS Safari zooms the page the moment
  a smaller input is focused, and the layout never recovers.
- **`touch-action: manipulation` on anything tappable.** Scoring is dozens
  of fast taps in one spot, which the browser otherwise reads as
  double-tap-to-zoom. `user-select: none` on the board for the same reason.
- **The browser's tap highlight is off**, so `:active` states are the only
  confirmation a thumb gets. Keep them obvious, and never change a box
  dimension in `:active` — it shifts the layout under the finger. The board
  also buzzes (`navigator.vibrate`, ignored on iOS).
- **Landscape is short, not narrow.** Size the score off `vh` there, or it
  pushes the serve line off the bottom. Portrait stacks the two sides so
  each tap target is half the screen.
- **Nothing tappable under ~40px tall** at phone width, `.btn-sm` included.
- **`dvh` for sheet heights**, so the phone's own toolbars do not clip them;
  `overscroll-behavior: contain` so pull-to-refresh cannot fire mid-game.
- **Every board control lives in one cluster at the bottom, centred.**
  They used to sit one in each corner — Done top-left, swap and serve and
  lock top-right, undo bottom-left, fix bottom-right — which meant hunting
  for them one at a time, and the swap was a bare "⇄" that told nobody
  what it did. They carry words now, not glyphs, and the top bar holds
  nothing but the title. The banner clears the cluster by measuring it
  (`--foot`, set after each render) because the buttons wrap to a second
  row on a narrow phone.
- **Every screen has the same way out, in the same place.** `topbar` takes
  a fourth argument, `{label, onclick}`, drawn as "‹ Label" to the LEFT of
  the title; actions stay on the right. The hub had no way back to the
  tournament list at all — you had to know it was under More. The label
  names the destination ("‹ Matches", "‹ Tournaments") rather than saying
  "Back". The scoreboard is the exception: its way out is **Done**, in the
  bottom cluster with the other controls, because putting a second exit in
  a corner is the thing that cluster exists to undo.
- **The board banner must never wrap.**

 It floats over the lower half, so
  every line it grows by is score the scorer cannot see. It is absolutely
  positioned, which means shrink-to-fit: with `min-width: 0` on the text
  column it sized itself to the buttons and broke "Deuce, 20-20" into one
  word per line. At phone width it is given a definite `width` instead, the
  buttons are `flex: 0 0 auto; white-space: nowrap`, the heading is one
  nowrap line that ellipsises, and `.bb-sub` is hidden — the heading and
  the buttons already say it, and the bottom row repeats the score.
- **A sheet closes on a backdrop tap only if the press STARTED there.**
  Dragging across a field to select its text and lifting a few pixels
  outside fires a click whose target is the backdrop, and the sheet threw
  the whole edit away mid-type. `U.sheet` tracks `pointerdown` /
  `mousedown` / `touchstart` on the backdrop and ignores any click that
  began elsewhere. This bit every sheet in the app, not one screen.
- **Assume the lease is winnable until told otherwise.** A hall wifi round
  trip is seconds, and a scoreboard that swallows the first taps is worse
  than the rare double-scored rally.

## Storage — and why it is shaped this way

```
tournaments/{tid}                    meta, config, stages, entrants[], players[]
tournaments/{tid}/fixtures/{fid}     sides, lineup, rubberSummary map, status
tournaments/{tid}/rubbers/{rid}      slots, court, lock, events[], summary
```

Three constraints from the `db` capability drove this:

1. **25,000 documents per artifact, and the contract says outright not to
   map a growing stream to one document per item.** So events live in an
   array *inside* the rubber document. A 21-point game is ~45 tiny events;
   the 256 KiB document limit is nowhere near.
2. **Entrants and players are in the tournament document** because 132
   player documents would be 132 sequential writes at setup for no benefit.
   They are written once by the organiser.
3. **Fixtures and rubbers are separate documents** because scorers write
   them, from different phones, at the same time. Eleven scorers writing
   eleven keys of one fixture's `rubberSummary` is safe: nested objects
   merge recursively, so disjoint keys do not clobber each other.

**Rubbers are created lazily**, when a tie is first opened — 30 ties × 11
would be 330 documents written up front for matches that may never happen.

**Two scorers on one rubber** is handled by `acquire()`, the store's own
cooperative lease. It is not a security boundary; the second phone gets a
read-only view and an explicit "Take over". The zones are `disabled` while
another phone holds it, and a disabled button cannot fire the toast that
would explain itself — so `readOnlyBanner` says it on the board, with the
way out beside it. The lease is a no-op outside cloud mode, so this path
can only be exercised by stubbing `TS.store.acquire`.

**Writes to different documents run four at a time** (`runLimited`). Firing
60 at once trips the per-viewer call rate.

**`db` is null for signed-out viewers**, so everything mirrors to
localStorage and the app works fully offline for a lone scorer. A failed
cloud write is stashed and flushed on the next success or on tab focus.

---

## Where things live

```
index.html        the shell, the design tokens and ALL the CSS
js/model.js       shapes, status lifecycle, Ref, categories, migrations
js/engines.js     rally · tally · manual          the only sport-aware code
js/engine-*.js    cricket · tennis
js/standings.js   MatchResult, counting sets, comparators, tiebreakers
js/progression.js resolveRef, topological resolve, conflicts
js/schedule.js    circle method, part round robins, brackets, group splits
js/store.js       adapter, db + localStorage, onSnapshot shim
js/analysis.js    Base/Advance/Pro levels, shot lists, aggregation
js/app.js         router, state, topbar, heals
js/ui-common.js   el, sheets, fields, toasts, the category game builder
js/ui-setup.js    the five-step walk that starts a tournament
js/ui-teams.js    teams and squads          js/ui-matches.js  matches and games
js/ui-stages.js   later rounds, brackets    js/ui-views.js    home, hub, table
js/ui-score.js    every scoreboard          js/ui-settings.js change it after
js/ui-extras.js   leaderboard, feed, big screen, backup
js/ui-analysis.js the Analysis tab
js/selftest.js    157 assertions over the pure modules
tools/            serve.pl wrapper, shared-mode.js, the dev.html head/foot
```

## Verifying changes

There is **no Node, no npm, and Python is blocked by group policy** on this
machine. That is why `js/selftest.js` exists and why the app has a
`#selftest` view.

Two ways to run it:

```bash
cd <this folder>
cscript //E:JScript //Nologo "<scratchpad>\runtests.js" .
```

Windows Script Host is an ES3 engine, so the runner shims the ES5 library
methods and rewrites `.catch` / `.delete` (reserved words after a dot in
ES3) before parsing. It loads only the DOM-free modules. **170 tests,
all green** as of the last change - bar three that assert frozen
documents, which JScript cannot express and which pass in the browser.

Or open the published artifact at `#selftest`.

**The screens can be run for real, locally.** Git ships a Perl, and that is
enough for a static server:

```bash
cat tools/head.html index.html tools/foot.html > dev.html
```

`tools/serve.pl` serves this folder (core Perl only, no CPAN):

```bash
perl tools/serve.pl 8120
```

`tools/head.html` and `tools/foot.html` reproduce the wrapper the Artifact
runtime puts around the page, so `dev.html` is what the published artifact
actually serves. The `scorer-dev` entry in `../.claude/launch.json` serves
this folder on port 8120; open `/dev.html` and drive it with the browser
tools. `claude.use()` resolves null there, which is the signed-out path, so
the localStorage mirror is what gets exercised — the db path still needs the
published page.

Regenerate `dev.html` after editing `index.html`; it is a build output and
is never published.

Keep the code ES5 — no arrow functions, no `let`/`const`, no template
literals — so the JScript runner keeps working.

---

## State of play

**Done:** the model; all five engines (`rally`, `tally`, `manual`,
`cricket` ball-by-ball, `tennis`); round-robin and knockout draws;
rubber-to-court conflict colouring; standings with the full tiebreaker
chain and NRR; progression; storage with an offline mirror; the setup
wizard (five steps: numbers, categories, teams, groups, format);
score mode for every engine; the tie sheet; per-match line-ups;
a points target per game;
group tables; the stage builder (Super N with four carry-over rules, and
seeded knockouts with byes); the bracket view; table locking with a
divergence warning; the player leaderboard; the result feed; big-screen
mode; and JSON export, import and compaction.

`ui-settings.js` makes it all changeable afterwards: scoring, table points,
courts, the match list (with a Suggest that fits the squads), teams and
players, and redoing the draw. A single match can also be given its own
target from the scoring screen, stored as `rubber.scoringOverride`.

**170 tests green**, thirteen of them on the serve rotation alone.

**Not built yet / known rough edges:**
- Only the screens that have been walked through in the local browser are
  known to work; there is no automated coverage of the DOM layer.
- Cricket's batting and bowling figures are recorded but there is no
  scorecard screen; the numbers are in the rubber document.
- A knockout stage draws its entrants from the *previous* stage only. To
  seed a final from something else, edit `entrantRefs` by hand.
- Dead rubbers must be marked by hand ("Fix" then "Mark as not played").
  `clinchEnds` exists in the tie template but nothing acts on it yet.
- Who plays a match is set on the match page ("Who is playing"): one row
  per category when the games name them, otherwise one block per game.
  A single game can still be changed on its own scoreboard ("Fix" then
  "Change who is playing"), which sets that game and nothing else.
