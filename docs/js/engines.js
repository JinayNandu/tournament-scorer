/* Tournament Scorer - scoring engines
 *
 * THE ONLY SPORT-AWARE CODE IN THE APP. Standings, progression and the views
 * read nothing but what summarize() returns. If sport knowledge ever leaks
 * out of this file, the design has failed.
 *
 * Every engine is a pure fold:
 *     initialState(config)  -> state
 *     reduce(state, event)  -> state      (new object, never mutated in place)
 *     summarize(state)      -> result     (the shape everything else reads)
 *
 * Two consequences worth stating, because the rest of the app depends on them:
 *
 * 1. WE LOG RALLY WINNERS, NOT POINTS. A {side} point log cannot express
 *    side-out scoring, where winning a rally may hand over serve instead of
 *    scoring. Logging who won each rally makes the score, the server number,
 *    the side-out and the end change all derivable.
 *
 * 2. UNDO APPENDS, IT NEVER POPS. An undo is an event naming the event it
 *    cancels. Popping an array loses writes when two phones score the same
 *    match and destroys the record of what was corrected. Undoing an undo is
 *    therefore redo, free.
 */
(function (TS) {
  'use strict';

  /* ------------------------------------------------------- event helpers -- */

  // Lamport-ish ordering. Phone clocks skew and the offline mirror has no
  // server timestamp, so wall time is a tiebreaker of last resort only.
  function sortEvents(events) {
    return (events || []).slice().sort(function (a, b) {
      if ((a.seq || 0) !== (b.seq || 0)) return (a.seq || 0) - (b.seq || 0);
      if ((a.clientId || '') !== (b.clientId || '')) {
        return (a.clientId || '') < (b.clientId || '') ? -1 : 1;
      }
      return (a.id || '') < (b.id || '') ? -1 : 1;
    });
  }

  function nextSeq(events) {
    var max = 0;
    (events || []).forEach(function (e) { if ((e.seq || 0) > max) max = e.seq; });
    return max + 1;
  }

  function makeEvent(events, clientId, type, payload) {
    return {
      id: TS.model.uid('ev'),
      seq: nextSeq(events),
      clientId: clientId || 'local',
      type: type,
      payload: payload || {},
      at: new Date().toISOString()
    };
  }

  /* An event is live unless a LIVE undo names it. Recursive, because undoing
   * an undo brings the original back. Undos only ever point backwards, so
   * there is no cycle. */
  function liveEvents(events) {
    var sorted = sortEvents(events);
    var targets = {};
    sorted.forEach(function (e) {
      if (e.type === 'undo' && e.payload && e.payload.targetEventId) {
        var t = e.payload.targetEventId;
        (targets[t] = targets[t] || []).push(e.id);
      }
    });
    var memo = {};
    function live(id) {
      if (memo[id] !== undefined) return memo[id];
      memo[id] = true;
      var us = targets[id] || [];
      for (var i = 0; i < us.length; i++) {
        if (live(us[i])) { memo[id] = false; return false; }
      }
      memo[id] = true;
      return true;
    }
    return sorted.filter(function (e) {
      return e.type !== 'undo' && live(e.id);
    });
  }

  /* The most recent event a plain "Undo" button should cancel. Notes about
   * a point are skipped: Undo is for taking the point back, and undoing
   * only its annotation would look like nothing happened. */
  var NOT_UNDOABLE = ['meta', 'detail'];
  function lastUndoableId(events) {
    var live = liveEvents(events);
    for (var i = live.length - 1; i >= 0; i--) {
      if (NOT_UNDOABLE.indexOf(live[i].type) === -1) return live[i].id;
    }
    return null;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function other(side) { return side === 'home' ? 'away' : 'home'; }

  /* =========================================================== rally ===== */
  /* Pickleball, badminton, squash, volleyball, table tennis. */

  var rally = {
    key: 'rally',

    initialState: function (cfg) {
      cfg = cfg || {};
      return {
        cfg: {
          bestOf: cfg.bestOf || 1,
          pointsToWin: cfg.pointsToWin || 21,
          winBy: cfg.winBy == null ? 2 : cfg.winBy,
          cap: cfg.cap || null,
          sideOut: !!cfg.sideOut,
          switchAt: cfg.switchAt || null,
          decidingGameTo: cfg.decidingGameTo || null,
          singles: !!cfg.singles
        },
        games: [],                        // completed games
        home: 0, away: 0,                 // current game
        gamesWon: { home: 0, away: 0 },
        pointsFor: { home: 0, away: 0 },  // across every game
        serving: 'home',
        // Pickleball starts a game with only one server for the first side
        // ("0-0-2"), so a single fault hands over serve.
        server: 2,
        /* Which PLAYER serves, not just which side. Slot 0 of a team is
         * whoever began the game in the right-hand court; startOrder maps
         * that slot to a position in the rubber's player list. A pair swaps
         * courts every time their own side scores while serving, which is
         * what `swaps` counts - and that, with the score, is enough to work
         * out who is standing where at any moment. */
        startOrder: { home: [0, 1], away: [0, 1] },
        swaps: { home: 0, away: 0 },
        // Under side-out the second server is the partner, who is NOT in
        // the court the score points at, so the serving slot is carried
        // rather than derived. Rally scoring derives it.
        servingSlot: 0,
        firstServeSet: false,
        /* Called at deuce: the next point taken ends the game whatever the
         * gap. It is the only moment where it changes anything - from one
         * point ahead, winning the next already gives you two clear. */
        golden: false,
        winner: null,
        complete: false,
        rallies: 0
      };
    },

    /* Level, and far enough in that reaching the target alone is not
     * enough. At 21 up, 20-20 is deuce and so is every level score after. */
    isDeuce: function (st) {
      if (st.complete) return false;
      if ((st.cfg.winBy || 1) < 2) return false;
      return st.home === st.away && st.home >= rally.target(st) - 1;
    },

    /* Which slot is standing in the right-hand court right now. */
    rightSlot: function (st, team) {
      return (st.swaps[team] % 2 === 0) ? 0 : 1;
    },

    /* Who is serving. Rally scoring: the player standing in the court the
     * score dictates - even is right. Side-out: whoever took the serve for
     * this turn, which is carried in state. */
    serverSlot: function (st) {
      if (st.cfg.sideOut) return st.servingSlot ? 1 : 0;
      var onRight = rally.rightSlot(st, st.serving);
      return (st[st.serving] % 2 === 0) ? onRight : 1 - onRight;
    },

    /* The court the serve is played from. */
    serveCourt: function (st) {
      if (!st.cfg.sideOut) return (st[st.serving] % 2 === 0) ? 'right' : 'left';
      return (rally.serverSlot(st) === rally.rightSlot(st, st.serving))
        ? 'right' : 'left';
    },

    /* The serve goes diagonally, so the receiver is the opponent standing in
     * the court of the same hand as the server's. */
    receiverSlot: function (st) {
      var recv = other(st.serving);
      var onRight = rally.rightSlot(st, recv);
      return (rally.serveCourt(st) === 'right') ? onRight : 1 - onRight;
    },

    target: function (st) {
      var gi = st.games.length;
      var decider = st.cfg.bestOf > 1 && gi === st.cfg.bestOf - 1;
      return (decider && st.cfg.decidingGameTo) ? st.cfg.decidingGameTo
                                                : st.cfg.pointsToWin;
    },

    // Who, if anyone, has won a game at this score.
    gameWinnerAt: function (h, a, target, winBy, cap) {
      if (cap) {
        if (h >= cap) return 'home';
        if (a >= cap) return 'away';
      }
      if (h >= target && h - a >= winBy) return 'home';
      if (a >= target && a - h >= winBy) return 'away';
      return null;
    },

    reduce: function (st, ev) {
      if (st.complete && ev.type !== 'setScore' && ev.type !== 'award') return st;
      var s = clone(st);
      var cfg = s.cfg;

      if (ev.type === 'rally') {
        var won = ev.payload.side;        // who won the rally
        if (won !== 'home' && won !== 'away') return st;
        s.rallies += 1;

        var pointTo = null;        // who actually gained a point, if anyone

        if (!cfg.sideOut) {
          // Rally scoring: every rally is a point, winner serves next. A
          // pair only changes court when they score while already serving -
          // a side that wins the serve stays where it is.
          s[won] += 1;
          s.pointsFor[won] += 1;
          pointTo = won;
          if (won === s.serving) s.swaps[won] += 1;
          s.serving = won;
          s.server = 1;
        } else if (won === s.serving) {
          // Side-out scoring: only the serving side can score, and scoring
          // is exactly when the pair swaps courts.
          s[won] += 1;
          s.pointsFor[won] += 1;
          pointTo = won;
          s.swaps[won] += 1;
        } else if (cfg.singles || s.server === 2) {
          s.serving = won;                // side out
          s.server = 1;
          // The player standing in the right court takes the first serve.
          s.servingSlot = rally.rightSlot(s, won);
        } else {
          s.server = 2;                   // the partner comes in
          s.servingSlot = 1 - s.servingSlot;
        }

        // Game and match completion. A golden point beats the usual
        // two-clear rule, but only if a point was actually scored.
        var t = rally.target(s);
        var gw = (s.golden && pointTo)
          ? pointTo
          : rally.gameWinnerAt(s.home, s.away, t, cfg.winBy, cfg.cap);
        if (gw) {
          s.golden = false;
          // `by` because a golden point is not derivable from the score:
          // 21-20 is nobody's game under the two-clear rule.
          s.games.push({ home: s.home, away: s.away, by: gw });
          s.gamesWon[gw] += 1;
          var need = Math.floor(cfg.bestOf / 2) + 1;
          if (s.gamesWon[gw] >= need) {
            s.winner = gw;
            s.complete = true;
          } else {
            s.home = 0; s.away = 0;
            s.serving = gw;               // game winner serves next game
            s.server = cfg.sideOut ? 2 : 1;   // one server only to open
            s.swaps = { home: 0, away: 0 };   // everyone back to their start court
            s.servingSlot = 0;
          }
        }
        return s;
      }

      // Manual correction of a game score, live or finished.
      if (ev.type === 'setScore') {
        var gi = ev.payload.gameIndex;
        var sh = ev.payload.home || 0, sa = ev.payload.away || 0;
        if (gi == null || gi === s.games.length) {
          s.home = sh;
          s.away = sa;
        } else if (s.games[gi]) {
          // No `by`: the organiser has restated the score, so who won it
          // is read off the new numbers rather than the old call.
          s.games[gi] = { home: sh, away: sa };
          // Once the match is over the board is still showing that last
          // game, so it has to move with it - otherwise the big score and
          // the result line disagree.
          if (s.complete && gi === s.games.length - 1) { s.home = sh; s.away = sa; }
        }
        return rally.recount(s);
      }

      // Walkover / retirement: a winner with no rallies.
      if (ev.type === 'award') {
        s.winner = ev.payload.side || null;
        s.complete = true;
        s.awarded = ev.payload.reason || 'awarded';
        return s;
      }

      /* Who serves and who receives the very first point. The server is, by
       * definition, standing in the right-hand court at 0-0, and so is the
       * player receiving them - so naming those two fixes both pairs'
       * starting courts and the whole rotation follows. */
      if (ev.type === 'firstServe') {
        var side = ev.payload.side === 'away' ? 'away' : 'home';
        var opp = other(side);
        s.serving = side;
        s.server = cfg.sideOut ? 2 : 1;
        s.swaps = { home: 0, away: 0 };
        var sv = ev.payload.serverIndex ? 1 : 0;
        var rc = ev.payload.receiverIndex ? 1 : 0;
        s.startOrder[side] = [sv, 1 - sv];
        s.startOrder[opp] = [rc, 1 - rc];
        s.servingSlot = 0;        // the named server is slot 0 by definition
        s.firstServeSet = true;
        return s;
      }

      /* A hand correction when the rotation has drifted: name who should be
       * serving now, and the pair's courts are re-derived around them. */
      /* "Next point wins." Undoing this event disarms it again, because the
       * fold simply stops seeing it. */
      if (ev.type === 'golden') {
        s.golden = ev.payload.on === false ? false : true;
        return s;
      }

      if (ev.type === 'serve') {
        if (ev.payload.side && ev.payload.side !== s.serving) {
          s.serving = ev.payload.side;
          s.servingSlot = rally.rightSlot(s, s.serving);
          s.server = 1;
        }
        if (ev.payload.server) s.server = ev.payload.server;
        if (ev.payload.serverIndex != null) {
          var slot = rally.serverSlot(s);
          var want = ev.payload.serverIndex ? 1 : 0;
          var ord = s.startOrder[s.serving].slice();
          ord[slot] = want;
          ord[1 - slot] = 1 - want;
          s.startOrder[s.serving] = ord;
        }
        if (ev.payload.receiverIndex != null) {
          var recv = other(s.serving);
          var rslot = rally.receiverSlot(s);
          var rwant = ev.payload.receiverIndex ? 1 : 0;
          var rord = s.startOrder[recv].slice();
          rord[rslot] = rwant;
          rord[1 - rslot] = 1 - rwant;
          s.startOrder[recv] = rord;
        }
        return s;
      }

      return s;
    },

    // Recompute derived totals after a hand correction.
    recount: function (s) {
      var cfg = s.cfg;

      function wonBy(g, i) {
        if (g.by) return g.by;            // a golden point, say
        var decider = cfg.bestOf > 1 && i === cfg.bestOf - 1;
        var t = (decider && cfg.decidingGameTo) ? cfg.decidingGameTo : cfg.pointsToWin;
        return rally.gameWinnerAt(g.home, g.away, t, cfg.winBy, cfg.cap);
      }

      /* A correction can un-finish the last game - 21-10 typed back to
       * 15-10. Put it back on court rather than leaving a game in the
       * list that nobody won: it would show twice and the match could
       * never be finished again. */
      while (s.games.length &&
             !wonBy(s.games[s.games.length - 1], s.games.length - 1)) {
        var back = s.games.pop();
        s.home = back.home; s.away = back.away;
      }

      s.gamesWon = { home: 0, away: 0 };
      s.games.forEach(function (g, i) {
        var w = wonBy(g, i);
        if (w) s.gamesWon[w] += 1;
      });

      var need = Math.floor(cfg.bestOf / 2) + 1;
      s.winner = s.gamesWon.home >= need ? 'home'
               : s.gamesWon.away >= need ? 'away' : null;
      s.complete = !!s.winner;

      /* The last game of a finished match stays in s.home/s.away as well
       * as in games, so the board can keep showing it. Counting both put
       * every point of a corrected match into the table twice - a 21-10
       * win came out as 19-42. */
      s.pointsFor = { home: 0, away: 0 };
      s.games.forEach(function (g) {
        s.pointsFor.home += g.home;
        s.pointsFor.away += g.away;
      });
      if (!s.complete) {
        s.pointsFor.home += s.home;
        s.pointsFor.away += s.away;
      }
      return s;
    },

    isComplete: function (st) { return !!st.complete; },

    summarize: function (st) {
      var cfg = st.cfg;
      var t = rally.target(st);
      var gp = [];
      if (!st.complete) {
        if (rally.gameWinnerAt(st.home + 1, st.away, t, cfg.winBy, cfg.cap) === 'home') {
          gp.push('home');
        }
        if (rally.gameWinnerAt(st.home, st.away + 1, t, cfg.winBy, cfg.cap) === 'away') {
          gp.push('away');
        }
      }
      // With a golden point called, whoever takes the next point has won.
      if (!st.complete && st.golden) gp = ['home', 'away'];

      var need = Math.floor(cfg.bestOf / 2) + 1;
      var matchPoint = {};
      gp.forEach(function (side) {
        matchPoint[side] = st.gamesWon[side] + 1 >= need;
      });

      // Ends change at switchAt in the deciding game (badminton).
      var decider = cfg.bestOf > 1 && st.games.length === cfg.bestOf - 1;
      var switchDue = !!(cfg.switchAt && decider && !st.complete &&
                         Math.max(st.home, st.away) >= cfg.switchAt);

      // Copied rather than passed through: `by` is the engine's own note
      // about how a game was won, and the summary's shape is a contract.
      var allGames = st.games.map(function (g) {
        return { home: g.home, away: g.away };
      }).concat(st.complete ? [] : [{ home: st.home, away: st.away }]);

      return {
        engine: 'rally',
        complete: !!st.complete,
        winner: st.winner,
        current: { home: st.home, away: st.away },
        games: allGames,
        gamesWon: { home: st.gamesWon.home, away: st.gamesWon.away },
        // What a tie counts as "this rubber was won by..."
        primary: { home: st.gamesWon.home, away: st.gamesWon.away },
        secondary: { home: st.pointsFor.home, away: st.pointsFor.away },
        metrics: { points: { home: st.pointsFor.home, away: st.pointsFor.away } },
        serving: st.serving,
        server: st.server,
        sideOut: cfg.sideOut,
        winBy: cfg.winBy,
        // Who serves and who receives, as positions in each side's player
        // list, so nobody has to remember whose turn it is.
        serveCourt: rally.serveCourt(st),
        serverIndex: st.startOrder[st.serving][rally.serverSlot(st)],
        receiverIndex: st.startOrder[other(st.serving)][rally.receiverSlot(st)],
        startOrder: st.startOrder,
        firstServeSet: !!st.firstServeSet,
        // The call used in pickleball: our score, theirs, which server.
        callScore: cfg.sideOut
          ? st[st.serving] + '-' + st[other(st.serving)] + '-' + st.server
          : null,
        target: t,
        gamePoint: gp,
        matchPoint: matchPoint,
        golden: !!st.golden,
        deuce: rally.isDeuce(st),
        switchDue: switchDue,
        rallies: st.rallies,
        line: rally.line(st)
      };
    },

    // "21-18, 19-21, 15-11" - the way a result is written down.
    line: function (st) {
      var parts = st.games.map(function (g) { return g.home + '-' + g.away; });
      if (!st.complete && (st.home || st.away || !parts.length)) {
        parts.push(st.home + '-' + st.away);
      }
      return parts.join(', ');
    }
  };

  /* =========================================================== tally ===== */
  /* Football, hockey, basketball, netball - a running count with periods. */

  var tally = {
    key: 'tally',

    initialState: function (cfg) {
      cfg = cfg || {};
      return {
        cfg: {
          increments: cfg.increments || [1],
          periods: cfg.periods || 2,
          periodName: cfg.periodName || 'Half',
          allowDraw: cfg.allowDraw !== false,
          unitName: cfg.unitName || 'Goals'
        },
        home: 0, away: 0,
        period: 1,
        scorers: [],              // [{side, n, playerId}] for the timeline
        ended: false,
        winner: null,
        decider: null             // penalties etc: a winner without a score
      };
    },

    reduce: function (st, ev) {
      var s = clone(st);
      if (ev.type === 'score') {
        var side = ev.payload.side, n = ev.payload.n || 1;
        if (side !== 'home' && side !== 'away') return st;
        s[side] += n;
        s.scorers.push({ side: side, n: n, playerId: ev.payload.playerId || null,
                         at: ev.at });
        return s;
      }
      if (ev.type === 'period') {
        s.period = Math.min(s.cfg.periods, (ev.payload.period || s.period + 1));
        return s;
      }
      if (ev.type === 'setScore') {
        s.home = ev.payload.home || 0;
        s.away = ev.payload.away || 0;
        return s;
      }
      if (ev.type === 'decider') {       // shootout: winner, score untouched
        s.decider = { kind: ev.payload.kind || 'penalties',
                      home: ev.payload.home, away: ev.payload.away };
        return s;
      }
      if (ev.type === 'end') {
        s.ended = true;
        s.winner = s.home > s.away ? 'home' : s.away > s.home ? 'away' : null;
        if (!s.winner && s.decider) {
          s.winner = s.decider.home > s.decider.away ? 'home'
                   : s.decider.away > s.decider.home ? 'away' : null;
        }
        return s;
      }
      return s;
    },

    isComplete: function (st) { return !!st.ended; },

    summarize: function (st) {
      return {
        engine: 'tally',
        complete: !!st.ended,
        // A shootout winner must not disturb goal difference, so the winner
        // can differ from the scoreline.
        winner: st.winner,
        drawn: st.ended && st.home === st.away && !st.decider,
        current: { home: st.home, away: st.away },
        games: [{ home: st.home, away: st.away }],
        primary: { home: st.home, away: st.away },
        secondary: { home: st.home, away: st.away },
        metrics: {},
        period: st.period,
        decider: st.decider,
        scorers: st.scorers,
        line: st.home + '-' + st.away +
              (st.decider ? ' (' + st.decider.home + '-' + st.decider.away + ' pens)' : '')
      };
    }
  };

  /* ========================================================== manual ===== */
  /* The escape hatch that keeps "flexible to any sport" honest: type the
   * final score. Chess, carrom, tug of war, a format invented that morning. */

  var manual = {
    key: 'manual',

    initialState: function (cfg) {
      cfg = cfg || {};
      return {
        cfg: { unitName: cfg.unitName || 'Score', allowDraw: cfg.allowDraw !== false },
        home: null, away: null, ended: false, winner: null
      };
    },

    reduce: function (st, ev) {
      var s = clone(st);
      if (ev.type === 'setScore') {
        s.home = ev.payload.home;
        s.away = ev.payload.away;
        s.ended = true;
        s.winner = s.home > s.away ? 'home' : s.away > s.home ? 'away' : null;
        return s;
      }
      if (ev.type === 'award') {
        s.winner = ev.payload.side || null;
        s.ended = true;
        return s;
      }
      return s;
    },

    isComplete: function (st) { return !!st.ended; },

    summarize: function (st) {
      var h = st.home || 0, a = st.away || 0;
      return {
        engine: 'manual',
        complete: !!st.ended,
        winner: st.winner,
        drawn: st.ended && h === a,
        current: { home: h, away: a },
        games: [{ home: h, away: a }],
        primary: { home: h, away: a },
        secondary: { home: h, away: a },
        metrics: {},
        line: st.ended ? h + '-' + a : ''
      };
    }
  };

  /* ------------------------------------------------------------ registry -- */

  var ENGINES = { rally: rally, tally: tally, manual: manual };

  function get(name) { return ENGINES[name] || manual; }
  function register(name, engine) { ENGINES[name] = engine; }

  /* Fold a rubber's event log into state, then into a summary. This is the
   * only way state is ever produced - there is no incremental path, so a
   * stale cached summary can always be healed by re-folding. */
  function fold(engineName, cfg, events) {
    var eng = get(engineName);
    var st = eng.initialState(cfg);
    liveEvents(events).forEach(function (ev) { st = eng.reduce(st, ev); });
    return st;
  }

  function summarize(engineName, cfg, events) {
    var eng = get(engineName);
    var s = eng.summarize(fold(engineName, cfg, events));
    s.eventCount = (events || []).length;
    var live = liveEvents(events);
    s.lastEventId = live.length ? live[live.length - 1].id : null;
    return s;
  }

  TS.engines = {
    get: get,
    register: register,
    fold: fold,
    summarize: summarize,
    sortEvents: sortEvents,
    liveEvents: liveEvents,
    lastUndoableId: lastUndoableId,
    nextSeq: nextSeq,
    makeEvent: makeEvent,
    other: other,
    rally: rally,
    tally: tally,
    manual: manual
  };

})(window.TS = window.TS || {});
