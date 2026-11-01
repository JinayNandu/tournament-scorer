/* Tournament Scorer - cricket, ball by ball
 *
 * A pure fold over deliveries, registered into the engine registry like any
 * other. Nothing outside this file knows what an over is; net run rate
 * reaches the league table as a comparator over the metrics bag.
 *
 * The rules that actually bite, and are easy to get wrong:
 *   - A wide or a no-ball adds a run and is NOT a legal delivery, so the
 *     over does not advance.
 *   - Byes and leg-byes are legal deliveries and count against the team but
 *     never against the batter, and are not conceded by the bowler.
 *   - Strike changes on an odd number of runs RUN, and again at the end of
 *     an over.
 *   - A side bowled out counts its FULL quota of overs for net run rate,
 *     not the overs it actually faced. (That rule lives in standings.js,
 *     fed by `allOut` and `quotaOvers` here.)
 */
(function (TS) {
  'use strict';

  var M = TS.model;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function other(side) { return side === 'home' ? 'away' : 'home'; }

  function newInnings(side, cfg, target) {
    return {
      battingSide: side,
      runs: 0, wickets: 0,
      legalBalls: 0,          // deliveries that counted
      extras: { wd: 0, nb: 0, b: 0, lb: 0 },
      log: [],                // one entry per delivery, for the over display
      allOut: false,
      closed: false,
      declared: false,
      target: target == null ? null : target,
      striker: null, nonStriker: null, bowler: null,
      batters: {}, bowlers: {}
    };
  }

  function batter(inn, id) {
    if (!inn.batters[id]) inn.batters[id] = { runs: 0, balls: 0, fours: 0, sixes: 0, out: null };
    return inn.batters[id];
  }

  function bowlerOf(inn, id) {
    if (!inn.bowlers[id]) inn.bowlers[id] = { balls: 0, runs: 0, wickets: 0 };
    return inn.bowlers[id];
  }

  var cricket = {
    key: 'cricket',

    initialState: function (cfg) {
      cfg = cfg || {};
      return {
        cfg: {
          overs: cfg.overs || 20,
          ballsPerOver: cfg.ballsPerOver || 6,
          wickets: cfg.wickets || 10,
          innings: cfg.innings || 2,
          trackPlayers: !!cfg.trackPlayers
        },
        battingFirst: null,
        innings: [],
        current: 0,
        complete: false,
        winner: null,
        resultText: ''
      };
    },

    reduce: function (st, ev) {
      var s = clone(st);
      var cfg = s.cfg;

      if (ev.type === 'start') {
        s.battingFirst = ev.payload.battingFirst || 'home';
        if (!s.innings.length) s.innings.push(newInnings(s.battingFirst, cfg, null));
        return s;
      }

      if (ev.type === 'setPlayers') {
        var i0 = s.innings[s.current];
        if (!i0) return s;
        if ('striker' in ev.payload) i0.striker = ev.payload.striker;
        if ('nonStriker' in ev.payload) i0.nonStriker = ev.payload.nonStriker;
        if ('bowler' in ev.payload) i0.bowler = ev.payload.bowler;
        return s;
      }

      if (ev.type === 'swap') {
        var isw = s.innings[s.current];
        if (isw) { var t = isw.striker; isw.striker = isw.nonStriker; isw.nonStriker = t; }
        return s;
      }

      if (ev.type === 'ball') {
        if (s.complete) return st;
        if (!s.innings.length) {
          s.battingFirst = s.battingFirst || 'home';
          s.innings.push(newInnings(s.battingFirst, cfg, null));
        }
        var inn = s.innings[s.current];
        if (!inn || inn.closed) return st;

        var p = ev.payload || {};
        var runs = p.runs || 0;                 // runs run, or off the bat
        var extra = p.extra || null;            // wd | nb | b | lb | null
        var wicket = p.wicket || null;
        var legal = (extra !== 'wd' && extra !== 'nb');
        var penalty = (extra === 'wd' || extra === 'nb') ? 1 : 0;
        var total = runs + penalty;

        inn.runs += total;
        if (extra) inn.extras[extra] = (inn.extras[extra] || 0) +
          (extra === 'wd' || extra === 'nb' ? penalty + (extra === 'wd' ? runs : 0) : runs);
        if (legal) inn.legalBalls += 1;

        if (cfg.trackPlayers && inn.striker) {
          var b = batter(inn, inn.striker);
          // Byes and leg-byes are not the batter's runs; a no-ball's extra
          // run is not either, but anything hit off it is.
          if (extra !== 'b' && extra !== 'lb' && extra !== 'wd') {
            b.runs += runs;
            if (runs === 4) b.fours += 1;
            if (runs === 6) b.sixes += 1;
          }
          if (legal) b.balls += 1;
        }
        if (cfg.trackPlayers && inn.bowler) {
          var bw = bowlerOf(inn, inn.bowler);
          if (legal) bw.balls += 1;
          // Byes and leg-byes are not conceded by the bowler.
          if (extra === 'b' || extra === 'lb') bw.runs += penalty;
          else bw.runs += total;
        }

        if (wicket) {
          inn.wickets += 1;
          if (cfg.trackPlayers) {
            var outId = wicket.batterId || inn.striker;
            if (outId) batter(inn, outId).out = wicket.type || 'out';
            if (inn.bowler && wicket.type !== 'run out' && wicket.type !== 'retired') {
              bowlerOf(inn, inn.bowler).wickets += 1;
            }
            if (outId === inn.striker) inn.striker = null;
            else if (outId === inn.nonStriker) inn.nonStriker = null;
          }
        }

        inn.log.push({
          runs: runs, extra: extra, wicket: wicket ? (wicket.type || 'W') : null,
          legal: legal, total: total
        });

        // Strike changes on an odd number of runs run.
        if (!wicket && (runs % 2 === 1)) {
          var sw = inn.striker; inn.striker = inn.nonStriker; inn.nonStriker = sw;
        }
        // And at the end of an over.
        if (legal && inn.legalBalls % cfg.ballsPerOver === 0) {
          var sw2 = inn.striker; inn.striker = inn.nonStriker; inn.nonStriker = sw2;
          inn.bowler = null;         // a bowler may not bowl two in a row
        }

        closeIfDone(s, inn);
        return s;
      }

      if (ev.type === 'endInnings') {
        var ie = s.innings[s.current];
        if (ie && !ie.closed) {
          ie.closed = true;
          ie.declared = !!(ev.payload && ev.payload.declared);
          advance(s);
        }
        return s;
      }

      if (ev.type === 'setScore') {
        var idx = ev.payload.innings == null ? s.current : ev.payload.innings;
        var ic = s.innings[idx];
        if (!ic) return s;
        if (ev.payload.runs != null) ic.runs = ev.payload.runs;
        if (ev.payload.wickets != null) ic.wickets = ev.payload.wickets;
        if (ev.payload.overs != null) {
          ic.legalBalls = Math.round(ev.payload.overs * cfg.ballsPerOver);
        }
        if (ev.payload.balls != null) ic.legalBalls = ev.payload.balls;
        ic.allOut = ic.wickets >= cfg.wickets;
        return s;
      }

      if (ev.type === 'award') {
        s.winner = ev.payload.side || null;
        s.complete = true;
        s.resultText = ev.payload.reason || 'awarded';
        return s;
      }

      if (ev.type === 'noResult') {
        s.complete = true;
        s.winner = null;
        s.noResult = true;
        s.resultText = ev.payload && ev.payload.reason ? ev.payload.reason : 'no result';
        return s;
      }

      return s;
    },

    isComplete: function (st) { return !!st.complete; },

    summarize: function (st) {
      var cfg = st.cfg;
      var byTeam = { home: null, away: null };
      st.innings.forEach(function (inn) {
        if (!byTeam[inn.battingSide]) byTeam[inn.battingSide] = inn;
      });

      function runsOf(side) { return byTeam[side] ? byTeam[side].runs : 0; }
      function metricsOf(side) {
        var inn = byTeam[side];
        if (!inn) return {};
        return {
          runs: inn.runs,
          overs: inn.legalBalls / cfg.ballsPerOver,
          allOut: !!inn.allOut,
          quotaOvers: cfg.overs,
          wickets: inn.wickets
        };
      }

      var inn = st.innings[st.current] || null;
      var target = inn && inn.target;
      var ballsLeft = inn
        ? Math.max(0, cfg.overs * cfg.ballsPerOver - inn.legalBalls) : 0;
      var need = (target != null && inn) ? Math.max(0, target - inn.runs) : null;

      return {
        engine: 'cricket',
        complete: !!st.complete,
        winner: st.winner,
        noResult: !!st.noResult,
        current: { home: runsOf('home'), away: runsOf('away') },
        games: st.innings.map(function (i) {
          return { home: i.battingSide === 'home' ? i.runs : 0,
                   away: i.battingSide === 'away' ? i.runs : 0 };
        }),
        primary: { home: runsOf('home'), away: runsOf('away') },
        secondary: { home: runsOf('home'), away: runsOf('away') },
        metrics: { home: metricsOf('home'), away: metricsOf('away') },
        innings: st.innings.map(function (i) {
          return {
            battingSide: i.battingSide, runs: i.runs, wickets: i.wickets,
            overs: oversText(i.legalBalls, cfg.ballsPerOver),
            allOut: i.allOut, closed: i.closed, declared: i.declared,
            extras: i.extras, batters: i.batters, bowlers: i.bowlers,
            striker: i.striker, nonStriker: i.nonStriker, bowler: i.bowler,
            thisOver: thisOver(i, cfg.ballsPerOver)
          };
        }),
        currentInnings: st.current,
        target: target, need: need, ballsLeft: ballsLeft,
        required: (need != null && ballsLeft > 0)
          ? (need / (ballsLeft / cfg.ballsPerOver)) : null,
        resultText: st.resultText,
        line: lineOf(st, cfg)
      };
    },

    oversText: oversText
  };

  /* An innings is over at its quota, or when the side is bowled out. */
  function closeIfDone(s, inn) {
    var cfg = s.cfg;
    if (inn.wickets >= cfg.wickets) { inn.allOut = true; inn.closed = true; }
    else if (inn.legalBalls >= cfg.overs * cfg.ballsPerOver) { inn.closed = true; }
    else if (inn.target != null && inn.runs >= inn.target) { inn.closed = true; }
    if (inn.closed) advance(s);
  }

  function advance(s) {
    var cfg = s.cfg;
    if (s.innings.length >= cfg.innings) { finish(s); return; }
    var first = s.innings[0];
    var nextSide = other(s.innings[s.innings.length - 1].battingSide);
    var target = s.innings.length === 1 ? first.runs + 1 : null;
    s.innings.push(newInnings(nextSide, cfg, target));
    s.current = s.innings.length - 1;
  }

  function finish(s) {
    s.complete = true;
    var h = 0, a = 0, hi = null, ai = null;
    s.innings.forEach(function (i) {
      if (i.battingSide === 'home') { h += i.runs; hi = i; }
      else { a += i.runs; ai = i; }
    });
    if (h > a) { s.winner = 'home'; }
    else if (a > h) { s.winner = 'away'; }
    else { s.winner = null; }

    if (!s.winner) { s.resultText = 'Match tied'; return; }
    var winInn = s.winner === 'home' ? hi : ai;
    var chased = winInn && winInn.target != null;
    if (chased) {
      var left = s.cfg.wickets - winInn.wickets;
      s.resultText = 'Won by ' + left + ' wicket' + (left === 1 ? '' : 's');
    } else {
      s.resultText = 'Won by ' + Math.abs(h - a) + ' run' +
                     (Math.abs(h - a) === 1 ? '' : 's');
    }
  }

  function oversText(balls, bpo) {
    return Math.floor(balls / bpo) + '.' + (balls % bpo);
  }

  /* The deliveries of the over in progress - or, right after an over ends,
   * the over just completed, which is what a scorer wants to see. */
  function thisOver(inn, bpo) {
    var want = inn.legalBalls % bpo;
    if (want === 0 && inn.legalBalls > 0) want = bpo;
    if (want === 0) return [];
    var out = [], legal = 0;
    for (var i = inn.log.length - 1; i >= 0 && legal < want; i--) {
      out.unshift(inn.log[i]);
      if (inn.log[i].legal) legal += 1;
    }
    return out;
  }

  function lineOf(st, cfg) {
    if (!st.innings.length) return '';
    return st.innings.map(function (i) {
      return i.runs + '/' + i.wickets +
             (i.allOut ? '' : ' (' + oversText(i.legalBalls, cfg.ballsPerOver) + ')');
    }).join('  v  ');
  }

  TS.engines.register('cricket', cricket);
  TS.cricket = cricket;

})(window.TS = window.TS || {});
