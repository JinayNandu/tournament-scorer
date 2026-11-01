/* Tournament Scorer - self test
 *
 * There is no test runner on the machine this was built on (no Node, no
 * Python), so correctness is proved here, in the browser, against the pure
 * modules. Open the app at #selftest.
 *
 * Everything asserted below is something that would otherwise be found out
 * courtside, in the middle of a match, by an organiser who cannot fix it.
 */
(function (TS) {
  'use strict';

  var results = [];
  var group = '';

  function describe(name, fn) { group = name; fn(); }

  function it(name, fn) {
    try {
      fn();
      results.push({ group: group, name: name, pass: true });
    } catch (e) {
      results.push({ group: group, name: name, pass: false,
                     message: (e && e.message) || String(e) });
    }
  }

  function eq(actual, expected, what) {
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error((what ? what + ': ' : '') + 'expected ' + b + ', got ' + a);
    }
  }

  function ok(cond, what) {
    if (!cond) throw new Error(what || 'expected true');
  }

  function close(actual, expected, tol, what) {
    if (Math.abs(actual - expected) > (tol || 1e-9)) {
      throw new Error((what || '') + ' expected ~' + expected + ', got ' + actual);
    }
  }

  /* ------------------------------------------------------------ helpers -- */

  var M, E, S, SCH, P;

  // Score a rally match by feeding it a string of H/A rally winners.
  function playRally(cfg, seq) {
    var events = [];
    seq.split('').forEach(function (ch) {
      events.push(E.makeEvent(events, 'test', 'rally',
        { side: ch === 'H' ? 'home' : 'away' }));
    });
    return { events: events, sum: E.summarize('rally', cfg, events) };
  }

  function result(opts) {
    return {
      fixtureId: opts.id, stageId: opts.stage || 's1', groupId: opts.group || 'g1',
      status: 'completed',
      home: opts.home, away: opts.away,
      outcome: opts.outcome,
      units: { home: opts.hf, away: opts.af },
      subUnits: { home: opts.hs == null ? opts.hf : opts.hs,
                  away: opts.as == null ? opts.af : opts.as },
      metrics: opts.metrics || { home: {}, away: {} },
      weight: opts.weight == null ? 1 : opts.weight
    };
  }

  /* ============================================================= TESTS === */

  function run() {
    results = [];
    M = TS.model; E = TS.engines; S = TS.standings; SCH = TS.schedule; P = TS.progression;

    /* ---------------------------------------------------- rubber labels -- */
    describe('Rubber labels', function () {
      var g = M.DEFAULT_GRADES;
      it('C1D1 pairs the two named grades', function () {
        eq(M.parseRubberLabel('C1D1', g), ['C1', 'D1']);
      });
      it('AA means both A players', function () {
        eq(M.parseRubberLabel('AA', g), ['A1', 'A2']);
      });
      it('AB means the first of each grade', function () {
        eq(M.parseRubberLabel('AB', g), ['A1', 'B1']);
      });
      /* config.grades starts empty and no screen fills it, so reading a
       * label against it alone resolved nothing and the graded format -
       * eleven doubles called AA, BB, C1D1 - never picked a single
       * player. The fallback is what makes the labels mean anything. */
      it('a label resolves even when no grade list was typed in', function () {
        var t = M.makeTournament({ name: 'T', sport: 'pickleball' });
        t.config.useGrades = true;
        eq(t.config.grades, [], 'nothing fills this list');
        eq(M.slotsForLabel(t, 'AA'), ['A1', 'A2']);
        eq(M.slotsForLabel(t, 'C1D1'), ['C1', 'D1']);
      });

      it('a grade list the organiser set wins over the standard one', function () {
        var t = M.makeTournament({ name: 'T', sport: 'pickleball' });
        t.config.useGrades = true;
        t.config.grades = ['A1', 'A2'];
        eq(M.slotsForLabel(t, 'AA'), ['A1', 'A2']);
        eq(M.slotsForLabel(t, 'C1D1'), [], 'C and D are not grades here');
      });

      it('with grades off a label names nobody', function () {
        var t = M.makeTournament({ name: 'T', sport: 'pickleball' });
        eq(t.config.useGrades, false);
        eq(M.slotsForLabel(t, 'AA'), []);
      });

      it('switching grades on re-reads a match list set up beforehand', function () {
        var t = M.makeTournament({ name: 'T', sport: 'pickleball' });
        t.config.tieTemplate.rubbers = ['AA', 'C1D1', 'Kids doubles'].map(function (l) {
          return { id: l, label: l, kind: 'team', homeSlots: [], awaySlots: [] };
        });
        M.reparseTemplate(t);
        eq(t.config.tieTemplate.rubbers[0].homeSlots, [], 'still off');

        t.config.useGrades = true;
        M.reparseTemplate(t);
        var rs = t.config.tieTemplate.rubbers;
        eq(rs[0].homeSlots, ['A1', 'A2']);
        eq(rs[0].awaySlots, ['A1', 'A2'], 'both sides');
        eq(rs[0].kind, 'doubles');
        eq(rs[1].homeSlots, ['C1', 'D1']);
        eq(rs[2].homeSlots, [], 'a name that is not a grade is left alone');
        eq(rs[2].kind, 'team');
      });

      /* The "one each" style names the categories A, B, C with no number.
       * Every branch of the parser used to add a "1" before looking, so a
       * game called A asked for A1 and found nobody - the whole style
       * resolved to nothing. */
      it('a one-letter category is a category', function () {
        var one = ['A', 'B', 'C', 'D'];
        eq(M.parseRubberLabel('A', one), ['A']);
        eq(M.parseRubberLabel('AB', one), ['A', 'B']);
        eq(M.parseRubberLabel('CD', one), ['C', 'D']);
        eq(M.parseRubberLabel('E', one), null, 'E is not one of them');
      });

      it('numbered categories still win where both would read', function () {
        // With A1/A2 present, "AA" is the A pair, not the category "A".
        eq(M.parseRubberLabel('AA', g), ['A1', 'A2']);
      });

      /* The games a set of categories makes, so the organiser picks from
       * a list instead of typing AA, BB, C1D1 by hand. */
      it('builds the games a set of categories implies', function () {
        var sets = M.categoryGames(['A1', 'A2', 'B1', 'B2', 'C1', 'C2',
                                    'D1', 'D2', 'E1', 'E2', 'F1']);
        eq(sets.together.map(function (x) { return x.label; }),
           ['AA', 'BB', 'CC', 'DD', 'EE']);
        eq(sets.across.map(function (x) { return x.label; }),
           ['A1B1', 'A2B2', 'C1D1', 'C2D2', 'E1F1']);
        eq(sets.singles.length, 11);
        eq(sets.together[0].kind, 'doubles');
        eq(sets.singles[0].kind, 'singles');
      });

      it('an odd category has no pair to play together', function () {
        var sets = M.categoryGames(['A1', 'A2', 'B1']);
        eq(sets.together.map(function (x) { return x.label; }), ['AA']);
        eq(sets.across.map(function (x) { return x.label; }), ['A1B1']);
      });

      it('one-each categories pair off across', function () {
        var sets = M.categoryGames(['A', 'B', 'C', 'D']);
        eq(sets.together, [], 'nobody to pair with inside a category');
        eq(sets.across.map(function (x) { return x.label; }), ['AB', 'CD']);
        eq(sets.singles.map(function (x) { return x.label; }), ['A', 'B', 'C', 'D']);
      });

      it('A1 alone is a singles slot', function () {
        eq(M.parseRubberLabel('A1', g), ['A1']);
      });
      it('separators are ignored', function () {
        eq(M.parseRubberLabel('C1/D1', g), ['C1', 'D1']);
      });
      it('a label naming no known grade is left to the organiser', function () {
        eq(M.parseRubberLabel('MD', g), null);
        eq(M.parseRubberLabel('Z9Z8', g), null);
      });
    });

    /* ----------------------------------------------------- rally engine -- */
    describe('Rally scoring', function () {
      var to21 = { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false };

      it('21-19 wins a game to 21', function () {
        var r = playRally(to21, interleave(19, 19) + 'HH');
        ok(r.sum.complete, 'should be complete');
        eq(r.sum.winner, 'home');
        eq(r.sum.games[0], { home: 21, away: 19 });
      });

      it('rallies after the game is won are ignored', function () {
        var r = playRally(to21, repeat('H', 21) + repeat('A', 19));
        eq(r.sum.games[0], { home: 21, away: 0 });
        eq(r.sum.winner, 'home');
      });

      it('21-20 does NOT win - win by two', function () {
        var seq = interleave(20, 20) + 'H';     // 21-20
        var r = playRally(to21, seq);
        eq(r.sum.current, { home: 21, away: 20 });
        ok(!r.sum.complete, 'must not be complete at 21-20');
      });

      it('22-20 wins', function () {
        var seq = interleave(20, 20) + 'HH';
        var r = playRally(to21, seq);
        ok(r.sum.complete);
        eq(r.sum.winner, 'home');
        eq(r.sum.games[0], { home: 22, away: 20 });
      });

      it('a cap of 30 ends 29-29 on the next point', function () {
        var cfg = { bestOf: 1, pointsToWin: 21, winBy: 2, cap: 30, sideOut: false };
        var r29 = playRally(cfg, interleave(29, 29));
        ok(!r29.sum.complete, '29-29 is not over');
        var r30 = playRally(cfg, interleave(29, 29) + 'H');
        ok(r30.sum.complete, '30-29 ends it at the cap');
        eq(r30.sum.winner, 'home');
      });

      it('best of 3 needs two games', function () {
        var cfg = { bestOf: 3, pointsToWin: 11, winBy: 2, cap: null, sideOut: false };
        var r = playRally(cfg, repeat('H', 11) + repeat('A', 11));
        ok(!r.sum.complete, 'one game each is not a match');
        eq(r.sum.gamesWon, { home: 1, away: 1 });
        var r2 = playRally(cfg, repeat('H', 11) + repeat('A', 11) + repeat('H', 11));
        ok(r2.sum.complete);
        eq(r2.sum.winner, 'home');
      });

      it('a deciding game can have its own target', function () {
        var cfg = { bestOf: 3, pointsToWin: 25, winBy: 2, cap: null,
                    sideOut: false, decidingGameTo: 15 };
        var r = playRally(cfg, repeat('H', 25) + repeat('A', 25) + repeat('H', 15));
        ok(r.sum.complete, 'third game to 15 should finish it');
        eq(r.sum.games[2], { home: 15, away: 0 });
      });

      it('points scored are totalled across games', function () {
        var cfg = { bestOf: 3, pointsToWin: 11, winBy: 2, cap: null, sideOut: false };
        var r = playRally(cfg, repeat('H', 11) + repeat('A', 11) + repeat('H', 11));
        eq(r.sum.secondary, { home: 22, away: 11 });
      });

      it('game point and match point are flagged', function () {
        var cfg = { bestOf: 1, pointsToWin: 11, winBy: 2, cap: null, sideOut: false };
        var r = playRally(cfg, repeat('H', 10));
        eq(r.sum.gamePoint, ['home']);
        eq(r.sum.matchPoint.home, true);
      });
    });

    /* ------------------------------------------- deuce and golden point -- */
    describe('Deuce and the golden point', function () {
      var to21 = { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false };

      function events(seq) {
        var evs = [];
        seq.split('').forEach(function (ch) {
          evs.push(E.makeEvent(evs, 't', 'rally',
            { side: ch === 'H' ? 'home' : 'away' }));
        });
        return evs;
      }

      it('level one short of the target is deuce', function () {
        var s = E.summarize('rally', to21, events(interleave(20, 20)));
        eq(s.current, { home: 20, away: 20 });
        ok(s.deuce, '20-20 is deuce');
        ok(!s.complete);
      });

      it('reaching the target one ahead is not a win', function () {
        var s = E.summarize('rally', to21, events(interleave(20, 20) + 'H'));
        eq(s.current, { home: 21, away: 20 });
        ok(!s.complete, '21-20 keeps going');
        ok(!s.deuce, 'and it is no longer level');
      });

      it('two clear wins it, from either side', function () {
        var h = E.summarize('rally', to21, events(interleave(20, 20) + 'HH'));
        ok(h.complete); eq(h.winner, 'home'); eq(h.games[0], { home: 22, away: 20 });
        var a = E.summarize('rally', to21, events(interleave(20, 20) + 'AA'));
        ok(a.complete); eq(a.winner, 'away'); eq(a.games[0], { home: 20, away: 22 });
      });

      it('deuce comes back at every level score after the target', function () {
        ok(E.summarize('rally', to21, events(interleave(22, 22))).deuce,
           '22-22 is deuce too');
      });

      it('a golden point ends it on the next point, one ahead', function () {
        var evs = events(interleave(22, 22));
        evs.push(E.makeEvent(evs, 't', 'golden', {}));
        ok(E.summarize('rally', to21, evs).golden, 'armed');
        evs.push(E.makeEvent(evs, 't', 'rally', { side: 'home' }));
        var s = E.summarize('rally', to21, evs);
        ok(s.complete, '23-22 wins once a golden point is called');
        eq(s.winner, 'home');
        eq(s.games[0], { home: 23, away: 22 });
      });

      it('both sides are on the brink once it is called', function () {
        var evs = events(interleave(22, 22));
        evs.push(E.makeEvent(evs, 't', 'golden', {}));
        eq(E.summarize('rally', to21, evs).gamePoint.sort(), ['away', 'home']);
      });

      it('undoing the deciding point leaves the golden point standing', function () {
        var evs = events(interleave(22, 22));
        evs.push(E.makeEvent(evs, 't', 'golden', {}));
        evs.push(E.makeEvent(evs, 't', 'rally', { side: 'home' }));
        evs.push(E.makeEvent(evs, 't', 'undo',
          { targetEventId: E.lastUndoableId(evs) }));
        var s = E.summarize('rally', to21, evs);
        ok(!s.complete, 'back to 22-22');
        ok(s.golden, 'still the next point that wins');
      });

      it('undoing the call itself takes it back off', function () {
        var evs = events(interleave(22, 22));
        var g = E.makeEvent(evs, 't', 'golden', {});
        evs.push(g);
        evs.push(E.makeEvent(evs, 't', 'undo', { targetEventId: g.id }));
        var s = E.summarize('rally', to21, evs);
        ok(!s.golden);
        evs.push(E.makeEvent(evs, 't', 'rally', { side: 'home' }));
        ok(!E.summarize('rally', to21, evs).complete, '23-22 is not a win again');
      });

      it('with no two-clear rule there is no deuce', function () {
        var sudden = { bestOf: 1, pointsToWin: 21, winBy: 1, cap: null, sideOut: false };
        var s = E.summarize('rally', sudden, events(interleave(20, 20) + 'H'));
        ok(s.complete, '21-20 just wins');
        ok(!E.summarize('rally', sudden, events(interleave(20, 20))).deuce);
      });

      it('under side-out a golden point needs an actual point', function () {
        var so = { bestOf: 1, pointsToWin: 11, winBy: 2, cap: null, sideOut: true };
        var evs = [];
        evs.push(E.makeEvent(evs, 't', 'setScore', { home: 10, away: 10 }));
        evs.push(E.makeEvent(evs, 't', 'golden', {}));
        // Home is serving; away winning the rally is only a side out.
        evs.push(E.makeEvent(evs, 't', 'rally', { side: 'away' }));
        var mid = E.summarize('rally', so, evs);
        ok(!mid.complete, 'winning the rally off serve scores nothing');
        eq(mid.current, { home: 10, away: 10 });
        // Now away are serving, so the next one counts.
        evs.push(E.makeEvent(evs, 't', 'rally', { side: 'away' }));
        var done = E.summarize('rally', so, evs);
        ok(done.complete);
        eq(done.winner, 'away');
        eq(done.games[0], { home: 10, away: 11 });
      });
    });

    /* ------------------------------------------------- side-out scoring -- */
    describe('Side-out serving', function () {
      var cfg = { bestOf: 1, pointsToWin: 11, winBy: 2, cap: null, sideOut: true };

      it('only the serving side can score', function () {
        var r = playRally(cfg, 'A');          // receiver wins the first rally
        eq(r.sum.current, { home: 0, away: 0 }, 'no point for the receiver');
      });

      it('the first service of a game has one server, then it is a side out', function () {
        var r = playRally(cfg, 'A');
        eq(r.sum.serving, 'away');
        eq(r.sum.server, 1);
      });

      it('the second server comes in before serve changes hands', function () {
        // away serves (server 1), home wins a rally -> away's second server
        var r = playRally(cfg, 'AAH');
        eq(r.sum.serving, 'away', 'serve stays with away');
        eq(r.sum.server, 2);
        eq(r.sum.current, { home: 0, away: 1 });
      });

      it('losing on the second server hands over serve', function () {
        var r = playRally(cfg, 'AAHH');
        eq(r.sum.serving, 'home');
        eq(r.sum.server, 1);
      });

      it('singles side-out changes serve on every lost rally', function () {
        var s = { bestOf: 1, pointsToWin: 11, winBy: 2, sideOut: true, singles: true };
        var r = playRally(s, 'AH');
        eq(r.sum.serving, 'home');
      });
    });

    /* ------------------------------------------- serving and receiving -- */
    describe('Who serves and who receives', function () {
      /* Slot 0 of a side is the player who began the game in the right
       * court. A pair changes court only when they score while serving, and
       * the serve is played from the right court on an even score - those
       * two rules together fix who is standing where at every point. */
      function play(cfg, seq, first) {
        var events = [];
        events.push(E.makeEvent(events, 't', 'firstServe', first || {
          side: 'home', serverIndex: 0, receiverIndex: 0
        }));
        (seq || '').split('').forEach(function (ch) {
          if (!ch.trim()) return;
          events.push(E.makeEvent(events, 't', 'rally',
            { side: ch === 'H' ? 'home' : 'away' }));
        });
        return { events: events, sum: E.summarize('rally', cfg, events) };
      }

      var RALLY = { bestOf: 1, pointsToWin: 21, winBy: 2, sideOut: false };
      var SIDEOUT = { bestOf: 1, pointsToWin: 11, winBy: 2, sideOut: true };

      it('starts with exactly the players you named', function () {
        var r = play(RALLY, '', { side: 'away', serverIndex: 1, receiverIndex: 1 });
        eq(r.sum.serving, 'away');
        eq(r.sum.serverIndex, 1, 'the away player you picked serves');
        eq(r.sum.receiverIndex, 1, 'the home player you picked receives');
        eq(r.sum.serveCourt, 'right', 'the first serve is always from the right');
      });

      it('the same player serves on, from the other court, after scoring', function () {
        var r = play(RALLY, 'H');
        eq(r.sum.serving, 'home');
        eq(r.sum.serverIndex, 0, 'still the same server');
        eq(r.sum.serveCourt, 'left', 'moved across after scoring');
        eq(r.sum.receiverIndex, 1, 'so the other opponent receives');
      });

      it('winning the serve does not move the winners across', function () {
        // Away win the rally: they serve, but neither pair changes court,
        // so the server is whoever stands in the court their score names.
        var r = play(RALLY, 'A');
        eq(r.sum.serving, 'away');
        eq(r.sum.serveCourt, 'left', 'away are on 1, which is odd');
        eq(r.sum.serverIndex, 1, 'the away player in the left court');
      });

      it('keeps the rotation right over a run of rallies', function () {
        // home scores, away scores twice, home scores: by then home have
        // swapped once, so their second player is in the right court.
        var r = play(RALLY, 'HAAH');
        eq(r.sum.current, { home: 2, away: 2 });
        eq(r.sum.serving, 'home');
        eq(r.sum.serveCourt, 'right');
        eq(r.sum.serverIndex, 1, 'the partner is the one in the right court now');
        eq(r.sum.receiverIndex, 1);
      });

      it('server and receiver are always in matching courts', function () {
        // Whatever sequence is played, the serve is diagonal: both players
        // stand in the same-handed court.
        var seqs = ['', 'H', 'A', 'HH', 'HA', 'AH', 'AA', 'HAAH', 'HHAAHA', 'AAHHAH'];
        seqs.forEach(function (seq) {
          var s = play(RALLY, seq).sum;
          ok(s.serverIndex === 0 || s.serverIndex === 1, seq + ': server set');
          ok(s.receiverIndex === 0 || s.receiverIndex === 1, seq + ': receiver set');
          ok(s.serveCourt === 'right' || s.serveCourt === 'left', seq + ': court set');
        });
      });

      it('a game opens with one server, then it is a side out', function () {
        var r = play(SIDEOUT, '');
        eq(r.sum.serverIndex, 0);
        eq(r.sum.serveCourt, 'right');
        eq(r.sum.callScore, '0-0-2', 'pickleball opens at 0-0-2');

        var out = play(SIDEOUT, 'A');
        eq(out.sum.serving, 'away', 'one fault and the serve is gone');
        eq(out.sum.serverIndex, 0, 'their right-court player takes it');
        eq(out.sum.callScore, '0-0-1');
      });

      it('the partner comes in as second server, from the other court', function () {
        var r = play(SIDEOUT, 'AH');
        eq(r.sum.serving, 'away', 'serve has not changed hands');
        eq(r.sum.serverIndex, 1, 'the partner is serving now');
        eq(r.sum.serveCourt, 'left');
        eq(r.sum.callScore, '0-0-2');
      });

      it('the second server keeps serving and swaps court on a point', function () {
        var r = play(SIDEOUT, 'AHA');
        eq(r.sum.current, { home: 0, away: 1 });
        eq(r.sum.serverIndex, 1, 'same player');
        eq(r.sum.serveCourt, 'right', 'swapped across after scoring');
        eq(r.sum.callScore, '1-0-2');
      });

      it('losing on the second server hands the serve over', function () {
        var r = play(SIDEOUT, 'AHAH');
        eq(r.sum.serving, 'home');
        eq(r.sum.callScore, '0-1-1');
      });

      it('only the serving side can score under side-out', function () {
        eq(play(SIDEOUT, 'A').sum.current, { home: 0, away: 0 });
      });

      it('naming the server by hand corrects the rotation', function () {
        var r = play(RALLY, 'HAAH');
        eq(r.sum.serverIndex, 1);
        r.events.push(E.makeEvent(r.events, 't', 'serve',
          { side: 'home', serverIndex: 0 }));
        var fixed = E.summarize('rally', RALLY, r.events);
        eq(fixed.serving, 'home');
        eq(fixed.serverIndex, 0, 'the player you named is now serving');
      });

      it('the serve can be handed to the other side by hand', function () {
        var r = play(RALLY, 'HH');
        r.events.push(E.makeEvent(r.events, 't', 'serve',
          { side: 'away', serverIndex: 1 }));
        var fixed = E.summarize('rally', RALLY, r.events);
        eq(fixed.serving, 'away');
        eq(fixed.serverIndex, 1);
      });

      it('a new game puts everyone back to their starting court', function () {
        var bo3 = { bestOf: 3, pointsToWin: 2, winBy: 1, sideOut: false };
        var r = play(bo3, 'HH');           // home take game one
        eq(r.sum.gamesWon, { home: 1, away: 0 });
        eq(r.sum.serving, 'home', 'the winners serve next game');
        eq(r.sum.serverIndex, 0, 'back to the player who started on the right');
        eq(r.sum.serveCourt, 'right');
      });
    });

    /* ------------------------------------------- correcting a score ----- */
    describe('Correcting a score by hand', function () {
      var to21 = { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false };

      function rallies(seq) {
        var evs = [];
        seq.split('').forEach(function (ch) {
          evs.push(E.makeEvent(evs, 't', 'rally',
            { side: ch === 'H' ? 'home' : 'away' }));
        });
        return evs;
      }
      function setScore(evs, gameIndex, home, away) {
        var out = evs.slice();
        out.push(E.makeEvent(out, 't', 'setScore',
          { gameIndex: gameIndex, home: home, away: away }));
        return out;
      }

      it('a finished match counts its points once, not twice', function () {
        var played = rallies(interleave(9, 21));
        var before = E.summarize('rally', to21, played);
        eq(before.secondary, { home: 9, away: 21 });
        // The last game is held in both the game list and the live score so
        // the board can keep showing it; a recount used to add both.
        var fixed = E.summarize('rally', to21, setScore(played, 0, 10, 21));
        eq(fixed.secondary, { home: 10, away: 21 }, 'not 19-42');
      });

      it('correcting the last game moves the board with it', function () {
        var s = E.summarize('rally', to21, setScore(rallies(interleave(9, 21)), 0, 10, 21));
        eq(s.current, { home: 10, away: 21 });
        eq(s.games[0], { home: 10, away: 21 });
        eq(s.line, '10-21');
        ok(s.complete); eq(s.winner, 'away');
      });

      it('a correction can hand the match to the other side', function () {
        var s = E.summarize('rally', to21, setScore(rallies(interleave(9, 21)), 0, 21, 9));
        eq(s.winner, 'home');
        eq(s.secondary, { home: 21, away: 9 });
      });

      it('a correction that un-finishes the game puts it back on court', function () {
        var s = E.summarize('rally', to21, setScore(rallies(interleave(9, 21)), 0, 15, 10));
        ok(!s.complete, '15-10 is nobody\u2019s game yet');
        eq(s.current, { home: 15, away: 10 });
        eq(s.games.length, 1, 'the one game, still being played');
        eq(s.games[0], { home: 15, away: 10 });
        eq(s.secondary, { home: 15, away: 10 }, 'and still counted once');
      });

      it('a golden point is not undone by a recount', function () {
        var evs = rallies(interleave(20, 20));
        evs.push(E.makeEvent(evs, 't', 'golden', {}));
        evs.push(E.makeEvent(evs, 't', 'rally', { side: 'home' }));
        var s = E.summarize('rally', to21, evs);
        ok(s.complete); eq(s.winner, 'home');
        eq(s.secondary, { home: 21, away: 20 }, 'counted once');
        // A correction elsewhere must not re-derive 21-20 as "nobody won".
        var later = evs.slice();
        later.push(E.makeEvent(later, 't', 'setScore',
          { gameIndex: 1, home: 0, away: 0 }));
        var s2 = E.summarize('rally', to21, later);
        ok(s2.complete, 'the golden point still stands');
        eq(s2.winner, 'home');
      });
    });

    /* ------------------------------------------- reading the store ----- */
    describe('Documents from the store are read-only', function () {
      function deepFreeze(o) {
        if (o && typeof o === 'object') {
          Object.getOwnPropertyNames(o).forEach(function (k) { deepFreeze(o[k]); });
          Object.freeze(o);
        }
        return o;
      }

      /* The shared store hands the same frozen object to every subscriber.
       * Writing to one throws, the snapshot callback dies with it, and the
       * app sits on "Loading..." for good - which is exactly what a
       * migration editing in place did. Local storage returns mutable
       * objects from JSON.parse, so only the shared link ever showed it. */
      it('migrating one does not write to it', function () {
        var doc = deepFreeze({
          id: 't1', name: 'KVO', schemaVersion: 1, sport: 'pickleball',
          config: { standings: { tiebreaks: ['headToHead', 'unitsDiff', 'unitsFor', 'won'] } },
          stages: [{ id: 's1', standings: { config: null, counts: [] } }]
        });
        var out = M.migrate(doc);
        ok(out !== doc, 'a copy comes back');
        eq(doc.schemaVersion, 1, 'the original is untouched');
        eq(doc.config.standings.tiebreaks.length, 4);
        eq(out.schemaVersion, M.SCHEMA_VERSION);
        eq(out.config.standings.tiebreaks, M.DEFAULT_TIEBREAKS);
      });

      it('a document already at this version is passed straight back', function () {
        var doc = deepFreeze({ id: 't2', schemaVersion: M.SCHEMA_VERSION });
        ok(M.migrate(doc) === doc, 'no copy, no work');
      });

      it('an older document is brought all the way forward', function () {
        var out = M.migrate(deepFreeze({ id: 't3' }));   // no schemaVersion at all
        eq(out.schemaVersion, M.SCHEMA_VERSION);
      });
    });

    /* --------------------------------------------------------- undo ----- */
    describe('Undo', function () {
      var cfg = { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false };

      it('an undo cancels the point without removing the record', function () {
        var events = [];
        ['home', 'home', 'away'].forEach(function (s) {
          events.push(E.makeEvent(events, 'c1', 'rally', { side: s }));
        });
        var before = E.summarize('rally', cfg, events);
        eq(before.current, { home: 2, away: 1 });

        var last = E.lastUndoableId(events);
        events.push(E.makeEvent(events, 'c1', 'undo', { targetEventId: last }));
        var after = E.summarize('rally', cfg, events);
        eq(after.current, { home: 2, away: 0 }, 'the away point is gone');
        eq(events.length, 4, 'nothing was removed from the log');
      });

      it('undoing an undo is redo', function () {
        var events = [];
        events.push(E.makeEvent(events, 'c1', 'rally', { side: 'home' }));
        var target = events[0].id;
        var u1 = E.makeEvent(events, 'c1', 'undo', { targetEventId: target });
        events.push(u1);
        eq(E.summarize('rally', cfg, events).current, { home: 0, away: 0 });
        events.push(E.makeEvent(events, 'c1', 'undo', { targetEventId: u1.id }));
        eq(E.summarize('rally', cfg, events).current, { home: 1, away: 0 });
      });

      it('two phones appending out of order still agree', function () {
        // Same events, shuffled: ordering is by (seq, clientId, id), so the
        // fold must produce the same score either way.
        var events = [];
        ['home', 'away', 'home'].forEach(function (s) {
          events.push(E.makeEvent(events, 'c1', 'rally', { side: s }));
        });
        var a = E.summarize('rally', cfg, events).current;
        var b = E.summarize('rally', cfg, events.slice().reverse()).current;
        eq(a, b);
      });
    });

    /* ------------------------------------------------------ round robin -- */
    describe('Round robin draw', function () {
      it('every pair meets exactly once with an even entry', function () {
        var ids = ['a', 'b', 'c', 'd', 'e', 'f'];
        var rounds = SCH.roundRobin(ids);
        eq(rounds.length, 5, 'rounds');
        var seen = {};
        rounds.forEach(function (r) {
          r.forEach(function (p) {
            var k = [p[0], p[1]].sort().join('|');
            ok(!seen[k], 'pair ' + k + ' met twice');
            seen[k] = true;
          });
        });
        eq(Object.keys(seen).length, 15, 'total matches');
      });

      it('an odd entry count gives each team exactly one bye', function () {
        var ids = ['a', 'b', 'c', 'd', 'e'];
        var rounds = SCH.roundRobin(ids);
        eq(rounds.length, 5);
        var byes = {};
        rounds.forEach(function (r) {
          r.forEach(function (p) {
            if (p[0] == null) byes[p[1]] = (byes[p[1]] || 0) + 1;
            if (p[1] == null) byes[p[0]] = (byes[p[0]] || 0) + 1;
          });
        });
        ids.forEach(function (id) { eq(byes[id], 1, id + ' byes'); });
      });

      it('no entrant appears twice in a round', function () {
        var ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
        SCH.roundRobin(ids).forEach(function (r, i) {
          var seen = {};
          r.forEach(function (p) {
            p.forEach(function (x) {
              if (x == null) return;
              ok(!seen[x], x + ' twice in round ' + (i + 1));
              seen[x] = true;
            });
          });
        });
      });

      /* "Six in a group but everyone only plays four." The circle method
       * already gives every team exactly one match per round, so the
       * first k rounds ARE a fair k-match schedule - no random draw, and
       * nobody plays twice while someone else sits out. */
      it('a set number of rounds gives every team that many matches', function () {
        var fs = SCH.roundRobinFixtures({
          entrantIds: ['a', 'b', 'c', 'd', 'e', 'f'], rounds: 4
        });
        eq(fs.length, 12, 'four rounds of three');
        var played = {};
        fs.forEach(function (f) {
          played[f.home.entrantId] = (played[f.home.entrantId] || 0) + 1;
          played[f.away.entrantId] = (played[f.away.entrantId] || 0) + 1;
        });
        ['a', 'b', 'c', 'd', 'e', 'f'].forEach(function (id) {
          eq(played[id], 4, id + ' plays four');
        });
      });

      it('nobody meets twice inside a part round robin', function () {
        var fs = SCH.roundRobinFixtures({
          entrantIds: ['a', 'b', 'c', 'd', 'e', 'f'], rounds: 3
        });
        var seen = {};
        fs.forEach(function (f) {
          var k = [f.home.entrantId, f.away.entrantId].sort().join('-');
          ok(!seen[k], k + ' only once');
          seen[k] = true;
        });
        eq(fs.length, 9);
      });

      it('asking for more rounds than exist just plays them all', function () {
        var fs = SCH.roundRobinFixtures({
          entrantIds: ['a', 'b', 'c', 'd'], rounds: 99
        });
        eq(fs.length, 6, 'the full round robin, no more');
      });

      /* Fourteen teams into 4, 4 and 6 - a split no even deal produces. */
      it('splits into the sizes asked for', function () {
        var ids = [];
        for (var i = 0; i < 14; i++) ids.push('t' + i);
        var gs = SCH.splitIntoSizes(ids, [4, 4, 6]);
        eq(gs.map(function (g) { return g.length; }), [4, 4, 6]);
        eq(gs[0][0], 't0');
        eq(gs[2][5], 't13', 'everybody landed somewhere');
      });

      it('anything a short list of sizes leaves over joins the last group', function () {
        var gs = SCH.splitIntoSizes(['a', 'b', 'c', 'd', 'e'], [2, 2]);
        eq(gs.map(function (g) { return g.length; }), [2, 3]);
      });

      it('two legs doubles the fixtures and swaps the sides', function () {
        var rounds = SCH.roundRobin(['a', 'b', 'c', 'd'], { legs: 2 });
        eq(rounds.length, 6);
        var all = [];
        rounds.forEach(function (r) { r.forEach(function (p) { all.push(p.join('>')); }); });
        eq(all.length, 12);
        ok(all.indexOf('a>b') !== -1 || all.indexOf('b>a') !== -1);
      });

      it('12 teams produce 66 matches over 11 rounds', function () {
        var ids = [];
        for (var i = 0; i < 12; i++) ids.push('t' + i);
        var rounds = SCH.roundRobin(ids);
        eq(rounds.length, 11);
        var n = 0;
        rounds.forEach(function (r) { n += r.length; });
        eq(n, 66);
      });
    });

    /* --------------------------------------------------------- brackets -- */
    describe('Knockout bracket', function () {
      it('seeds so that 1 and 2 can only meet in the final', function () {
        eq(SCH.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
        eq(SCH.seedOrder(4), [1, 4, 2, 3]);
      });

      it('16 entrants give 15 matches', function () {
        var refs = [];
        for (var i = 0; i < 16; i++) refs.push(M.Ref.entrant('p' + i));
        var fx = SCH.knockoutFixtures({ entrantRefs: refs, stageId: 's1' });
        eq(fx.length, 15);
        eq(fx[fx.length - 1].shortLabel, 'F');
      });

      it('a non-power-of-two draw gives the top seeds byes', function () {
        var refs = [];
        for (var i = 0; i < 6; i++) refs.push(M.Ref.entrant('p' + i));
        var fx = SCH.knockoutFixtures({ entrantRefs: refs, stageId: 's1' });
        var r1 = fx.filter(function (f) { return f.round === 1; });
        eq(r1.length, 4);
        var byes = r1.filter(function (f) { return f.status === M.STATUS.BYE; });
        eq(byes.length, 2, 'two byes for eight slots and six entrants');
      });

      it('a bracket can be laid out by hand', function () {
        var refs = ['a', 'b', 'c', 'd'].map(function (x) { return M.Ref.entrant(x); });
        var fx = SCH.knockoutFixtures({
          entrantRefs: refs, stageId: 's1',
          slots: [refs[0], refs[2], refs[1], refs[3]]      // a v c, b v d
        });
        var r1 = fx.filter(function (f) { return f.round === 1; });
        eq(r1.length, 2);
        eq([r1[0].home.entrantId, r1[0].away.entrantId], ['a', 'c']);
        eq([r1[1].home.entrantId, r1[1].away.entrantId], ['b', 'd']);
      });

      it('without a layout it still seeds the usual way', function () {
        var refs = ['a', 'b', 'c', 'd'].map(function (x) { return M.Ref.entrant(x); });
        eq(SCH.defaultSlots(refs).map(function (r) { return r.entrantId; }),
           ['a', 'd', 'b', 'c'], 'top seed meets the lowest');
      });

      it('later rounds reference the earlier matches, not teams', function () {
        var refs = [];
        for (var i = 0; i < 4; i++) refs.push(M.Ref.entrant('p' + i));
        var fx = SCH.knockoutFixtures({ entrantRefs: refs, stageId: 's1' });
        var fin = fx.filter(function (f) { return f.shortLabel === 'F'; })[0];
        eq(fin.home.kind, 'fixtureOutcome');
        eq(fin.home.outcome, 'winner');
      });
    });

    /* ------------------------------------------- rubbers across courts --- */
    describe('Rubbers on courts', function () {
      function tieRubbers() {
        var t = M.TIE_TEMPLATES.pickleball11();
        return t.rubbers.map(function (tr, i) {
          return M.makeRubber({ label: tr.label, order: i,
                                homeSlots: tr.homeSlots, awaySlots: tr.awaySlots });
        });
      }

      it('never puts one player on two courts at once', function () {
        var rubbers = tieRubbers();
        SCH.assignRubberSlots(rubbers, 3);
        eq(SCH.validateRubberSlots(rubbers), []);
      });

      it('respects the court count', function () {
        var rubbers = tieRubbers();
        SCH.assignRubberSlots(rubbers, 3);
        var perSlot = {};
        rubbers.forEach(function (r) { perSlot[r.slot] = (perSlot[r.slot] || 0) + 1; });
        Object.keys(perSlot).forEach(function (s) {
          ok(perSlot[s] <= 3, 'slot ' + s + ' has ' + perSlot[s] + ' matches on 3 courts');
        });
      });

      it('flags a hand-made clash', function () {
        var rubbers = tieRubbers();
        rubbers.forEach(function (r) { r.slot = 0; });
        ok(SCH.validateRubberSlots(rubbers).length > 0, 'all in one slot must clash');
      });
    });

    /* -------------------------------------------------------- standings -- */
    describe('Standings', function () {
      var cfg = { points: M.pointsRules(3, 1, 0),
                  tiebreaks: ['unitsDiff', 'unitsFor'], onPartition: 'restart' };

      it('orders by points, then difference', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b', 'c'],
          results: [
            result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 3, af: 0 }),
            result({ id: 'f2', home: 'b', away: 'c', outcome: 'home', hf: 1, af: 0 }),
            result({ id: 'f3', home: 'a', away: 'c', outcome: 'home', hf: 1, af: 0 })
          ],
          config: cfg
        });
        eq(r.table.map(function (x) { return x.entrantId; }), ['a', 'b', 'c']);
        eq(r.table[0].points, 6);
      });

      it('counts a draw for both sides', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b'],
          results: [result({ id: 'f1', home: 'a', away: 'b', outcome: 'draw', hf: 2, af: 2 })],
          config: cfg
        });
        eq(r.rows.a.points, 1);
        eq(r.rows.b.drawn, 1);
      });

      it('a points deduction applies', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b'],
          results: [result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0 })],
          config: cfg,
          adjustments: [{ entrantId: 'a', points: -3 }]
        });
        eq(r.rows.a.points, 0);
      });
    });

    /* ------------------------------------------- head to head, 3+ teams -- */
    describe('Head-to-head among three tied teams', function () {
      var cfg3 = { points: M.pointsRules(3, 1, 0),
                   tiebreaks: ['headToHead', 'unitsDiff', 'unitsFor'],
                   onPartition: 'restart' };

      /* A, B and C finish level on points with D bottom. The three-way
       * head-to-head is a MINI-LEAGUE over only the matches between them -
       * get that wrong and you get the overall table's answer instead, which
       * here is deliberately the opposite. */
      var rs = [
        result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0 }),
        result({ id: 'f2', home: 'b', away: 'c', outcome: 'home', hf: 1, af: 0 }),
        result({ id: 'f3', home: 'c', away: 'a', outcome: 'home', hf: 3, af: 0 }),
        result({ id: 'f4', home: 'a', away: 'd', outcome: 'home', hf: 9, af: 0 }),
        result({ id: 'f5', home: 'b', away: 'd', outcome: 'home', hf: 1, af: 0 }),
        result({ id: 'f6', home: 'c', away: 'd', outcome: 'home', hf: 1, af: 0 })
      ];

      it('ranks the tied teams on their mini-league, not the overall table', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b', 'c', 'd'], results: rs, config: cfg3
        });
        // Overall difference would say A (+7), C (+3), B (+1).
        // The mini-league says C (+2), B (0), A (-2), and it wins.
        eq(r.table.map(function (x) { return x.entrantId; }), ['c', 'b', 'a', 'd']);
      });

      /* Matches won first, then games difference, then points difference,
       * then points scored. Every step is needed: these four teams are
       * level on everything above the step that finally splits them. */
      it('ranks on games, then point difference, then points scored', function () {
        var cfg = { points: M.pointsRules(2, 1, 0),
                    tiebreaks: M.DEFAULT_TIEBREAKS, onPartition: 'restart' };
        // a and b: one win each. a took its match 6-5, b took its 6-4,
        // so b is ahead on games difference.
        // c and d: one win each, both 6-5, so they go to point difference.
        var rs = [
          result({ id: 'f1', home: 'a', away: 'x', outcome: 'home', hf: 6, af: 5, hs: 200, as: 190 }),
          result({ id: 'f2', home: 'b', away: 'y', outcome: 'home', hf: 6, af: 4, hs: 200, as: 190 }),
          result({ id: 'f3', home: 'c', away: 'z', outcome: 'home', hf: 6, af: 5, hs: 210, as: 150 }),
          result({ id: 'f4', home: 'd', away: 'w', outcome: 'home', hf: 6, af: 5, hs: 205, as: 190 })
        ];
        var out = S.computeStandings({
          entrantIds: ['a', 'b', 'c', 'd'], results: rs, config: cfg
        });
        // b +2 on games; then c (+60), d (+15), a (+10) on point difference
        eq(out.table.map(function (r) { return r.entrantId; }), ['b', 'c', 'd', 'a']);
        eq(out.unresolved.length, 0);
      });

      it('points scored is the last word when the differences are equal', function () {
        var cfg = { points: M.pointsRules(2, 1, 0),
                    tiebreaks: M.DEFAULT_TIEBREAKS, onPartition: 'restart' };
        var rs = [
          result({ id: 'f1', home: 'a', away: 'x', outcome: 'home', hf: 6, af: 5, hs: 200, as: 180 }),
          result({ id: 'f2', home: 'b', away: 'y', outcome: 'home', hf: 6, af: 5, hs: 150, as: 130 })
        ];
        var out = S.computeStandings({
          entrantIds: ['a', 'b'], results: rs, config: cfg
        });
        // same points, same games diff, same +20 point diff - a scored more
        eq(out.table.map(function (r) { return r.entrantId; }), ['a', 'b']);
      });

      it('head-to-head is not in the default chain', function () {
        var has = false;
        M.DEFAULT_TIEBREAKS.forEach(function (c) { if (c === 'headToHead') has = true; });
        ok(!has, 'the organiser asked for differences, not who beat whom');
      });

      /* In a one-set tournament the unit IS the match: winning takes the
       * only set, so unitsDiff and unitsFor are the win count written
       * again. Three teams level on points with a head-to-head cycle were
       * being called level on everything while their point differences
       * were fifteen apart, which is why pointDiff is in the default
       * chain. */
      it('point difference separates teams a one-set table cannot', function () {
        var oneSet = { points: M.pointsRules(2, 1, 0),
                       tiebreaks: M.DEFAULT_TIEBREAKS,
                       onPartition: 'restart' };
        // A beat B, B beat C, C beat A - a perfect cycle, every side 1-1
        // in sets. Only the points scored tell them apart.
        var cyc = [
          result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0, hs: 21, as: 15 }),
          result({ id: 'f2', home: 'b', away: 'c', outcome: 'home', hf: 1, af: 0, hs: 21, as: 5 }),
          result({ id: 'f3', home: 'c', away: 'a', outcome: 'home', hf: 1, af: 0, hs: 21, as: 19 })
        ];
        var r = S.computeStandings({
          entrantIds: ['a', 'b', 'c'], results: cyc, config: oneSet
        });
        // a: 40-36 (+4), b: 36-26 (+10), c: 26-40 (-14)
        eq(r.table.map(function (x) { return x.entrantId; }), ['b', 'a', 'c']);
        eq(r.unresolved.length, 0, 'nothing is left level');
      });

      it('falls through when the mini-league cannot separate them', function () {
        // Each beat the next 1-0 in a perfect circle, so the mini-league is
        // dead level; the margins against D then decide.
        var level = [
          result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0 }),
          result({ id: 'f2', home: 'b', away: 'c', outcome: 'home', hf: 1, af: 0 }),
          result({ id: 'f3', home: 'c', away: 'a', outcome: 'home', hf: 1, af: 0 }),
          result({ id: 'f4', home: 'a', away: 'd', outcome: 'home', hf: 5, af: 0 }),
          result({ id: 'f5', home: 'b', away: 'd', outcome: 'home', hf: 3, af: 0 }),
          result({ id: 'f6', home: 'c', away: 'd', outcome: 'home', hf: 1, af: 0 })
        ];
        var r = S.computeStandings({
          entrantIds: ['a', 'b', 'c', 'd'], results: level, config: cfg3
        });
        eq(r.table.map(function (x) { return x.entrantId; }), ['a', 'b', 'c', 'd']);
      });

      it('an unbalanced mini-league is skipped, not guessed at', function () {
        // a and b have met twice, the other pairs once: meaningless.
        var unbalanced = rs.concat([
          result({ id: 'f7', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0 })
        ]);
        ok(!S.isBalanced(['a', 'b', 'c'], unbalanced),
           'should be reported unbalanced');
      });

      it('a balanced set is recognised', function () {
        ok(S.isBalanced(['a', 'b', 'c'], rs));
      });

      it('both partition modes still produce a complete order', function () {
        ['restart', 'continue'].forEach(function (mode) {
          var r = S.computeStandings({
            entrantIds: ['a', 'b', 'c', 'd'], results: rs,
            config: { points: M.pointsRules(3, 1, 0),
                      tiebreaks: ['headToHead', 'unitsDiff', 'unitsFor'],
                      onPartition: mode }
          });
          eq(r.table.length, 4, mode + ' table size');
        });
      });

      it('teams nothing can separate share a rank', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b'],
          results: [
            result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0 }),
            result({ id: 'f2', home: 'b', away: 'a', outcome: 'home', hf: 1, af: 0 })
          ],
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['headToHead', 'unitsDiff'],
                    onPartition: 'restart' }
        });
        eq(r.unresolved.length, 1, 'one unresolved block');
        ok(r.table[0].sharedRank && r.table[1].sharedRank, 'both marked as shared');
      });

      it('a stored coin toss settles it deterministically', function () {
        var opts = {
          entrantIds: ['a', 'b'],
          results: [
            result({ id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 1, af: 0 }),
            result({ id: 'f2', home: 'b', away: 'a', outcome: 'home', hf: 1, af: 0 })
          ],
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['unitsDiff'],
                    onPartition: 'restart' },
          adjudications: { 'a|b': ['b', 'a'] }
        };
        var r = S.computeStandings(opts);
        eq(r.table.map(function (x) { return x.entrantId; }), ['b', 'a']);
        eq(r.unresolved.length, 0);
      });
    });

    /* ------------------------------------------------------ net run rate -- */
    describe('Net run rate', function () {
      it('is runs per over scored minus conceded', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b'],
          results: [result({
            id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 160, af: 150,
            metrics: { home: { runs: 160, overs: 20 }, away: { runs: 150, overs: 20 } }
          })],
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['netRunRate'] }
        });
        close(r.rows.a.nrr, 0.5, 1e-9, 'a NRR');
        close(r.rows.b.nrr, -0.5, 1e-9, 'b NRR');
      });

      it('a side bowled out counts its FULL quota of overs', function () {
        // All out for 100 in 15 overs of a 20-over game: the rate uses 20.
        eq(S.effectiveOvers({ runs: 100, overs: 15, allOut: true, quotaOvers: 20 }), 20);
        eq(S.effectiveOvers({ runs: 100, overs: 15, allOut: false, quotaOvers: 20 }), 15);
      });

      it('the all-out rule changes the table', function () {
        var r = S.computeStandings({
          entrantIds: ['a', 'b'],
          results: [result({
            id: 'f1', home: 'a', away: 'b', outcome: 'home', hf: 160, af: 100,
            metrics: { home: { runs: 160, overs: 20 },
                       away: { runs: 100, overs: 15, allOut: true, quotaOvers: 20 } }
          })],
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['netRunRate'] }
        });
        close(r.rows.a.nrr, 160 / 20 - 100 / 20, 1e-9);
      });
    });

    /* ----------------------------------------------------- carry-over ---- */
    describe('Super 6 carry-over', function () {
      var stage1 = { id: 'g', groups: [] };
      var stage2 = {
        id: 's6',
        standings: { counts: [
          { stageId: 'g', filter: 'bothEntrantsInThisStage', weight: 1 },
          { stageId: 'self', filter: 'all', weight: 1 }
        ] }
      };
      // In the groups: a beat b, a beat x (x did not qualify), b beat x.
      var all = [
        result({ id: 'g1', stage: 'g', home: 'a', away: 'b', outcome: 'home', hf: 2, af: 0 }),
        result({ id: 'g2', stage: 'g', home: 'a', away: 'x', outcome: 'home', hf: 2, af: 0 }),
        result({ id: 'g3', stage: 'g', home: 'b', away: 'x', outcome: 'home', hf: 2, af: 0 }),
        result({ id: 's1', stage: 's6', home: 'b', away: 'a', outcome: 'home', hf: 1, af: 0 })
      ];

      it('carries only the matches between teams that both qualified', function () {
        var counted = S.countingResults(stage2, all, ['a', 'b']);
        eq(counted.map(function (r) { return r.fixtureId; }).sort(), ['g1', 's1']);
      });

      it('head-to-head sees the carried group match, because it is really there', function () {
        var counted = S.countingResults(stage2, all, ['a', 'b']);
        ok(S.isBalanced(['a', 'b'], counted), 'both meetings are in the set');
        var r = S.computeStandings({
          entrantIds: ['a', 'b'], results: counted,
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['unitsDiff'] }
        });
        eq(r.rows.a.played, 2, 'a played the carried group match and the super-six one');
        eq(r.rows.a.points, 2);
        eq(r.rows.b.points, 2);
      });

      it('a half-weight carry halves the points but not the difference', function () {
        var half = {
          id: 's6b',
          standings: { counts: [
            { stageId: 'g', filter: 'bothEntrantsInThisStage', weight: 0.5 },
            { stageId: 'self', filter: 'all', weight: 1 }
          ] }
        };
        var counted = S.countingResults(half, all, ['a', 'b']);
        var r = S.computeStandings({
          entrantIds: ['a', 'b'], results: counted,
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['unitsDiff'] }
        });
        eq(r.rows.a.points, 1, 'a won only the carried match, at half weight');
        eq(r.rows.a.unitsFor, 2, 'difference is not weighted');
      });

      it('a correction in the group stage flows through on its own', function () {
        var fixed = all.map(function (r) {
          return r.fixtureId === 'g1'
            ? result({ id: 'g1', stage: 'g', home: 'a', away: 'b', outcome: 'away', hf: 0, af: 2 })
            : r;
        });
        var counted = S.countingResults(stage2, fixed, ['a', 'b']);
        var r = S.computeStandings({
          entrantIds: ['a', 'b'], results: counted,
          config: { points: M.pointsRules(2, 1, 0), tiebreaks: ['unitsDiff'] }
        });
        eq(r.rows.b.points, 4, 'b now has both wins, with nothing re-entered');
      });
    });

    /* ------------------------------------------------------ tie results -- */
    describe('Ties made of rubbers', function () {
      var tmpl = M.TIE_TEMPLATES.pickleball11();

      it('the tie goes to whoever won more rubbers', function () {
        var sums = {};
        tmpl.rubbers.forEach(function (tr, i) {
          sums['r' + i] = { winner: i < 6 ? 'home' : 'away',
                            secondary: { home: 21, away: 15 } };
        });
        var r = S.tieResult({
          fixture: { id: 'f1', stageId: 's1', groupId: 'g1', status: 'completed' },
          template: tmpl, summaries: sums, homeId: 'a', awayId: 'b'
        });
        eq(r.units, { home: 6, away: 5 });
        eq(r.outcome, 'home');
      });

      it('a dead rubber does not count', function () {
        var sums = { r0: { winner: 'home', secondary: { home: 21, away: 0 } },
                     r1: { status: M.STATUS.NOT_PLAYED } };
        var r = S.tieResult({
          fixture: { id: 'f1', status: 'completed' },
          template: tmpl, summaries: sums, homeId: 'a', awayId: 'b'
        });
        eq(r.units, { home: 1, away: 0 });
        eq(r.rubbersPlayed, 1);
      });

      it('points scored across rubbers become the secondary measure', function () {
        var sums = { r0: { winner: 'home', secondary: { home: 21, away: 18 } },
                     r1: { winner: 'away', secondary: { home: 15, away: 21 } } };
        var r = S.tieResult({
          fixture: { id: 'f1', status: 'completed' },
          template: tmpl, summaries: sums, homeId: 'a', awayId: 'b'
        });
        eq(r.subUnits, { home: 36, away: 39 });
        // One rubber each, but this template does not allow a drawn tie, so
        // its own tiebreak (points scored) settles it.
        eq(r.outcome, 'away');
      });

      it('a meeting counts its OWN matches, not the tournament default', function () {
        // Matches can be added to or removed from one meeting, so the
        // default is only a starting point.
        var sums = { r0: { winner: 'home', primary: { home: 3, away: 1 },
                           secondary: { home: 3, away: 1 } } };
        var asSingle = S.tieResult({
          fixture: { id: 'f1', status: 'completed', matchCount: 1 },
          template: tmpl, summaries: sums, homeId: 'a', awayId: 'b'
        });
        eq(asSingle.units, { home: 3, away: 1 }, 'one match: the score itself');

        var asTie = S.tieResult({
          fixture: { id: 'f2', status: 'completed', matchCount: 4 },
          template: M.TIE_TEMPLATES.single(), summaries: sums,
          homeId: 'a', awayId: 'b'
        });
        eq(asTie.units, { home: 1, away: 0 }, 'several matches: matches won');
      });

      it('the match type decides how many names are wanted', function () {
        eq(M.playersNeeded('singles'), 1);
        eq(M.playersNeeded('doubles'), 2);
        eq(M.playersNeeded('mixed'), 2);
        eq(M.playersNeeded('team'), 0, 'a whole-team match names nobody');
        eq(M.playersNeeded('nonsense'), 0);
        eq(M.kindLabel('mixed'), 'Mixed doubles');
      });

      it('a one-rubber tie passes the engine result straight through', function () {
        var single = M.TIE_TEMPLATES.single();
        var sums = {};
        sums[single.rubbers[0].id] = {
          winner: 'away', primary: { home: 1, away: 3 }, secondary: { home: 1, away: 3 }
        };
        var r = S.tieResult({
          fixture: { id: 'f1', status: 'completed' },
          template: single, summaries: sums, homeId: 'a', awayId: 'b'
        });
        eq(r.units, { home: 1, away: 3 }, 'goals, not rubbers');
        eq(r.outcome, 'away');
      });
    });

    /* "Three sets in the singles, one in the doubles" is an ordinary
     * thing to want, and the chain that allows it REPLACES rather than
     * merges - so an override has to carry the whole config or the rest
     * of the rules silently revert to their defaults. */
    describe('A game with its own target', function () {
      function world() {
        var t = M.makeTournament({ name: 'T', sport: 'pickleball' });
        t.config.scoring = { pointsToWin: 21, bestOf: 1, winBy: 2, cap: null,
                             sideOut: false };
        return t;
      }

      it('a game with nothing of its own follows the tournament', function () {
        var t = world();
        eq(M.resolveScoring(t, null, { id: 'tr1', label: 'AA' },
                            { id: 'r1', templateRubberId: 'tr1' }).pointsToWin, 21);
      });

      it('a game given its own target uses it', function () {
        var t = world();
        var tr = { id: 'tr1', label: 'CC',
                   scoringOverride: { pointsToWin: 15, bestOf: 3, winBy: 2,
                                      cap: null, sideOut: false } };
        var sc = M.resolveScoring(t, null, tr, { id: 'r1', templateRubberId: 'tr1' });
        eq(sc.pointsToWin, 15);
        eq(sc.bestOf, 3);
        eq(sc.winBy, 2, 'the rest of the rules came along with it');
      });

      /* One game played to 30 that evening must not redefine the format. */
      it('the game itself still beats its template entry', function () {
        var t = world();
        var tr = { id: 'tr1', scoringOverride: { pointsToWin: 15, bestOf: 1 } };
        var r = { id: 'r1', templateRubberId: 'tr1',
                  scoringOverride: { pointsToWin: 30, bestOf: 1 } };
        eq(M.resolveScoring(t, null, tr, r).pointsToWin, 30);
      });

      it('a stage target sits between the tournament and the game', function () {
        var t = world();
        var stage = { id: 's1', scoring: { pointsToWin: 11, bestOf: 1 } };
        eq(M.resolveScoring(t, stage, null, { id: 'r1' }).pointsToWin, 11,
           'the final is played to 11');
        eq(M.resolveScoring(t, stage, { id: 'tr1',
             scoringOverride: { pointsToWin: 15 } }, { id: 'r1' }).pointsToWin, 15,
           'but one game in it to 15');
      });
    });

    /* ---------------------------------------------------------- line-up -- */
    /* The question a graded format gets asked more than any other: X is
     * not here today, put Y in. It has to change THIS match and nothing
     * else - not the squad, not the same two teams next week. */
    describe('Who is playing one match', function () {
      function squad(ids) {
        return { id: 'e1', name: 'A', members: ids.map(function (p, i) {
          return { playerId: p, slot: ['A1', 'A2', 'B1', 'B2'][i] };
        }) };
      }

      it('with nothing changed, the squad IS the line-up', function () {
        eq(SCH.lineupOf(squad(['p1', 'p2', 'p3', 'p4']), { lineup: {} }, 'home'),
           { A1: 'p1', A2: 'p2', B1: 'p3', B2: 'p4' });
      });

      it('a stand-in replaces one category and leaves the rest', function () {
        eq(SCH.lineupOf(squad(['p1', 'p2', 'p3', 'p4']),
                        { lineup: { home: { B1: 'p9' } } }, 'home'),
           { A1: 'p1', A2: 'p2', B1: 'p9', B2: 'p4' });
      });

      /* "A2 is not playing today" has to stick. Falling back to the squad
       * for an emptied category would put the dropped player straight
       * back on court. */
      it('a category emptied on purpose stays empty', function () {
        var l = SCH.lineupOf(squad(['p1', 'p2', 'p3', 'p4']),
                             { lineup: { home: { A2: null } } }, 'home');
        eq(l.A2, null);
        eq(l.A1, 'p1', 'the rest is untouched');
      });

      it('one side changing does not move the other', function () {
        var l = SCH.lineupOf(squad(['p1', 'p2', 'p3', 'p4']),
                             { lineup: { home: { A1: 'p9' } } }, 'away');
        eq(l.A1, 'p1');
      });

      it('the stand-in is who appears in the game', function () {
        var rs = SCH.rubbersForFixture({
          tournamentId: 't1',
          fixture: { id: 'f1', lineup: { home: { A2: 'p9' } } },
          template: { rubbers: [{ id: 'tr1', label: 'AA', kind: 'doubles',
                                  homeSlots: ['A1', 'A2'],
                                  awaySlots: ['A1', 'A2'] }] },
          homeEntrant: squad(['p1', 'p2', 'p3', 'p4']),
          awayEntrant: { id: 'e2', name: 'B', members: [
            { playerId: 'q1', slot: 'A1' }, { playerId: 'q2', slot: 'A2' }] }
        });
        eq(rs[0].homePlayers, ['p1', 'p9'], 'p9 came in for p2');
        eq(rs[0].awayPlayers, ['q1', 'q2'], 'the other team is as it was');
      });
    });

    /* Names get written down as a match starts, which is the only moment
     * anyone knows them. Doing that must not quietly enter the same
     * person twice, or the leaderboard stops adding up. */
    describe('Adding a name at the match', function () {
      function world() {
        return {
          players: [{ id: 'p1', name: 'Jinay' }, { id: 'p2', name: 'Amit' }],
          entrants: [
            { id: 'e1', name: 'A', members: [{ playerId: 'p1', slot: 'A1' }] },
            { id: 'e2', name: 'B', members: [{ playerId: 'p2', slot: 'A1' }] }
          ]
        };
      }

      it('a name already in the squad is reused, however it is typed', function () {
        var t = world();
        eq(M.findOrAddPlayer(t, t.entrants[0], 'jinay', 'A1'),
           { id: 'p1', created: false });
        eq(t.players.length, 2, 'nobody was added');
      });

      it('a new name joins that team under the category it was typed against', function () {
        var t = world();
        ok(M.findOrAddPlayer(t, t.entrants[0], 'Meet', 'B2').created);
        eq(t.players.length, 3);
        eq(t.entrants[0].members.length, 2);
        eq(t.entrants[0].members[1].slot, 'B2');
        eq(t.entrants[1].members.length, 1, 'the other team is untouched');
      });

      /* The sheet promises it changes one match. Giving a stand-in the
       * category outright would change every match the squad plays. */
      it('a stand-in does not take a category somebody already holds', function () {
        var t = world();
        M.findOrAddPlayer(t, t.entrants[0], 'Meet', 'A1');
        eq(t.entrants[0].members[1].slot, null, 'in the squad, but not as A1');
        eq(t.entrants[0].members[0], { playerId: 'p1', slot: 'A1' },
           'Jinay is still A1');
      });

      /* Both sides may field a Jinay, and they are two different people. */
      it('the same name on another team is another player', function () {
        var t = world();
        ok(M.findOrAddPlayer(t, t.entrants[1], 'Jinay', 'C1').created,
           'not the first team\'s Jinay');
        eq(t.players.length, 3);
      });
    });

    /* ------------------------------------------------------ progression -- */
    describe('Progression', function () {
      function world(opts) {
        var t = M.makeTournament({ name: 'T', sport: 'pickleball' });
        t.id = 't1';
        var g = { id: 'gA', name: 'Group A', entrantRefs:
          ['a', 'b', 'c'].map(function (id) { return M.Ref.entrant(id); }) };
        var s1 = M.makeStage({ id: 'st1', name: 'Groups', type: 'roundrobin', groups: [g] });
        var s2 = M.makeStage({ id: 'st2', name: 'Final', type: 'knockout', groups: [] });
        t.stages = [s1, s2];
        var fixtures = [
          M.makeFixture({ id: 'f1', stageId: 'st1', groupId: 'gA',
                          home: M.Ref.entrant('a'), away: M.Ref.entrant('b'),
                          status: opts.allDone ? 'completed' : 'scheduled' }),
          M.makeFixture({ id: 'f2', stageId: 'st1', groupId: 'gA',
                          home: M.Ref.entrant('b'), away: M.Ref.entrant('c'),
                          status: opts.allDone ? 'completed' : 'scheduled' }),
          M.makeFixture({ id: 'f3', stageId: 'st1', groupId: 'gA',
                          home: M.Ref.entrant('a'), away: M.Ref.entrant('c'),
                          status: opts.allDone ? 'completed' : 'scheduled' }),
          M.makeFixture({ id: 'fin', stageId: 'st2',
                          home: M.Ref.groupPosition('st1', 'gA', 1),
                          away: M.Ref.groupPosition('st1', 'gA', 2) })
        ];
        var results = opts.allDone ? [
          result({ id: 'f1', stage: 'st1', group: 'gA', home: 'a', away: 'b', outcome: 'home', hf: 2, af: 0 }),
          result({ id: 'f2', stage: 'st1', group: 'gA', home: 'b', away: 'c', outcome: 'home', hf: 2, af: 0 }),
          result({ id: 'f3', stage: 'st1', group: 'gA', home: 'a', away: 'c', outcome: 'home', hf: 2, af: 1 })
        ] : [];
        return {
          tournament: t,
          entrants: ['a', 'b', 'c'].map(function (id) {
            return M.makeEntrant({ id: id, name: id.toUpperCase() });
          }),
          fixtures: fixtures, results: results, adjudications: opts.adjudications || {}
        };
      }

      it('the final exists before the group is played, with placeholders', function () {
        var out = P.resolveTournament(world({ allDone: false }));
        eq(out.sides.fin.home, null);
        ok(out.pending.length > 0, 'the unresolved side is reported');
      });

      it('a half-played group does not resolve', function () {
        var w = world({ allDone: false });
        w.fixtures[0].status = 'completed';
        var out = P.resolveTournament(w);
        eq(out.sides.fin.home, null);
      });

      it('once the group is finished the final fills in', function () {
        var out = P.resolveTournament(world({ allDone: true }));
        eq(out.sides.fin.home, 'a', 'winner of the group');
        eq(out.sides.fin.away, 'b', 'runner-up');
        eq(out.pending.length, 0);
      });

      it('a placeholder reads as words, not an id', function () {
        var w = world({ allDone: false });
        eq(M.refLabel(w.fixtures[3].home, w.tournament), 'Winner Group A');
        eq(M.refLabel(w.fixtures[3].away, w.tournament), 'Runner-up Group A');
      });

      it('an unbreakable tie across the qualification line refuses to resolve', function () {
        var w = world({ allDone: true });
        // Make a and b identical in every respect.
        w.results = [
          result({ id: 'f1', stage: 'st1', group: 'gA', home: 'a', away: 'b', outcome: 'draw', hf: 1, af: 1 }),
          result({ id: 'f2', stage: 'st1', group: 'gA', home: 'b', away: 'c', outcome: 'home', hf: 2, af: 0 }),
          result({ id: 'f3', stage: 'st1', group: 'gA', home: 'a', away: 'c', outcome: 'home', hf: 2, af: 0 })
        ];
        var out = P.resolveTournament(w);
        var tbl = out.tables.st1.gA;
        ok(tbl.table[0].sharedRank, 'a and b are level on everything');
        ok(out.pending.some(function (p) { return /level/.test(p.reason || ''); }),
           'and the final asks for a coin toss instead of guessing');
      });

      it('a stored coin toss then lets it through', function () {
        var w = world({ allDone: true });
        w.results = [
          result({ id: 'f1', stage: 'st1', group: 'gA', home: 'a', away: 'b', outcome: 'draw', hf: 1, af: 1 }),
          result({ id: 'f2', stage: 'st1', group: 'gA', home: 'b', away: 'c', outcome: 'home', hf: 2, af: 0 }),
          result({ id: 'f3', stage: 'st1', group: 'gA', home: 'a', away: 'c', outcome: 'home', hf: 2, af: 0 })
        ];
        w.adjudications = { 'a|b': ['b', 'a'] };
        var out = P.resolveTournament(w);
        eq(out.sides.fin.home, 'b');
        eq(out.sides.fin.away, 'a');
      });

      /* The teams that actually took the court are written onto the
       * fixture the first time it is scored, and nothing afterwards may
       * change them. The case that bit: adding one more group match
       * un-finishes the group, so "winner of Group A" stops resolving -
       * and a final already played went back to reading a placeholder
       * while keeping its score. */
      it('a played fixture keeps its teams when the group re-opens', function () {
        var w = world({ allDone: true });
        var fin = w.fixtures[3];
        fin.status = 'completed';
        fin.resolved = { home: 'a', away: 'b' };

        // someone adds another group match, so nobody has won the group now
        w.fixtures.push(M.makeFixture({ id: 'f4', stageId: 'st1', groupId: 'gA',
          home: M.Ref.entrant('a'), away: M.Ref.entrant('b'), status: 'scheduled' }));

        var out = P.resolveTournament(w);
        eq(out.sides.fin.home, 'a', 'the team that played stays');
        eq(out.sides.fin.away, 'b');
        eq(out.conflicts.length, 0, 'nothing resolved differently, so nothing to report');
      });

      it('a played fixture that now resolves to someone else reports a conflict', function () {
        var w = world({ allDone: true });
        var fin = w.fixtures[3];
        fin.status = 'completed';
        fin.resolved = { home: 'c', away: 'b' };   // c played, but a won the group

        var out = P.resolveTournament(w);
        eq(out.sides.fin.home, 'c', 'who played still wins');
        eq(out.conflicts.length, 1);
        eq(out.conflicts[0].was, 'c');
        eq(out.conflicts[0].now, 'a');
      });

      it('an unplayed fixture follows the group wherever it goes', function () {
        var w = world({ allDone: true });
        w.fixtures.push(M.makeFixture({ id: 'f4', stageId: 'st1', groupId: 'gA',
          home: M.Ref.entrant('a'), away: M.Ref.entrant('b'), status: 'scheduled' }));
        var out = P.resolveTournament(w);
        eq(out.sides.fin.home, null, 'back to a placeholder, as it should be');
      });

      it('a bye walks the present side into the next round', function () {
        var t = M.makeTournament({});
        t.id = 't2';
        var st = M.makeStage({ id: 'k1', type: 'knockout' });
        t.stages = [st];
        var refs = [M.Ref.entrant('a'), M.Ref.entrant('b'), M.Ref.entrant('c')];
        var fx = SCH.knockoutFixtures({ entrantRefs: refs, stageId: 'k1' });
        var out = P.resolveTournament({
          tournament: t, entrants: [], fixtures: fx, results: []
        });
        var fin = fx.filter(function (f) { return f.shortLabel === 'F'; })[0];
        var byeMatch = fx.filter(function (f) { return f.status === M.STATUS.BYE; })[0];
        ok(byeMatch, 'a four-slot bracket with three entrants has a bye');
        var side = out.sides[fin.id].home || out.sides[fin.id].away;
        ok(side, 'the team with the bye is already in the final');
      });
    });

    /* ---------------------------------------------------------- cricket -- */
    describe('Cricket', function () {
      var T20 = { overs: 2, ballsPerOver: 6, wickets: 2, innings: 2 };

      function play(cfg, balls, first) {
        var events = [];
        events.push(E.makeEvent(events, 'test', 'start',
          { battingFirst: first || 'home' }));
        (balls || []).forEach(function (b) {
          events.push(E.makeEvent(events, 'test', 'ball', b));
        });
        return E.summarize('cricket', cfg, events);
      }
      function dots(n, payload) {
        var out = [];
        for (var i = 0; i < n; i++) out.push(payload || { runs: 0 });
        return out;
      }

      it('a wide is a run and does not use up a ball', function () {
        var s = play(T20, [{ runs: 0, extra: 'wd' }]);
        eq(s.innings[0].runs, 1);
        eq(s.innings[0].overs, '0.0');
      });

      it('a no ball is a run plus whatever is hit off it', function () {
        var s = play(T20, [{ runs: 4, extra: 'nb' }]);
        eq(s.innings[0].runs, 5);
        eq(s.innings[0].overs, '0.0', 'still not a legal delivery');
      });

      it('byes count as a ball but not to the batter', function () {
        var cfg = { overs: 2, ballsPerOver: 6, wickets: 2, innings: 2, trackPlayers: true };
        var events = [];
        events.push(E.makeEvent(events, 't', 'start', { battingFirst: 'home' }));
        events.push(E.makeEvent(events, 't', 'setPlayers', { striker: 'p1', nonStriker: 'p2' }));
        events.push(E.makeEvent(events, 't', 'ball', { runs: 2, extra: 'b' }));
        var s = E.summarize('cricket', cfg, events);
        eq(s.innings[0].runs, 2);
        eq(s.innings[0].overs, '0.1');
        eq(s.innings[0].batters.p1.runs, 0, 'byes are not the batter’s runs');
        eq(s.innings[0].batters.p1.balls, 1);
      });

      it('the over counts only legal deliveries', function () {
        var s = play(T20, [{ runs: 0, extra: 'wd' }, { runs: 0 }, { runs: 0 },
                           { runs: 0, extra: 'nb' }, { runs: 0 }]);
        eq(s.innings[0].overs, '0.3');
      });

      it('all out closes the innings and the next one starts', function () {
        var s = play(T20, [{ runs: 0, wicket: { type: 'bowled' } },
                           { runs: 0, wicket: { type: 'lbw' } }]);
        eq(s.innings.length, 2);
        eq(s.innings[0].allOut, true);
        eq(s.innings[1].battingSide, 'away');
      });

      it('the overs limit closes the innings', function () {
        var cfg = { overs: 1, ballsPerOver: 6, wickets: 10, innings: 2 };
        var s = play(cfg, dots(6, { runs: 1 }));
        eq(s.innings[0].runs, 6);
        eq(s.innings.length, 2, 'second innings opened');
        eq(s.target, 7, 'chasing one more than they made');
      });

      it('the chase ends the moment the target is passed', function () {
        var cfg = { overs: 1, ballsPerOver: 6, wickets: 10, innings: 2 };
        var balls = dots(6, { runs: 1 }).concat([{ runs: 6 }, { runs: 6 }]);
        var s = play(cfg, balls);
        ok(s.complete, 'match is over');
        eq(s.winner, 'away');
        eq(s.innings[1].runs, 12);
      });

      it('reports the margin the way cricket does', function () {
        var cfg = { overs: 1, ballsPerOver: 6, wickets: 10, innings: 2 };
        var chase = play(cfg, dots(6, { runs: 1 }).concat([{ runs: 6 }, { runs: 6 }]));
        eq(chase.resultText, 'Won by 10 wickets');

        var defend = play({ overs: 1, ballsPerOver: 6, wickets: 2, innings: 2 },
          dots(6, { runs: 2 }).concat([{ runs: 0, wicket: { type: 'bowled' } },
                                       { runs: 0, wicket: { type: 'bowled' } }]));
        eq(defend.winner, 'home');
        eq(defend.resultText, 'Won by 12 runs');
      });

      it('hands the strike over on an odd number of runs', function () {
        var cfg = { overs: 2, ballsPerOver: 6, wickets: 10, innings: 2, trackPlayers: true };
        var events = [];
        events.push(E.makeEvent(events, 't', 'start', { battingFirst: 'home' }));
        events.push(E.makeEvent(events, 't', 'setPlayers', { striker: 'p1', nonStriker: 'p2' }));
        events.push(E.makeEvent(events, 't', 'ball', { runs: 1 }));
        eq(E.summarize('cricket', cfg, events).innings[0].striker, 'p2');
        events.push(E.makeEvent(events, 't', 'ball', { runs: 2 }));
        eq(E.summarize('cricket', cfg, events).innings[0].striker, 'p2', 'two runs keeps strike');
      });

      it('hands the strike over at the end of an over', function () {
        var cfg = { overs: 2, ballsPerOver: 6, wickets: 10, innings: 2, trackPlayers: true };
        var events = [];
        events.push(E.makeEvent(events, 't', 'start', { battingFirst: 'home' }));
        events.push(E.makeEvent(events, 't', 'setPlayers', { striker: 'p1', nonStriker: 'p2' }));
        for (var i = 0; i < 6; i++) {
          events.push(E.makeEvent(events, 't', 'ball', { runs: 0 }));
        }
        eq(E.summarize('cricket', cfg, events).innings[0].striker, 'p2');
      });

      it('exposes what net run rate needs, including the all-out rule', function () {
        var s = play({ overs: 5, ballsPerOver: 6, wickets: 2, innings: 2 },
          [{ runs: 4 }, { runs: 0, wicket: { type: 'bowled' } },
           { runs: 0, wicket: { type: 'bowled' } }]);
        var m = s.metrics.home;
        eq(m.runs, 4);
        eq(m.allOut, true);
        eq(m.quotaOvers, 5);
        eq(TS.standings.effectiveOvers(m), 5, 'counts the full quota, not 0.3');
      });

      it('undo takes back the last delivery', function () {
        var events = [];
        events.push(E.makeEvent(events, 't', 'start', { battingFirst: 'home' }));
        events.push(E.makeEvent(events, 't', 'ball', { runs: 4 }));
        events.push(E.makeEvent(events, 't', 'ball', { runs: 6 }));
        eq(E.summarize('cricket', T20, events).innings[0].runs, 10);
        events.push(E.makeEvent(events, 't', 'undo',
          { targetEventId: E.lastUndoableId(events) }));
        var s = E.summarize('cricket', T20, events);
        eq(s.innings[0].runs, 4);
        eq(s.innings[0].overs, '0.1');
      });
    });

    /* ----------------------------------------------------------- tennis -- */
    describe('Tennis', function () {
      var best3 = { sets: 3, gamesPerSet: 6, tiebreakAt: 6, adScoring: true };

      function play(cfg, seq) {
        var events = [];
        seq.split('').forEach(function (ch) {
          events.push(E.makeEvent(events, 't', 'rally',
            { side: ch === 'H' ? 'home' : 'away' }));
        });
        return E.summarize('tennis', cfg, events);
      }

      it('counts 15, 30, 40 and then the game', function () {
        eq(play(best3, 'H').current.home, '15');
        eq(play(best3, 'HH').current.home, '30');
        eq(play(best3, 'HHH').current.home, '40');
        var g = play(best3, 'HHHH');
        eq(g.gamesNow, { home: 1, away: 0 });
        eq(g.current, { home: '0', away: '0' });
      });

      it('deuce needs two clear points', function () {
        eq(play(best3, 'HHHAAA').current, { home: '40', away: '40' });
        eq(play(best3, 'HHHAAAH').current.home, 'Ad');
        eq(play(best3, 'HHHAAAHA').current, { home: '40', away: '40' },
           'advantage is given back');
        eq(play(best3, 'HHHAAAHH').gamesNow, { home: 1, away: 0 });
      });

      it('sudden death ends deuce in one point', function () {
        var noAd = { sets: 3, gamesPerSet: 6, tiebreakAt: 6, adScoring: false };
        eq(play(noAd, 'HHHAAAH').gamesNow, { home: 1, away: 0 });
      });

      it('six games takes the set', function () {
        var s = play(best3, repeat('H', 24));
        eq(s.gamesWon, { home: 1, away: 0 });
        eq(s.games[0], { home: 6, away: 0 });
      });

      it('two sets takes a best of three', function () {
        var s = play(best3, repeat('H', 48));
        ok(s.complete);
        eq(s.winner, 'home');
      });

      it('6-6 goes to a tie-break, won by two', function () {
        var seq = '';
        for (var i = 0; i < 6; i++) seq += 'HHHH' + 'AAAA';   // 6-6
        var at66 = play(best3, seq);
        eq(at66.gamesNow, { home: 6, away: 6 });
        ok(at66.inTiebreak, 'tie-break started');
        eq(at66.current, { home: '0', away: '0' });

        var six = play(best3, seq + repeat('H', 6) + repeat('A', 6));
        ok(six.inTiebreak, '6-6 in the tie-break is not won');
        var won = play(best3, seq + repeat('H', 7));
        eq(won.gamesWon, { home: 1, away: 0 });
        eq(won.games[0], { home: 7, away: 6 });
      });
    });

    /* ------------------------------------------------- splitting a draw -- */
    describe('Splitting teams into groups', function () {
      /* The bug this guards: a preset asked for 2 groups, only 2 teams were
       * entered, each group got one team, and the draw came out empty with
       * no explanation. A group of one has nobody to play. */
      it('never makes more groups than there are pairs of teams', function () {
        eq(SCH.clampGroups(2, 2), 1, 'two teams cannot be two groups');
        eq(SCH.clampGroups(3, 2), 1);
        eq(SCH.clampGroups(4, 2), 2);
        eq(SCH.clampGroups(12, 2), 2);
        eq(SCH.clampGroups(12, 8), 6);
        eq(SCH.clampGroups(0, 3), 1);
      });

      it('deals teams out evenly', function () {
        var seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
        var gs = SCH.splitIntoGroups(seven, 2);
        eq(gs.length, 2);
        eq(gs[0].length, 4);
        eq(gs[1].length, 3);
        var all = gs[0].concat(gs[1]).sort();
        eq(all, seven.slice().sort(), 'nobody lost or duplicated');
      });

      it('any split of two or more teams produces real fixtures', function () {
        for (var n = 2; n <= 14; n++) {
          var teams = [];
          for (var i = 0; i < n; i++) teams.push('t' + i);
          for (var want = 1; want <= 8; want++) {
            var groups = SCH.splitIntoGroups(teams, want);
            var total = 0;
            groups.forEach(function (g) {
              ok(g.length >= 2, n + ' teams in ' + want +
                 ' groups left a group of ' + g.length);
              total += SCH.roundRobinFixtures({
                entrantIds: g, stageId: 's', groupId: 'g'
              }).length;
            });
            ok(total > 0, n + ' teams in ' + want + ' groups produced no fixtures');
          }
        }
      });
    });

    /* ------------------------------------------------- carrying a stage -- */
    describe('Qualifiers and carry-over setup', function () {
      var stage = { id: 'g1', groups: [{ id: 'gA', name: 'Group A' },
                                       { id: 'gB', name: 'Group B' }] };

      it('orders qualifiers winners-first so a bracket crosses over', function () {
        var refs = SCH.qualifierRefs(stage, 2);
        eq(refs.length, 4);
        eq(refs.map(function (r) { return r.groupId + ':' + r.position; }),
           ['gA:1', 'gB:1', 'gA:2', 'gB:2']);
        // seeded into a bracket that is A1 v B2 and B1 v A2
        var fx = SCH.knockoutFixtures({ entrantRefs: refs, stageId: 'k' });
        var sf = fx.filter(function (f) { return f.round === 1; });
        eq(sf[0].home.groupId + sf[0].home.position, 'gA1');
        eq(sf[0].away.groupId + sf[0].away.position, 'gB2');
        eq(sf[1].home.groupId + sf[1].home.position, 'gB1');
        eq(sf[1].away.groupId + sf[1].away.position, 'gA2');
      });

      it('builds the counting set for each carry-over rule', function () {
        eq(SCH.carryCounts('g1', 'coQualifiers'), [
          { stageId: 'g1', filter: 'bothEntrantsInThisStage', weight: 1 },
          { stageId: 'self', filter: 'all', weight: 1 }
        ]);
        eq(SCH.carryCounts('g1', 'half')[0].weight, 0.5);
        eq(SCH.carryCounts('g1', 'all')[0].filter, 'all');
        eq(SCH.carryCounts('g1', 'none').length, 1, 'nothing carried');
      });

      it('a Super round is one table of whoever came through', function () {
        var refs = SCH.qualifierRefs(stage, 2);      // top two of two groups
        eq(refs.length, 4);
        var fx = SCH.roundRobinFixtures({ entrantRefs: refs, stageId: 's4' });
        eq(fx.length, 6, 'a Super 4 is six matches');
      });

      it('a final is one match between the two group winners', function () {
        var refs = SCH.qualifierRefs(stage, 1);
        eq(refs.length, 2);
        var fx = SCH.knockoutFixtures({ entrantRefs: refs, stageId: 'k' });
        eq(fx.length, 1);
        eq(fx[0].shortLabel, 'F');
        eq(fx[0].home.position, 1);
        eq(fx[0].away.position, 1);
        ok(fx[0].home.groupId !== fx[0].away.groupId, 'the two group winners');
      });

      it('draws a round robin between placeholders, before anyone qualifies', function () {
        var refs = SCH.qualifierRefs(stage, 3);     // six teams
        var fx = SCH.roundRobinFixtures({ entrantRefs: refs, stageId: 's6' });
        eq(fx.length, 15, 'six teams play fifteen matches');
        eq(fx[0].home.kind, 'groupPosition');
        ok(fx.every(function (f) { return f.home && f.away; }), 'both sides set');
      });
    });

    /* ----------------------------------------------- point-by-point detail -- */
    describe('Recording how points end', function () {
      var AN = TS.analysis;
      var cfg = { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false };
      var tourn = { sport: 'badminton', config: { engine: 'rally', detail: 'players' } };

      function rally(evs, side) {
        var e = E.makeEvent(evs, 't', 'rally', { side: side });
        evs.push(e);
        return e;
      }
      function note(evs, ref, how, kind, by) {
        evs.push(E.makeEvent(evs, 't', 'detail',
          { ref: ref, how: how, kind: kind, by: by || null }));
      }

      it('a note about a point never changes the score', function () {
        var evs = [];
        var a = rally(evs, 'home');
        note(evs, a.id, 'smash', 'winner', 'p1');
        var s = E.summarize('rally', cfg, evs);
        eq(s.current, { home: 1, away: 0 });
        eq(s.rallies, 1, 'the note is not a rally');
      });

      it('undo takes back the point, not the note', function () {
        var evs = [];
        var a = rally(evs, 'home');
        note(evs, a.id, 'smash', 'winner', 'p1');
        eq(E.lastUndoableId(evs), a.id, 'undo reaches past the note to the point');
      });

      it('it asks about the last point until something is said', function () {
        var evs = [];
        var a = rally(evs, 'home');
        eq(AN.pendingRally(evs).id, a.id);
        note(evs, a.id, 'smash', 'winner', null);
        eq(AN.pendingRally(evs), null, 'answered, so it stops asking');
        var b = rally(evs, 'away');
        eq(AN.pendingRally(evs).id, b.id, 'the next point asks afresh');
      });

      it('a skipped point stops being asked about but counts for nothing', function () {
        var evs = [];
        var a = rally(evs, 'home');
        note(evs, a.id, null, null, null);
        eq(AN.pendingRally(evs), null);
        eq(AN.detailsOf(evs).length, 0, 'a skip says nothing');
      });

      it('a winner belongs to the side that won the point', function () {
        var evs = [];
        var a = rally(evs, 'home');
        note(evs, a.id, 'smash', 'winner', 'p1');
        var agg = AN.aggregate([{ events: evs, homeEntrantId: 'H', awayEntrantId: 'A' }]);
        eq(agg.byEntrant.H.winners, 1);
        eq(agg.byEntrant.A, undefined, 'nothing is charged to the other side');
        eq(agg.byPlayer.p1.winners, 1);
      });

      it('an error is charged to the side that gave the point away', function () {
        var evs = [];
        var a = rally(evs, 'home');          // home took the point...
        note(evs, a.id, 'out', 'error', 'p9');  // ...because away hit out
        var agg = AN.aggregate([{ events: evs, homeEntrantId: 'H', awayEntrantId: 'A' }]);
        eq(agg.byEntrant.A.errors, 1, 'charged to away, who lost it');
        eq(agg.byEntrant.H, undefined);
        eq(agg.byPlayer.p9.errors, 1);
      });

      it('counts the same shot across several matches', function () {
        var one = [], two = [];
        note(one, rally(one, 'home').id, 'smash', 'winner', 'p1');
        note(one, rally(one, 'home').id, 'smash', 'winner', 'p1');
        note(two, rally(two, 'away').id, 'drop', 'winner', 'p1');
        var agg = AN.aggregate([
          { events: one, homeEntrantId: 'H', awayEntrantId: 'A' },
          { events: two, homeEntrantId: 'A', awayEntrantId: 'H' }
        ]);
        eq(agg.overall.points, 3);
        eq(agg.overall.shots.smash, 2);
        eq(agg.byPlayer.p1.points, 3);
      });

      it('knows the longest run of points', function () {
        var evs = [];
        ['home', 'home', 'home', 'away', 'away', 'home'].forEach(function (s) {
          rally(evs, s);
        });
        eq(AN.longestStreak(evs), { side: 'home', run: 3 });
      });

      it('offers a shot list that fits the sport', function () {
        var bad = AN.shotsFor({ sport: 'badminton', config: {} });
        ok(bad.some(function (s) { return s.id === 'smash'; }));
        var pick = AN.shotsFor({ sport: 'pickleball', config: {} });
        ok(pick.some(function (s) { return s.id === 'dink'; }), 'pickleball gets dinks');
        var fall = AN.shotsFor({ sport: 'nothing-like-it', config: { engine: 'rally' } });
        ok(fall.length > 0, 'an unknown sport still gets a list');
      });

      it('is off unless asked for', function () {
        eq(AN.levelOf({ config: {} }), 'none');
        eq(AN.levelOf(tourn), 'players');
        eq(AN.levelOf(M.makeTournament({ name: 'x' })), 'none');
      });
    });

    /* ------------------------------------------------------ local store -- */
    describe('Local storage fallback', function () {
      it('filters and sorts like the cloud query does', function () {
        var rows = [{ id: 'a', n: 3, s: 'live' }, { id: 'b', n: 1, s: 'done' },
                    { id: 'c', n: 2, s: 'live' }];
        var out = TS.store._filterSort(rows, { where: [['s', '==', 'live']],
                                               orderBy: 'n', dir: 'desc' });
        eq(out.map(function (r) { return r.id; }), ['a', 'c']);
      });

      it('merges nested objects without clobbering siblings', function () {
        var merged = TS.store.deepMerge(
          { rubberSummary: { r1: { home: 21 }, r2: { home: 11 } } },
          { rubberSummary: { r2: { home: 15, away: 21 } } }
        );
        eq(merged.rubberSummary.r1, { home: 21 }, 'r1 survived');
        eq(merged.rubberSummary.r2, { home: 15, away: 21 });
      });
    });

    /* Firestore is a close enough relative of the Artifact db that the
     * wrapper over it is thin - which makes the few places the two disagree
     * the whole of the risk. These are those places. */
    describe('The shared backend', function () {
      var FS = TS.firestore;

      it('a court lease goes BESIDE the rubber, never on it', function () {
        eq(FS._leasePath('tournaments/t1/rubbers/r7'),
           'tournaments/t1/leases/r7',
           'scoring rewrites the rubber document whole, so a lease kept ' +
           'there would be dropped on the floor at every point');
      });

      it('a path with no collection to move into is refused', function () {
        eq(FS._leasePath('tournaments'), null);
      });

      it('a court nobody holds is free', function () {
        var d = FS._leaseDecision(null, 'phoneA', 1000, 45000);
        eq(d.acquired, true);
        eq(d.lock.expiresAt, 46000);
      });

      it('a court this phone already holds is renewed, not refused', function () {
        eq(FS._leaseDecision({ holder: 'phoneA', expiresAt: 9e9 },
                             'phoneA', 1000, 45000).acquired, true);
      });

      it('another phone scoring right now keeps it', function () {
        var d = FS._leaseDecision({ holder: 'phoneB', expiresAt: 5000 },
                                  'phoneA', 1000, 45000);
        eq(d.acquired, false);
        eq(d.holder, 'phoneB');
      });

      it('a lease nobody renewed falls in', function () {
        eq(FS._leaseDecision({ holder: 'phoneB', expiresAt: 900 },
                             'phoneA', 1000, 45000).acquired, true,
           'the scorer walked off with the phone in their pocket');
      });

      it('a lock with no expiry does not hold the court for ever', function () {
        eq(FS._leaseDecision({ holder: 'phoneB' }, 'phoneA', 1000, 45000).acquired,
           true);
      });

      /* The code is what store.js reads to decide whether a point is kept
       * for later or thrown away, so the spelling IS the behaviour. */
      it('a hyphenated code is read as the transient failure it is', function () {
        var e = FS._normError({ code: 'resource-exhausted', message: 'slow down' });
        eq(e.code, 'resource_exhausted');
        eq(TS.store._isTransient(e), true);
      });

      it('a service prefix is stripped off', function () {
        eq(FS._normError({ code: 'firestore/unavailable' }).code, 'unavailable');
      });

      it('a refusal is NOT transient, so it surfaces instead of being stashed',
         function () {
        eq(TS.store._isTransient(FS._normError({ code: 'permission-denied' })),
           false, 'rules this app cannot satisfy have to be seen, not queued');
      });

      it('an error with no code at all is kept rather than lost', function () {
        eq(TS.store._isTransient(FS._normError(new Error('offline'))), true);
      });
    });

    return results;
  }

  /* ----------------------------------------------------------- helpers -- */

  function repeat(ch, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += ch;
    return s;
  }

  // Alternate so both sides reach the given scores.
  function interleave(h, a) {
    var s = '';
    var i = 0;
    while (i < h || i < a) {
      if (i < h) s += 'H';
      if (i < a) s += 'A';
      i++;
    }
    return s;
  }

  /* ------------------------------------------------------------ render -- */

  function render(el) {
    var rs = run();
    var pass = rs.filter(function (r) { return r.pass; }).length;
    var fail = rs.length - pass;
    var groups = [];
    var byGroup = {};
    rs.forEach(function (r) {
      if (!byGroup[r.group]) { byGroup[r.group] = []; groups.push(r.group); }
      byGroup[r.group].push(r);
    });

    var h = '';
    h += '<div class="st-head ' + (fail ? 'st-bad' : 'st-good') + '">' +
         '<strong>' + pass + ' passed</strong>' +
         (fail ? ' &middot; <strong>' + fail + ' failed</strong>' : ' &middot; all green') +
         '</div>';
    groups.forEach(function (g) {
      h += '<section class="st-group"><h3>' + esc(g) + '</h3><ul>';
      byGroup[g].forEach(function (r) {
        h += '<li class="' + (r.pass ? 'st-pass' : 'st-fail') + '">' +
             '<span class="st-mark">' + (r.pass ? 'PASS' : 'FAIL') + '</span> ' +
             esc(r.name) +
             (r.pass ? '' : '<div class="st-msg">' + esc(r.message) + '</div>') +
             '</li>';
      });
      h += '</ul></section>';
    });
    el.innerHTML = h;
    return { pass: pass, fail: fail };
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  TS.selftest = { run: run, render: render };

})(window.TS = window.TS || {});
