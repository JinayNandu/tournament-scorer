/* Tournament Scorer - tennis and padel
 *
 * Deliberately shaped so its summary matches the rally engine's: the same
 * two-tap scoreboard drives it with no special case. `current` carries the
 * point as it is called ("40", "Ad"), `games` the set scores, `gamesWon`
 * the sets.
 */
(function (TS) {
  'use strict';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var tennis = {
    key: 'tennis',

    initialState: function (cfg) {
      cfg = cfg || {};
      return {
        cfg: {
          sets: cfg.sets || 3,
          gamesPerSet: cfg.gamesPerSet || 6,
          tiebreakAt: cfg.tiebreakAt || 6,
          adScoring: cfg.adScoring !== false,
          finalSetTiebreak: cfg.finalSetTiebreak !== false,
          tiebreakTo: cfg.tiebreakTo || 7
        },
        sets: [],                              // completed sets, in games
        games: { home: 0, away: 0 },           // current set
        points: { home: 0, away: 0 },
        inTiebreak: false,
        setsWon: { home: 0, away: 0 },
        gamesTotal: { home: 0, away: 0 },
        pointsTotal: { home: 0, away: 0 },
        serving: 'home',
        winner: null,
        complete: false
      };
    },

    reduce: function (st, ev) {
      if (st.complete && ev.type !== 'setScore') return st;
      var s = clone(st);
      var cfg = s.cfg;

      if (ev.type === 'serve') { s.serving = ev.payload.side || s.serving; return s; }

      if (ev.type === 'award') {
        s.winner = ev.payload.side || null; s.complete = true; return s;
      }

      if (ev.type !== 'rally') return s;

      var w = ev.payload.side;
      if (w !== 'home' && w !== 'away') return st;
      var l = w === 'home' ? 'away' : 'home';

      s.points[w] += 1;
      s.pointsTotal[w] += 1;

      var decidingSet = s.sets.length === cfg.sets - 1;
      var tbTarget = cfg.tiebreakTo;

      if (s.inTiebreak) {
        if (s.points[w] >= tbTarget && s.points[w] - s.points[l] >= 2) {
          s.games[w] += 1;
          winSet(s, w);
        } else if (((s.points.home + s.points.away) % 2) === 1) {
          s.serving = s.serving === 'home' ? 'away' : 'home';
        }
        return s;
      }

      if (gameWon(s.points[w], s.points[l], cfg.adScoring)) {
        s.games[w] += 1;
        s.gamesTotal[w] += 1;
        s.points = { home: 0, away: 0 };
        s.serving = s.serving === 'home' ? 'away' : 'home';

        var g = s.games, need = cfg.gamesPerSet;
        var tiebreakAllowed = cfg.finalSetTiebreak || !decidingSet;
        if (g[w] >= need && g[w] - g[l] >= 2) {
          winSet(s, w);
        } else if (tiebreakAllowed && g.home === cfg.tiebreakAt && g.away === cfg.tiebreakAt) {
          s.inTiebreak = true;
          s.points = { home: 0, away: 0 };
        }
      }
      return s;
    },

    isComplete: function (st) { return !!st.complete; },

    summarize: function (st) {
      var cfg = st.cfg;
      var l = { home: 'away', away: 'home' };
      var gp = [], mp = {}, sp = {};
      if (!st.complete) {
        ['home', 'away'].forEach(function (side) {
          var o = l[side];
          var wins = st.inTiebreak
            ? (st.points[side] + 1 >= cfg.tiebreakTo &&
               st.points[side] + 1 - st.points[o] >= 2)
            : gameWon(st.points[side] + 1, st.points[o], cfg.adScoring);
          if (!wins) return;
          gp.push(side);
          // Winning this game takes the set; taking the set may take the match.
          var g = { home: st.games.home, away: st.games.away };
          g[side] += 1;
          var takesSet = st.inTiebreak ||
            (g[side] >= cfg.gamesPerSet && g[side] - g[o] >= 2);
          var need = Math.floor(cfg.sets / 2) + 1;
          sp[side] = takesSet;
          mp[side] = takesSet && (st.setsWon[side] + 1 >= need);
        });
      }

      var allSets = st.sets.concat(
        st.complete ? [] : [{ home: st.games.home, away: st.games.away }]);

      return {
        engine: 'tennis',
        complete: !!st.complete,
        winner: st.winner,
        current: {
          home: pointName(st.points.home, st.points.away, st.inTiebreak),
          away: pointName(st.points.away, st.points.home, st.inTiebreak)
        },
        games: allSets,
        gamesWon: { home: st.setsWon.home, away: st.setsWon.away },
        primary: { home: st.setsWon.home, away: st.setsWon.away },
        secondary: { home: st.gamesTotal.home, away: st.gamesTotal.away },
        metrics: { games: { home: st.gamesTotal.home, away: st.gamesTotal.away } },
        serving: st.serving,
        server: 1,
        sideOut: false,
        inTiebreak: st.inTiebreak,
        gamesNow: { home: st.games.home, away: st.games.away },
        gamePoint: gp,
        setPoint: sp,
        matchPoint: mp,
        switchDue: false,
        target: st.inTiebreak ? cfg.tiebreakTo : cfg.gamesPerSet,
        winBy: 2,
        rallies: st.pointsTotal.home + st.pointsTotal.away,
        line: allSets.map(function (x) { return x.home + '-' + x.away; }).join(', ')
      };
    }
  };

  function gameWon(p, q, ad) {
    if (ad) return p >= 4 && p - q >= 2;
    return p >= 4;                        // no-ad: sudden death at deuce
  }

  function winSet(s, w) {
    s.sets.push({ home: s.games.home, away: s.games.away });
    if (s.inTiebreak) {
      s.gamesTotal[w] += 1;
      s.inTiebreak = false;
    }
    s.setsWon[w] += 1;
    s.games = { home: 0, away: 0 };
    s.points = { home: 0, away: 0 };
    var need = Math.floor(s.cfg.sets / 2) + 1;
    if (s.setsWon[w] >= need) { s.winner = w; s.complete = true; }
  }

  var NAMES = ['0', '15', '30', '40'];
  function pointName(p, q, tb) {
    if (tb) return String(p);
    if (p >= 3 && q >= 3) {
      if (p === q) return '40';
      return p > q ? 'Ad' : '40';
    }
    return NAMES[p] || String(p);
  }

  TS.engines.register('tennis', tennis);
  TS.tennis = tennis;

})(window.TS = window.TS || {});
