# Tournament Scorebook

A scoring app for tournaments of any shape, built to be used one-handed
while standing next to a court.

**Live: https://jinaynandu.github.io/tournament-scorer/**

It was written for the format that breaks every other app: twelve teams of
eleven players, where each *match* between two teams is eleven doubles
*games* — `AA`, `BB`, `C1D1`, `A1B1` — played to 21, run as a group
round-robin into a Super 6 and a final. Football and cricket are the same
model with one game in the match, so they come along for free.

Also here: round-robin and knockout draws, group tables with the full
tiebreaker chain and net run rate, a player leaderboard, ball-by-ball
cricket, tennis, big-screen mode, and JSON export and import.

## Running it

There is no build step and nothing to install — it is HTML, CSS and
twenty-one plain scripts. Open `docs/index.html`, or serve the folder:

    perl tools/serve.pl 8120

`index.html` in the root is a body fragment, because the Artifact runtime
that also serves this app wraps it in a document skeleton. `tools/mkpages.pl`
reproduces that wrapper to build `docs/`, which is what GitHub Pages serves.

    perl tools/mkpages.pl

## Tests

`js/selftest.js` holds 181 assertions over the pure modules — the serve
rotation, the tiebreakers, net run rate, carry-over counting sets,
progression. Open the app and tap **Self test**, or visit `#selftest`.

## Scoring from several phones at once

Out of the box, scores are saved in the browser, on the device that
recorded them: a tournament scored on one phone stays on that phone, and
anyone else opening the link starts an empty one of their own. For a
single scorer that is the whole story, and **More > Backup** moves a
tournament between devices.

Eleven courts scoring into one table needs somewhere shared to put it.
Fill in `js/firebase-config.js` with a Firebase project of your own and
that is what happens - every phone on the link reads and writes the same
tournament, live, with no sign-in. The file itself has the four steps,
and `tools/firestore.rules` is the matching rules file. Read that one
before publishing a link: it leaves the tournaments open to anybody
holding it, which is a deliberate trade and is argued in the file.

`js/store.js` picks whichever backend answers first - Firestore, then
the Artifact `db` when published there, then the device - and the rest of
the app cannot tell which it got.
