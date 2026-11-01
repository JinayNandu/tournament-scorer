/* Tournament Scorer - what happened, not just who won
 *
 * Three levels of detail, set per tournament:
 *   none    just the score (the default, and the fastest to keep)
 *   shots   how each point ended - a smash, a drop, hit out
 *   players the same, plus who hit it
 *
 * A detail is an annotation on a rally event, never part of the score. The
 * engines ignore `detail` events entirely, so capturing them cannot change
 * a result and skipping them costs nothing.
 *
 * Pure: no DOM, no storage. Everything here is callable from selftest.js.
 */
(function (TS) {
  'use strict';

  var LEVELS = [
    { id: 'none', label: 'Base',
      hint: 'Just the score. Fastest to keep, nothing to tap but the point.' },
    { id: 'shots', label: 'Advance',
      hint: 'After each point, one tap for how it ended — a smash, a drop, hit out.' },
    { id: 'players', label: 'Pro',
      hint: 'The same, plus who played the shot. Two taps a point, and a full picture afterwards.' }
  ];

  /* A winner is credited to the side that WON the point; an error is
   * charged to the side that lost it. Keep each list short enough to tap
   * without reading. */
  var SHOTS = {
    badminton: [
      { id: 'smash',  label: 'Smash',   kind: 'winner' },
      { id: 'drop',   label: 'Drop',    kind: 'winner' },
      { id: 'clear',  label: 'Clear',   kind: 'winner' },
      { id: 'net',    label: 'Net shot', kind: 'winner' },
      { id: 'out',    label: 'Hit out',  kind: 'error' },
      { id: 'netted', label: 'Into net', kind: 'error' },
      { id: 'fault',  label: 'Serve fault', kind: 'error' }
    ],
    pickleball: [
      { id: 'smash',  label: 'Put away', kind: 'winner' },
      { id: 'dink',   label: 'Dink',     kind: 'winner' },
      { id: 'drive',  label: 'Drive',    kind: 'winner' },
      { id: 'third',  label: 'Third drop', kind: 'winner' },
      { id: 'out',    label: 'Hit out',  kind: 'error' },
      { id: 'netted', label: 'Into net', kind: 'error' },
      { id: 'fault',  label: 'Serve fault', kind: 'error' }
    ],
    rally: [
      { id: 'winner', label: 'Winner',   kind: 'winner' },
      { id: 'smash',  label: 'Smash',    kind: 'winner' },
      { id: 'placement', label: 'Placement', kind: 'winner' },
      { id: 'out',    label: 'Hit out',  kind: 'error' },
      { id: 'netted', label: 'Into net', kind: 'error' },
      { id: 'fault',  label: 'Serve fault', kind: 'error' }
    ],
    tennis: [
      { id: 'winner', label: 'Winner',   kind: 'winner' },
      { id: 'ace',    label: 'Ace',      kind: 'winner' },
      { id: 'volley', label: 'Volley',   kind: 'winner' },
      { id: 'out',    label: 'Hit out',  kind: 'error' },
      { id: 'netted', label: 'Into net', kind: 'error' },
      { id: 'double', label: 'Double fault', kind: 'error' }
    ],
    tally: [
      { id: 'open',    label: 'Open play', kind: 'winner' },
      { id: 'setpiece', label: 'Set piece', kind: 'winner' },
      { id: 'penalty', label: 'Penalty',  kind: 'winner' },
      { id: 'own',     label: 'Own goal', kind: 'error' }
    ]
  };

  function levelOf(tournament) {
    return (tournament && tournament.config && tournament.config.detail) || 'none';
  }

  function shotsFor(tournament) {
    if (!tournament) return SHOTS.rally;
    return SHOTS[tournament.sport] ||
           SHOTS[(tournament.config || {}).engine] ||
           SHOTS.rally;
  }

  function shotById(tournament, id) {
    var list = shotsFor(tournament);
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return null;
  }

  /* ------------------------------------------------- reading the log -- */

  /* The rally that still has nothing said about it: the most recent one
   * with no detail attached. Null when there is nothing to annotate. */
  function pendingRally(events) {
    var live = TS.engines.liveEvents(events);
    var noted = {};
    live.forEach(function (e) {
      if (e.type === 'detail' && e.payload && e.payload.ref) noted[e.payload.ref] = true;
    });
    for (var i = live.length - 1; i >= 0; i--) {
      if (live[i].type !== 'rally') continue;
      return noted[live[i].id] ? null : live[i];
    }
    return null;
  }

  /* Every annotated point in one match, flattened for counting. */
  function detailsOf(events) {
    var live = TS.engines.liveEvents(events);
    var rallies = {};
    live.forEach(function (e) { if (e.type === 'rally') rallies[e.id] = e; });
    var out = [];
    live.forEach(function (e) {
      if (e.type !== 'detail' || !e.payload) return;
      // A skipped point is recorded so it stops being asked about, but it
      // says nothing and must not be counted.
      if (!e.payload.how) return;
      var r = rallies[e.payload.ref];
      if (!r) return;
      out.push({
        wonBy: r.payload.side,                 // side that took the point
        how: e.payload.how,
        kind: e.payload.kind || 'winner',
        by: e.payload.by || null,              // the player, in Pro
        at: e.at
      });
    });
    return out;
  }

  /* ---------------------------------------------------- aggregating --- */

  function blankTally() {
    return { points: 0, winners: 0, errors: 0, shots: {} };
  }

  function addTo(t, how, kind) {
    t.points += 1;
    if (kind === 'error') t.errors += 1; else t.winners += 1;
    t.shots[how] = (t.shots[how] || 0) + 1;
  }

  /* Rolls a set of matches into per-side and per-player tallies.
   *
   *   `matches` is [{ events, homeEntrantId, awayEntrantId,
   *                   homePlayers, awayPlayers }]
   *
   * A winner belongs to the side that won the point; an error belongs to
   * the side that lost it, which is the side being counted against. */
  function aggregate(matches) {
    var byEntrant = {}, byPlayer = {}, overall = blankTally();

    (matches || []).forEach(function (m) {
      detailsOf(m.events).forEach(function (d) {
        var winSide = d.wonBy;
        var loseSide = winSide === 'home' ? 'away' : 'home';
        var owner = (d.kind === 'error') ? loseSide : winSide;
        var entrantId = owner === 'home' ? m.homeEntrantId : m.awayEntrantId;

        if (entrantId) {
          byEntrant[entrantId] = byEntrant[entrantId] || blankTally();
          addTo(byEntrant[entrantId], d.how, d.kind);
        }
        if (d.by) {
          byPlayer[d.by] = byPlayer[d.by] || blankTally();
          addTo(byPlayer[d.by], d.how, d.kind);
        }
        addTo(overall, d.how, d.kind);
      });
    });

    return { byEntrant: byEntrant, byPlayer: byPlayer, overall: overall };
  }

  /* The longest run of points taken by one side, and by whom. Free from
   * the rally log, and the thing people argue about afterwards. */
  function longestStreak(events) {
    var live = TS.engines.liveEvents(events).filter(function (e) {
      return e.type === 'rally';
    });
    var best = { side: null, run: 0 };
    var side = null, run = 0;
    live.forEach(function (e) {
      if (e.payload.side === side) run += 1;
      else { side = e.payload.side; run = 1; }
      if (run > best.run) { best = { side: side, run: run }; }
    });
    return best;
  }

  /* Wall-clock length of a match, in minutes, from its own events. Phone
   * clocks are only trusted here because both ends of the measurement come
   * from the same device in almost every case; a negative or absurd span
   * is reported as unknown rather than as a number. */
  function durationMinutes(events) {
    var live = TS.engines.liveEvents(events);
    if (live.length < 2) return null;
    var first = Date.parse(live[0].at), last = Date.parse(live[live.length - 1].at);
    if (!first || !last) return null;
    var mins = (last - first) / 60000;
    if (mins < 0 || mins > 60 * 12) return null;
    return Math.round(mins);
  }

  TS.analysis = {
    LEVELS: LEVELS, SHOTS: SHOTS,
    levelOf: levelOf, shotsFor: shotsFor, shotById: shotById,
    pendingRally: pendingRally, detailsOf: detailsOf,
    aggregate: aggregate, longestStreak: longestStreak,
    durationMinutes: durationMinutes
  };

})(window.TS = window.TS || {});
