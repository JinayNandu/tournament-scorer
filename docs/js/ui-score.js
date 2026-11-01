/* Tournament Scorer - score mode
 *
 * The screen someone uses while standing next to a court with one hand free.
 * Everything here follows from that: two enormous tap targets, an undo
 * always within thumb reach, no confirmation between a rally and the number
 * changing, and a screen that will not go to sleep mid-game.
 *
 * Taps render immediately from a local copy of the event log and are written
 * behind that. Events are append-only with unique ids, so a write landing
 * late, twice, or out of order cannot corrupt the score.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, E = TS.engines, el = U.el;

  var local = { rid: null, events: [], dismissed: null };
  var lease = { held: false, override: false, timer: null, checked: null,
                resolved: false };
  var wakeLock = null;
  var saveTimer = null;
  var locked = false;

  /* --------------------------------------------------------- lifecycle -- */

  var entered = null;
  function enter(S, api) {
    if (entered !== S.rid) { entered = S.rid; requestWake(); healSummary(S, api); }
    claim(S, api);
  }

  /* The stored summary is a cache of the event log, and a cache can fall
   * behind it: a write that never landed, or - as happened with the
   * double-counted points of a corrected score - a fix to the engine that
   * changes what the same events add up to. Nothing else can notice,
   * because the table reads fixtures and never loads a rubber. So
   * whenever a rubber IS loaded, re-fold it and rewrite if the stored
   * answer disagrees. */
  function healSummary(S, api) {
    var r = S.rubber;
    if (!r || !(r.events || []).length) return;
    var fresh = E.summarize(engineFor(S), scoringFor(S), r.events);
    var was = r.summary || {};
    var same = was.complete === !!fresh.complete &&
               was.winner === (fresh.winner || null) &&
               was.line === (fresh.line || '') &&
               was.current && fresh.current &&
               was.current.home === fresh.current.home &&
               was.current.away === fresh.current.away &&
               was.secondary && fresh.secondary &&
               was.secondary.home === fresh.secondary.home &&
               was.secondary.away === fresh.secondary.away;
    if (same) return;

    var copy = JSON.parse(JSON.stringify(r));
    copy.summary = fresh;
    copy.status = fresh.complete ? M.STATUS.COMPLETED : M.STATUS.LIVE;
    var patch = compact(fresh, copy);
    var fstatus = fixtureStatus(S, copy.fixtureId, copy.id, fresh);
    TS.store.set('tournaments/' + S.tid + '/rubbers/' + copy.id, copy)
      .then(function () {
        return api.patchFixtureRubber(copy.fixtureId, copy.id, patch, fstatus);
      })['catch'](function () { /* read-only viewer; the board is right anyway */ });
  }

  function leave(S, api) {
    releaseWake();
    if (lease.timer) { clearInterval(lease.timer); lease.timer = null; }
    lease.held = false; lease.override = false; lease.checked = null;
    lease.resolved = false;
    entered = null;
    pick.side = null; pick.serverIndex = null;
    armed = null;
    noting = null;
    flush(S, api, true);
    local.rid = null; local.events = []; local.dismissed = null;
    locked = false;
  }

  function requestWake() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (s) { wakeLock = s; },
          function () { /* refused; nothing to do */ });
      }
    } catch (e) { /* not available */ }
  }

  function releaseWake() {
    try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
  }

  /* A cooperative lease. Not security - it stops two scorers quietly
   * double-counting the same rally, which is the real failure. */
  function claim(S, api) {
    if (lease.checked === S.rid) return;
    lease.checked = S.rid;
    var path = 'tournaments/' + S.tid + '/rubbers/' + S.rid;
    TS.store.acquire(path, { holder: TS.store.clientId(), ttlMs: 60000 })
      .then(function (r) {
        lease.held = !!r.acquired;
        lease.resolved = true;
        api.render();
        if (lease.timer) clearInterval(lease.timer);
        lease.timer = setInterval(function () {
          if (S.screen !== 'score') return;
          TS.store.acquire(path, { holder: TS.store.clientId(), ttlMs: 60000 })
            .then(function (x) { lease.held = !!x.acquired; });
        }, 30000);
      });
  }

  /* Until the lease answers, assume we may score. On a hall wifi that round
   * trip can take a second or two, and a scoreboard that swallows the first
   * few taps is worse than the rare double-scored rally the lease prevents. */
  function canWrite() { return !lease.resolved || lease.held || lease.override; }

  /* The lease has answered and it is not ours. */
  function readOnly() { return lease.resolved && !lease.held && !lease.override; }

  function takeOver(S, api) {
    U.confirmSheet({
      title: 'Take over scoring?',
      message: 'Another phone has this game open. If you both score it, points get counted twice. Only take over if the other scorer has stopped.',
      confirmLabel: 'Take over'
    }).then(function (yes) {
      if (yes) { lease.override = true; api.render(); }
    });
  }

  /* ------------------------------------------------------------ events -- */

  function eventsFor(S) {
    if (local.rid !== S.rid) {
      local.rid = S.rid;
      local.events = ((S.rubber && S.rubber.events) || []).slice();
      local.dismissed = null;
    } else if (S.rubber) {
      local.events = mergeEvents(local.events, S.rubber.events || []);
    }
    return local.events;
  }

  // Append-only with unique ids, so merging two views is a union.
  function mergeEvents(a, b) {
    var seen = {}, out = [];
    a.concat(b).forEach(function (e) {
      if (!e || seen[e.id]) return;
      seen[e.id] = true;
      out.push(e);
    });
    return E.sortEvents(out);
  }

  function push(S, api, type, payload) {
    if (!canWrite()) {
      U.toast('Someone else is scoring this game. Take over first.', 'warn');
      return;
    }
    var events = eventsFor(S);
    events.push(E.makeEvent(events, TS.store.clientId(), type, payload));
    local.dismissed = null;
    buzz(type);
    api.render();
    scheduleSave(S, api);
  }

  /* A short buzz confirms the tap registered without looking. Android
   * honours it, iOS Safari ignores it, and neither is a problem. */
  function buzz(type) {
    try {
      if (!navigator.vibrate) return;
      navigator.vibrate(type === 'undo' ? [12, 40, 12] : 14);
    } catch (e) { /* not available */ }
  }

  function scheduleSave(S, api) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { flush(S, api); }, 350);
  }

  function flush(S, api, quiet) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!S.tid || !local.rid || !local.events.length) return;
    var rid = local.rid;
    var rubber = S.rubber;
    if (!rubber || rubber.id !== rid) return;

    var cfg = scoringFor(S);
    var sum = E.summarize(engineFor(S), cfg, local.events);
    var copy = JSON.parse(JSON.stringify(rubber));
    copy.events = local.events;
    copy.summary = sum;
    copy.status = sum.complete ? M.STATUS.COMPLETED
                : local.events.length ? M.STATUS.LIVE : M.STATUS.SCHEDULED;

    /* Both worked out NOW, not inside the callback below. leave() flushes
     * and then navigates, so by the time the rubber write resolves S.fid is
     * already null - fixtureStatus read it as "no such fixture" and
     * returned nothing, the score was saved and the status silently was
     * not. Every played meeting stayed "scheduled", which left the table
     * empty and the next stage with nothing to resolve from. */
    var patch = compact(sum, copy);
    var fstatus = fixtureStatus(S, copy.fixtureId, rid, sum);
    var played = playedSides(S, copy.fixtureId);

    TS.store.set('tournaments/' + S.tid + '/rubbers/' + rid, copy)
      .then(function () {
        return api.patchFixtureRubber(copy.fixtureId, rid, patch, fstatus, played);
      })
      .catch(function (e) { if (!quiet) api.writeFailed(e); });
  }

  /* Only what other screens read - the full event log stays in the rubber
   * document. Who played and when are carried here so the leaderboard and
   * the feed can be built from fixtures alone, without loading hundreds of
   * rubber documents. */
  function compact(sum, rubber) {
    return {
      complete: !!sum.complete, winner: sum.winner || null,
      current: sum.current, line: sum.line || '',
      resultText: sum.resultText || '',
      primary: sum.primary, secondary: sum.secondary,
      metrics: sum.metrics || {}, rallies: sum.rallies || 0,
      status: rubber.status,
      label: rubber.label,
      homePlayers: rubber.homePlayers || [],
      awayPlayers: rubber.awayPlayers || [],
      at: new Date().toISOString()
    };
  }

  /* Who took the court, recorded the first time a meeting is scored.
   * Progression will not re-point a fixture that carries this, which is
   * what stops a late change upstream rewriting - or blanking - the teams
   * in a semi-final that has already been played. Written once: the whole
   * point is that it does not follow later resolutions. */
  function playedSides(S, fixtureId) {
    var f = S.fixturesById[fixtureId];
    if (!f || (f.resolved && f.resolved.home && f.resolved.away)) return null;
    var s = (S.resolved && S.resolved.sides[fixtureId]) || null;
    if (!s || !s.home || !s.away) return null;
    return { home: s.home, away: s.away };
  }

  /* A match is off the list once it has been played or written off. */
  function settled(s) {
    return !!(s && (s.complete || s.status === M.STATUS.NOT_PLAYED));
  }

  /* A tie is done when every match in it has been settled. The fixture is
   * named rather than taken from the screen, and the count comes from the
   * meeting's own matchCount - a meeting can have more or fewer matches
   * than the tournament default, and the tie template may hold neither. */
  function fixtureStatus(S, fixtureId, rid, sum) {
    var f = S.fixturesById[fixtureId];
    if (!f) return null;
    var total = f.matchCount == null
      ? TS.matches.defaultMatchCount(S.tournament)
      : f.matchCount;
    if (total < 1) total = 1;
    var done = 0;
    var map = f.rubberSummary || {};
    Object.keys(map).forEach(function (k) {
      if (k !== rid && settled(map[k])) done += 1;
    });
    if (settled(sum)) done += 1;
    return done >= total ? M.STATUS.COMPLETED : M.STATUS.LIVE;
  }

  function engineFor(S) {
    return M.resolveEngine(S.tournament, stageOf(S), templateRubber(S), S.rubber);
  }

  function scoringFor(S) {
    return M.resolveScoring(S.tournament, stageOf(S), templateRubber(S), S.rubber);
  }

  function stageOf(S) {
    var f = S.fixturesById[S.fid];
    if (!f) return null;
    return (S.tournament.stages || []).filter(function (s) {
      return s.id === f.stageId;
    })[0] || null;
  }

  /* Which entry in the match template this game came from - the thing
   * that knows whether it is played to 15 while the rest go to 21.
   *
   * The id is the link, but templates saved before the ids were kept
   * stable left games pointing at entries that no longer exist. The
   * label is what the organiser typed and what both ends still agree
   * on, so it is the fallback rather than giving up and using the
   * tournament's own target. */
  function templateRubber(S) {
    if (!S.rubber) return null;
    var list = (S.tournament.config.tieTemplate.rubbers) || [];
    var byId = list.filter(function (tr) {
      return tr.id === S.rubber.templateRubberId;
    })[0];
    if (byId) return byId;
    var label = String(S.rubber.label || '').trim().toLowerCase();
    if (!label) return null;
    return list.filter(function (tr) {
      return String(tr.label || '').trim().toLowerCase() === label;
    })[0] || null;
  }

  /* ------------------------------------------------------------ render -- */

  function render(S, api) {
    var root = document.getElementById('root');
    if (!S.rubber) {
      // Gone, or not here yet. Either way there must be a way back - this
      // used to be a dead end whenever a match was removed while open.
      var out = function () {
        leave(S, api);
        api.openRubber(null); api.openFixture(null);
        api.go('hub', { tab: 'matches' });
      };
      U.mount(root, el('div', {}, [
        api.topbar('Game', null, null, { label: 'Matches', onclick: out }),
        el('div', { class: 'wrap' }, [
          S.rubberLoaded
            ? U.empty('This game is no longer here',
                'It was removed — perhaps by someone else scoring.',
                el('button', { class: 'btn btn-primary', text: 'Back to the matches',
                               onclick: out }))
            : el('p', { class: 'muted', text: 'Opening the game...' })
        ])
      ]));
      return;
    }
    enter(S, api);

    var events = eventsFor(S);
    var engine = engineFor(S);
    var cfg = scoringFor(S);
    var sum = E.summarize(engine, cfg, events);
    var f = S.fixturesById[S.fid];
    var sides = api.sidesOf(S.fid);

    /* The banner floats over the board. A one-line one clears both scores,
     * but the "how was that point won?" prompt is three times as tall and
     * sat across the lower number. When it is up the zones give way, so
     * the scorer can still read the score they are annotating. */
    var bn = banner(S, api, sum);
    var tall = bn && (bn.className || '').indexOf('bb-tall') >= 0;

    var board = el('div', { class: 'board' + (tall ? ' board-tall-banner' : '') }, [
      topRow(S, api, sum),
      (engine === 'rally' || engine === 'tennis') ? zones(S, api, sum, sides)
        : engine === 'tally' ? tallyZones(S, api, sum, sides)
        : engine === 'cricket' ? cricketPanel(S, api, sum, sides)
        : manualPanel(S, api, sum, sides),
      bn,
      bottomRow(S, api, sum, engine)
    ]);

    U.mount(root, board);

    /* The banner floats clear of the controls, and the controls wrap to a
     * second row on a narrow phone, so where "clear" is has to be measured
     * rather than guessed at. */
    var foot = board.querySelector('.board-bottom');
    if (foot) board.style.setProperty('--foot', foot.offsetHeight + 'px');

    maybeAskServe(S, api, sum);
  }

  /* Who serves is the one thing the board cannot work out for itself, and
   * in doubles a guess is wrong about half the time - which then has to
   * be spotted and undone. So it asks, once per game.
   *
   * It is still a sheet and not a gate: closing it leaves the banner, the
   * board is live behind it, and the first point can be scored without
   * ever answering. Nothing may stand between an organiser and a score. */
  var askedServe = {};

  function maybeAskServe(S, api, sum) {
    if (!S.rid || askedServe[S.rid] || !canWrite()) return;
    if (!serveTracked(S) || !needsFirstServe(S, sum)) return;
    askedServe[S.rid] = true;
    // After the mount, so the board is already there behind the sheet.
    window.setTimeout(function () {
      if (S.screen === 'score' && S.rid) serveSetup(S, api);
    }, 0);
  }

  /* Name AND symbol on every board control. The glyph alone told nobody
   * what it did; the name alone made six buttons look identical at the
   * distance they are actually read from - standing beside a court. */
  function ctl(glyph, label) {
    return [
      el('span', { class: 'ctl-ico', 'aria-hidden': 'true', text: glyph }),
      el('span', { text: label })
    ];
  }

  function topRow(S, api, sum) {
    var r = S.rubber;
    var order = S.rubbers.slice().sort(function (a, b) { return a.order - b.order; });
    var idx = -1;
    for (var k = 0; k < order.length; k++) { if (order[k].id === S.rid) idx = k; }
    var total = order.length;
    var where = (r.court ? '  ·  Court ' + r.court : '');

    // Which match of the tie this is, and a tap to move to another. Without
    // this it is genuinely hard to tell one match from the next.
    /* "Game 1 · game 1 of 3" said it twice. A label that already names the
     * game just needs the count after it; one called AA still needs to say
     * which of the eleven it is. */
    var named = /^game\s*\d+$/i.test(String(r.label || '').trim());
    var count = named ? '  of ' + total : '  ·  game ' + (idx + 1) + ' of ' + total;

    var title = total > 1
      ? el('button', { class: 'bt-jump',
          onclick: function () { matchJumper(S, api); } }, [
          el('b', { text: r.label }),
          el('span', { text: count + where + '   ▾' })
        ])
      : el('div', { class: 'bt-title', text: r.label + where });

    /* Nothing but the title up here. Every control used to sit in one of
     * the four corners, which meant hunting for them one at a time; they
     * are all in one row along the bottom now. */
    return el('div', { class: 'board-top' }, [title]);
  }

  /* Which team shows on the left. Players change ends mid-game and the
   * scorer turns round with them, so this flips the BOARD only - never the
   * scores. It is kept on this device, since two scorers at opposite ends
   * of the same court want opposite views. */
  function flipKey(rid) { return 'ts1:flip:' + rid; }

  function isFlipped(rid) {
    try { return window.localStorage.getItem(flipKey(rid)) === '1'; }
    catch (e) { return false; }
  }

  function setFlipped(rid, on) {
    try { window.localStorage.setItem(flipKey(rid), on ? '1' : '0'); }
    catch (e) { /* private window; the flip just will not persist */ }
  }

  function sideOrder(rid) {
    return isFlipped(rid) ? ['away', 'home'] : ['home', 'away'];
  }

  function zones(S, api, sum, sides) {
    return el('div', { class: 'zones' }, sideOrder(S.rid).map(function (side) {
      return zone(S, api, sum, sides, side);
    }));
  }

  function zone(S, api, sum, sides, side) {
    var r = S.rubber;
    var entrant = S.entrantsById[sides[side]];
    var players = side === 'home' ? r.homePlayers : r.awayPlayers;
    var tracked = serveTracked(S);
    var serving = tracked && sum.serving === side && !sum.complete;
    /* Three different things, and at 40-0 in the opening game of a set
     * nobody is on set point - you cannot take a set from no games, and
     * calling it one is how a referee gets shouted at.
     *
     * Tennis keeps the tennis words: "game point" there means the
     * 15-30-40 unit and every tennis scorer reads it that way. Everywhere
     * else the contest on this board IS the game, so the point that ends
     * it is game point and the one that ends a set is set point. */
    var ends = sum.engine === 'tennis'
      ? { all: 'Match point', set: 'Set point', part: 'Game point' }
      : { all: 'Game point',  set: 'Set point', part: 'Set point' };
    var flag = sum.complete
      ? (sum.winner === side ? 'Winner' : '')
      : (sum.golden ? 'Golden point'
          : sum.gamePoint.indexOf(side) !== -1
            ? (sum.matchPoint[side] ? ends.all
               : (sum.setPoint && sum.setPoint[side]) ? ends.set
               : ends.part) : '');

    // In tennis the big number is the point, so the set in progress belongs
    // in the strip. In rally sports the big number IS the current game, so
    // showing it again would just be noise.
    var gamesLine = (sum.engine === 'tennis'
      ? (sum.games || [])
      : (sum.games || []).slice(0, sum.complete ? undefined : -1)
    ).map(function (g) { return g[side]; });

    return el('button', {
      class: 'zone' + (serving ? ' serving' : ''),
      style: '--team:' + ((entrant && entrant.color) || '#2B4441'),
      disabled: locked || sum.complete || !canWrite(),
      'aria-label': 'Point to ' + (entrant ? entrant.name : side),
      onclick: function () { push(S, api, 'rally', { side: side }); }
    }, [
      el('div', { class: 'z-name', text: entrant ? entrant.name : side }),
      playerLines(S, sum, side, players, serving, tracked),
      el('div', { class: 'z-score', text: String(sum.current[side]) }),
      el('div', { class: 'z-games' }, gamesLine.length
        ? gamesLine.map(function (n) { return el('i', { text: String(n) }); })
        : [el('i', { text: ' ' })]),
      el('div', { class: 'z-serve' }, serving
        ? [el('span', { class: 'sv' }),
           el('span', { text: sum.server === 2 && serverMatters(sum) ? 'SERVING 2' : 'SERVING' })]
        : [el('span', { text: ' ' })]),
      el('div', { class: 'z-flag', text: flag || ' ' })
    ]);
  }

  // The server number only means anything under side-out scoring, where a
  // side gets two servers before handing over.
  function serverMatters(sum) { return !!sum.sideOut; }

  /* Serve tracking is optional. Turned off, the names stay and every trace
   * of who serves goes - no chips, no court, nothing. */
  function serveTracked(S) {
    var cfg = scoringFor(S) || {};
    return cfg.trackServe !== false;
  }

  /* Each player on their own line, with the one serving and the one
   * receiving called out. In doubles this is the thing people actually lose
   * track of, so it sits on the scoreboard rather than in a menu. */
  function playerLines(S, sum, side, players, serving, tracked) {
    players = players || [];
    if (!players.length) {
      return el('div', { class: 'z-sub', style: 'opacity:.6', text: 'no names yet' });
    }

    var markIdx = null, markText = '';
    if (tracked && !sum.complete && sum.serverIndex != null) {
      if (serving) {
        markIdx = sum.serverIndex;
        markText = players.length > 1
          ? 'serves ' + sum.serveCourt : 'serves';
      } else if (sum.serving !== side) {
        markIdx = sum.receiverIndex;
        markText = 'receives';
      }
    }

    return el('div', { class: 'z-players' }, players.map(function (pid, i) {
      var p = S.playersById[pid];
      var on = (i === markIdx);
      return el('div', { class: 'z-pl' + (on ? ' on' : '') }, [
        el('span', { text: p ? U.shortName(p.name) : '?' }),
        on && markText ? el('i', { text: markText }) : null
      ]);
    }));
  }

  /* ------------------------------------------------- who serves first -- */

  var pick = { side: null, serverIndex: null };

  function needsFirstServe(S, sum) {
    if (sum.engine !== 'rally' || sum.firstServeSet || sum.rallies) return false;
    var r = S.rubber;
    return (r.homePlayers || []).length > 1 && (r.awayPlayers || []).length > 1;
  }

  /* Setting who serves is a SHEET, not a gate. Blocking every match with
   * an identical-looking question made it feel as though the app was stuck
   * on the same match; the board now opens straight away with a sensible
   * default and this is one tap from the banner. */
  function serveSetup(S, api) {
    var r = S.rubber;
    var sides = api.sidesOf(S.fid);
    pick.side = null; pick.serverIndex = null;

    function names(side) {
      return ((side === 'home' ? r.homePlayers : r.awayPlayers) || [])
        .map(function (pid) {
          var p = S.playersById[pid];
          return p ? p.name : 'Player';
        });
    }

    U.sheet('Who serves first?', function (close) {
      var host = el('div', { class: 'stack' });

      function teamBlock(side, onPick) {
        return el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: api.entrantName(sides[side]) })
        ].concat(names(side).map(function (nm, i) {
          return el('button', { class: 'btn btn-block', text: nm,
            onclick: function () { onPick(side, i); } });
        })));
      }

      function paintServer() {
        U.mount(host, [
          el('p', { class: 'small muted', text:
            'Whoever serves first starts in the right-hand court.' }),
          el('div', { class: 'grid2' }, [
            teamBlock('home', chose), teamBlock('away', chose)
          ])
        ]);
      }

      function chose(side, i) {
        pick.side = side; pick.serverIndex = i;
        var recv = side === 'home' ? 'away' : 'home';
        if (names(recv).length < 2) { commit(0); return; }
        U.mount(host, [
          el('p', { class: 'small muted', text:
            names(side)[i] + ' serves from the right, so the serve goes ' +
            'diagonally. Who is standing there?' }),
          teamBlock(recv, function (s, j) { commit(j); }),
          el('button', { class: 'btn btn-ghost', text: 'Back', onclick: paintServer })
        ]);
      }

      function commit(receiverIndex) {
        push(S, api, 'firstServe', {
          side: pick.side, serverIndex: pick.serverIndex,
          receiverIndex: receiverIndex
        });
        pick.side = null; pick.serverIndex = null;
        close();
      }

      paintServer();
      return host;
    });
  }

  /* Before the first point, say who the app thinks is serving rather than
   * demanding an answer. Wrong by default costs one tap; a gate costs one
   * on every match. */
  function serveBanner(S, api, sum) {
    var r = S.rubber;

    // Names come first: a match with nobody in it is the thing to fix.
    if (!sum.rallies && !sum.complete &&
        (!(r.homePlayers || []).length || !(r.awayPlayers || []).length)) {
      return el('div', { class: 'board-banner' }, [
        el('div', { style: 'min-width:0' }, [
          el('b', { text: 'Who is playing?' }),
          el('div', { class: 'bb-sub',
            text: 'Type the names, or score without them.' })
        ]),
        el('button', { class: 'board-btn', text: 'Add names',
          onclick: function () { lineupSheet(S, api); } })
      ]);
    }

    if (!serveTracked(S) || !needsFirstServe(S, sum)) return null;

    var srvList = sum.serving === 'away' ? r.awayPlayers : r.homePlayers;
    var rcvList = sum.serving === 'away' ? r.homePlayers : r.awayPlayers;
    var srv = S.playersById[(srvList || [])[sum.serverIndex]];
    var rcv = S.playersById[(rcvList || [])[sum.receiverIndex]];

    /* Three buttons and a name do not fit one phone line, and the name is
     * the part that matters - so this one wraps rather than clipping to
     * "Amit serves ...". */
    return el('div', { class: 'board-banner bb-tall' }, [
      el('div', { style: 'min-width:0;width:100%' }, [
        el('b', { text: (srv ? U.shortName(srv.name) : 'Who') + ' serves first' }),
        el('div', { class: 'bb-sub',
          text: 'to ' + (rcv ? U.shortName(rcv.name) : '?') })
      ]),
      el('button', { class: 'board-btn', text: 'Change',
        onclick: function () { serveSetup(S, api); } }),
      el('button', { class: 'board-btn', text: 'OK',
        onclick: function () {
          push(S, api, 'firstServe', {
            side: sum.serving, serverIndex: sum.serverIndex,
            receiverIndex: sum.receiverIndex
          });
        } }),
      el('button', { class: 'board-btn', title: 'Stop tracking serve here',
        text: 'Not tracking',
        onclick: function () { stopTrackingServe(S, api); } })
    ]);
  }

  /* Turn serve tracking off for this match. Stored as a scoring override,
   * so it has to carry the whole resolved config - the override replaces
   * the config rather than merging with it. */
  /* ------------------------------------------- how was that point won -- */

  /* The point is already on the board; this only asks what it was. One tap
   * in Advance, two in Pro, and ignoring it entirely is fine - the next
   * point can just be scored straight over the top. */
  var noting = null;        // {ref, how, kind} while Pro asks who

  function detailStrip(S, api, sum) {
    var A = TS.analysis;
    var level = A.levelOf(S.tournament);
    if (level === 'none' || !canWrite()) return null;
    if (sum.engine !== 'rally' && sum.engine !== 'tennis' && sum.engine !== 'tally') {
      return null;
    }

    var ev = A.pendingRally(local.events);
    if (!ev) { noting = null; return null; }
    if (noting && noting.ref !== ev.id) noting = null;

    var sides = api.sidesOf(S.fid);
    var r = S.rubber;

    if (!noting) {
      var who = api.entrantName(sides[ev.payload.side]);
      return el('div', { class: 'board-banner bb-tall' }, [
        el('div', { style: 'width:100%;font-size:12px;color:#9DB5B1',
          text: 'Point to ' + who + ' — how?' })
      ].concat(A.shotsFor(S.tournament).map(function (s) {
        return el('button', {
          class: 'board-btn',
          style: s.kind === 'error' ? 'border-color:#4A3A1E;color:#E0C77A' : '',
          text: s.label,
          onclick: function () {
            if (level === 'players') { noting = { ref: ev.id, how: s.id, kind: s.kind }; api.render(); }
            else { note(S, api, ev.id, s.id, s.kind, null); }
          }
        });
      })).concat([
        el('button', { class: 'board-btn', style: 'opacity:.6', text: 'Skip',
          onclick: function () { note(S, api, ev.id, null, null, null); } })
      ]));
    }

    // Pro: who played it. A winner belongs to the side that won the point,
    // an error to the side that gave it away.
    var owner = noting.kind === 'error'
      ? (ev.payload.side === 'home' ? 'away' : 'home')
      : ev.payload.side;
    var ids = (owner === 'home' ? r.homePlayers : r.awayPlayers) || [];
    var shot = A.shotById(S.tournament, noting.how);

    return el('div', { class: 'board-banner bb-tall' }, [
      el('div', { style: 'width:100%;font-size:12px;color:#9DB5B1',
        text: (shot ? shot.label : 'That') + ' — by whom?' })
    ].concat(ids.length ? ids.map(function (pid) {
      var p = S.playersById[pid];
      return el('button', { class: 'board-btn', text: p ? U.shortName(p.name) : 'Player',
        onclick: function () { note(S, api, noting.ref, noting.how, noting.kind, pid); } });
    }) : [
      /* Pro mode asks who played the shot, and without names it has
       * nothing to offer. This is the moment the organiser finds that
       * out, so the way to fix it belongs here rather than three taps
       * away under Fix. */
      el('div', { style: 'width:100%;font-size:12px;color:#9DB5B1',
        text: 'No names on this game yet.' }),
      el('button', { class: 'board-btn', text: 'Add names',
        onclick: function () { lineupSheet(S, api); } })
    ]).concat([
      el('button', { class: 'board-btn', style: 'opacity:.6', text: 'Not sure',
        onclick: function () { note(S, api, noting.ref, noting.how, noting.kind, null); } })
    ]));
  }

  function note(S, api, ref, how, kind, by) {
    noting = null;
    push(S, api, 'detail', { ref: ref, how: how, kind: kind, by: by });
  }

  function stopTrackingServe(S, api) {
    var copy = JSON.parse(JSON.stringify(S.rubber));
    copy.scoringOverride = TS.standings.assign({}, scoringFor(S), { trackServe: false });
    api.saveRubber(copy).then(function () {
      api.render();
      U.toast('Serving is not being tracked for this game.');
    });
  }

  /* Every match in the tie, so moving between them is one tap and it is
   * obvious which one is open. */
  function matchJumper(S, api) {
    var f = S.fixturesById[S.fid];
    var order = S.rubbers.slice().sort(function (a, b) { return a.order - b.order; });

    U.sheet('Games in this match', function (close) {
      return [el('div', { class: 'stack-s' }, order.map(function (r, i) {
        var s = (f.rubberSummary || {})[r.id];
        var here = r.id === S.rid;
        var state = s && s.complete ? s.line
                  : s && s.rallies ? s.line + '  (in play)'
                  : 'not started';
        return el('button', {
          class: 'btn btn-block' + (here ? ' btn-primary' : ''),
          style: 'justify-content:space-between;text-align:left;gap:12px',
          onclick: function () {
            close();
            if (here) return;
            flush(S, api, true);
            leave(S, api);
            api.go('score', { rid: r.id, fid: S.fid });
          }
        }, [
          el('span', { style: 'min-width:0' }, [
            el('b', { text: (i + 1) + '.  ' + r.label + (here ? '  ·  open' : '') }),
            el('div', { style: 'font-size:12px;opacity:.75', text:
              U.playerNames(r.homePlayers, S.playersById, { short: true }) + '  v  ' +
              U.playerNames(r.awayPlayers, S.playersById, { short: true }) })
          ]),
          el('span', { class: 'num', style: 'font-size:12.5px;opacity:.8', text: state })
        ]);
      }))];
    });
  }

  function tallyZones(S, api, sum, sides) {
    var cfg = scoringFor(S);
    var incs = (cfg && cfg.increments) || [1];
    return el('div', { class: 'zones' }, sideOrder(S.rid).map(function (side) {
      var entrant = S.entrantsById[sides[side]];
      return el('div', {
        class: 'zone', style: '--team:' + ((entrant && entrant.color) || '#2B4441')
      }, [
        el('div', { class: 'z-name', text: entrant ? entrant.name : side }),
        el('div', { class: 'z-score', text: String(sum.current[side]) }),
        el('div', { class: 'row', style: 'justify-content:center;gap:6px;flex-wrap:wrap' },
          incs.map(function (n) {
            return el('button', {
              class: 'board-btn', text: '+' + n,
              disabled: locked || sum.complete || !canWrite(),
              onclick: function () { push(S, api, 'score', { side: side, n: n }); }
            });
          }))
      ]);
    }));
  }

  /* ----------------------------------------------------------- cricket -- */

  var armed = null;   // an extra waiting for its run count

  function cricketPanel(S, api, sum, sides) {
    var cfg = scoringFor(S);
    if (!sum.innings.length) return cricketStart(S, api, sides);

    var inn = sum.innings[sum.currentInnings];
    var battingName = api.entrantName(sides[inn.battingSide]);
    var chasing = sum.target != null;

    var head = el('div', { class: 'zone', style:
      'border-top-color:var(--live);justify-content:flex-start;padding-top:18px;gap:6px' }, [
      el('div', { class: 'z-name', text: battingName }),
      el('div', { class: 'z-score', style: 'font-size:clamp(46px,15vw,104px)',
        text: inn.runs + '/' + inn.wickets }),
      el('div', { class: 'z-sub', text: '(' + inn.overs + ' of ' + cfg.overs + ' overs)' }),
      chasing && !sum.complete ? el('div', {
        class: 'z-flag', style: 'height:auto;font-size:13px;letter-spacing:.02em',
        text: 'Need ' + sum.need + ' off ' + sum.ballsLeft +
              (sum.required ? '  ·  ' + sum.required.toFixed(2) + ' an over' : '')
      }) : null,
      overStrip(inn),
      cfg.trackPlayers ? playerStrip(S, api, inn) : null
    ]);

    return el('div', { class: 'zones', style: 'grid-template-columns:1fr' }, [
      head,
      el('div', { style: 'background:#0B1716;padding:10px 12px;' +
        'display:flex;flex-direction:column;gap:8px' }, [
        armed ? el('div', { class: 'z-sub', style: 'text-align:center;color:var(--live)',
          text: extraName(armed) + ' — now tap the runs' }) : null,
        runRow(S, api, sum),
        extraRow(S, api, sum)
      ])
    ]);
  }

  function cricketStart(S, api, sides) {
    return el('div', { class: 'zones', style: 'grid-template-columns:1fr' }, [
      el('div', { class: 'zone', style: 'justify-content:center;gap:18px' }, [
        el('div', { class: 'z-name', text: 'Who bats first?' }),
        el('div', { class: 'row', style: 'justify-content:center;gap:10px' },
          ['home', 'away'].map(function (side) {
            return el('button', {
              class: 'board-btn', style: 'padding:12px 18px;font-size:15px',
              text: api.entrantName(sides[side]), disabled: !canWrite(),
              onclick: function () { push(S, api, 'start', { battingFirst: side }); }
            });
          }))
      ])
    ]);
  }

  function overStrip(inn) {
    var balls = inn.thisOver || [];
    return el('div', { style: 'display:flex;gap:5px;flex-wrap:wrap;' +
      'justify-content:center;margin-top:4px;min-height:22px' },
      balls.map(function (b) {
        var txt = b.wicket ? 'W'
          : (b.extra ? (b.extra + (b.runs ? b.runs : '')) : String(b.runs));
        var tone = b.wicket ? 'background:#4A1E1A;color:#F0A89F'
          : b.extra ? 'background:#3A2E12;color:#E0C77A'
          : (b.runs >= 4 ? 'background:#143A32;color:#7FD6BE'
                         : 'background:#182826;color:#9DB5B1');
        return el('span', { style: 'font-family:var(--f-mono);font-size:12px;' +
          'padding:2px 7px;border-radius:4px;' + tone, text: txt });
      }));
  }

  function playerStrip(S, api, inn) {
    function nm(id) {
      var p = S.playersById[id];
      return p ? U.shortName(p.name) : 'pick';
    }
    return el('div', { class: 'row', style: 'justify-content:center;gap:6px;margin-top:6px' }, [
      el('button', { class: 'board-btn', text: '★ ' + nm(inn.striker),
        onclick: function () { pickPlayer(S, api, 'striker'); } }),
      el('button', { class: 'board-btn', text: nm(inn.nonStriker),
        onclick: function () { pickPlayer(S, api, 'nonStriker'); } }),
      el('button', { class: 'board-btn', text: 'Bowl: ' + nm(inn.bowler),
        onclick: function () { pickPlayer(S, api, 'bowler'); } })
    ]);
  }

  function pickPlayer(S, api, role) {
    var sides = api.sidesOf(S.fid);
    var sum = currentSummary(S);
    var inn = sum.innings[sum.currentInnings];
    var battingId = sides[inn.battingSide];
    var bowlingId = sides[inn.battingSide === 'home' ? 'away' : 'home'];
    var entrant = S.entrantsById[role === 'bowler' ? bowlingId : battingId];
    if (!entrant) { U.toast('No squad for that team.', 'warn'); return; }

    U.sheet(role === 'bowler' ? 'Who is bowling?' : 'Who is batting?', function (close) {
      return [el('div', { class: 'stack-s' }, (entrant.members || []).map(function (m) {
        var p = S.playersById[m.playerId];
        return el('button', { class: 'btn btn-block', text: p ? p.name : 'Unknown',
          onclick: function () {
            var payload = {};
            payload[role] = m.playerId;
            push(S, api, 'setPlayers', payload);
            close();
          } });
      }))];
    });
  }

  function currentSummary(S) {
    return E.summarize(engineFor(S), scoringFor(S), eventsFor(S));
  }

  function runRow(S, api, sum) {
    var disabled = !canWrite() || sum.complete;
    return el('div', { class: 'runpad',
      style: 'display:grid;grid-template-columns:repeat(6,1fr);gap:6px' },
      [0, 1, 2, 3, 4, 6].map(function (n) {
        return el('button', {
          class: 'board-btn',
          style: 'justify-content:center;padding:14px 0;font-size:18px;font-weight:800' +
            (n >= 4 ? ';color:#7FD6BE' : ''),
          text: String(n), disabled: disabled,
          onclick: function () { ball(S, api, n); }
        });
      }));
  }

  function extraRow(S, api, sum) {
    var disabled = !canWrite() || sum.complete;
    var items = [['wd', 'Wide'], ['nb', 'No ball'], ['b', 'Bye'], ['lb', 'Leg bye']];
    return el('div', { style: 'display:grid;grid-template-columns:repeat(5,1fr);gap:6px' },
      items.map(function (it) {
        return el('button', {
          class: 'board-btn', style: 'justify-content:center;padding:11px 0',
          'aria-pressed': String(armed === it[0]),
          text: it[0], title: it[1], disabled: disabled,
          onclick: function () {
            if (armed === it[0]) { ball(S, api, 0); }     // commit with no runs
            else { armed = it[0]; api.render(); }
          }
        });
      }).concat([
        el('button', {
          class: 'board-btn',
          style: 'justify-content:center;padding:11px 0;background:#4A1E1A;' +
                 'border-color:#6B2D27;color:#F0A89F;font-weight:800',
          text: 'W', title: 'Wicket', disabled: disabled,
          onclick: function () { wicket(S, api); }
        })
      ]));
  }

  function ball(S, api, runs) {
    var extra = armed;
    armed = null;
    push(S, api, 'ball', { runs: runs, extra: extra, wicket: null });
  }

  function wicket(S, api) {
    var extra = armed;
    armed = null;
    var cfg = scoringFor(S);
    if (!cfg.trackPlayers) {
      push(S, api, 'ball', { runs: 0, extra: extra, wicket: { type: 'out' } });
      return;
    }
    U.sheet('How was the batter out?', function (close) {
      var kinds = ['bowled', 'caught', 'lbw', 'run out', 'stumped', 'hit wicket', 'other'];
      return [el('div', { class: 'stack-s' }, kinds.map(function (k) {
        return el('button', { class: 'btn btn-block', text: k,
          onclick: function () {
            push(S, api, 'ball', { runs: 0, extra: extra, wicket: { type: k } });
            close();
          } });
      }))];
    });
  }

  function extraName(code) {
    return { wd: 'Wide', nb: 'No ball', b: 'Bye', lb: 'Leg bye' }[code] || code;
  }

  function manualPanel(S, api, sum, sides) {
    var hv = sum.current.home, av = sum.current.away;
    return el('div', { class: 'zones', style: 'grid-template-columns:1fr' }, [
      el('div', { class: 'zone', style: 'justify-content:center;gap:16px' }, [
        el('div', { class: 'z-sub', text: 'Type the final score' }),
        el('div', { class: 'row', style: 'justify-content:center;gap:12px' }, [
          el('input', { class: 'input', id: 'sc-h', type: 'number', value: hv,
            style: 'width:90px;text-align:center;font-size:28px;background:#0E1A18;border-color:#243734;color:#F2F7F5' }),
          el('span', { style: 'color:#7A918D', text: '–' }),
          el('input', { class: 'input', id: 'sc-a', type: 'number', value: av,
            style: 'width:90px;text-align:center;font-size:28px;background:#0E1A18;border-color:#243734;color:#F2F7F5' })
        ]),
        el('div', { class: 'row', style: 'justify-content:center;gap:8px' }, [
          el('span', { class: 'z-sub', text: api.entrantName(sides.home) }),
          el('span', { class: 'z-sub', text: ' / ' }),
          el('span', { class: 'z-sub', text: api.entrantName(sides.away) })
        ]),
        el('button', {
          class: 'board-btn', text: 'Save result', disabled: !canWrite(),
          onclick: function () {
            push(S, api, 'setScore', {
              home: Number(document.getElementById('sc-h').value) || 0,
              away: Number(document.getElementById('sc-a').value) || 0
            });
          }
        })
      ])
    ]);
  }

  /* Only one banner can be on screen at a time - they share a position -
   * so they are chosen in order of what matters most right now. */
  function banner(S, api, sum) {
    return endBanner(S, api, sum)
        || readOnlyBanner(S, api)         // another phone has this match
        || serveBanner(S, api, sum)       // names missing, or the first serve
        || detailStrip(S, api, sum)       // how was that point won?
        || restBanner(S, api, sum);       // deuce, change of ends
  }

  /* The zones are disabled while another phone holds the lease, and a
   * disabled button cannot fire the toast that would have explained why -
   * so taps died in silence with only a small word in the top bar to go
   * on. Say it on the board, with the way out beside it. */
  function readOnlyBanner(S, api) {
    if (!readOnly()) return null;
    return el('div', { class: 'board-banner' }, [
      el('div', {}, [
        el('b', { text: 'Someone else is scoring' }),
        el('div', { class: 'bb-sub', text: 'Watching only until you take over.' })
      ]),
      el('button', { class: 'board-btn', text: 'Take over',
        onclick: function () { takeOver(S, api); } })
    ]);
  }

  function endBanner(S, api, sum) {
    if (sum.complete && local.dismissed !== 'end') {
      var sides = api.sidesOf(S.fid);
      var name = api.entrantName(sides[sum.winner]) || sum.winner;
      return el('div', { class: 'board-banner' }, [
        el('div', {}, [
          el('b', { text: sum.winner ? name + ' wins' : 'Drawn' }),
          el('div', { class: 'bb-sub',
            text: (sum.resultText ? sum.resultText + ' · ' : '') + sum.line })
        ]),
        el('button', { class: 'board-btn', text: 'Undo',
          onclick: function () { undo(S, api); } }),
        el('button', { class: 'board-btn', text: 'Next game',
          onclick: function () { nextRubber(S, api); } })
      ]);
    }
    return null;
  }

  function restBanner(S, api, sum) {
    /* Level and deep enough that the target alone will not do it. Offer the
     * golden point here, because this is the only score where calling it
     * changes anything. */
    if (sum.deuce && !sum.golden && local.dismissed !== 'deuce') {
      return el('div', { class: 'board-banner' }, [
        el('div', { style: 'min-width:0' }, [
          el('b', { text: 'Deuce, ' + sum.current.home + '-' + sum.current.away }),
          el('div', { class: 'bb-sub',
            text: 'Two clear points to win' })
        ]),
        el('button', { class: 'board-btn', text: 'Golden point',
          disabled: !canWrite(),
          onclick: function () { push(S, api, 'golden', {}); } }),
        el('button', { class: 'board-btn', text: 'Play on',
          onclick: function () { local.dismissed = 'deuce'; api.render(); } })
      ]);
    }

    if (sum.switchDue && local.dismissed !== 'switch') {
      return el('div', { class: 'board-banner' }, [
        el('div', { text: 'Change ends' }),
        el('button', { class: 'board-btn', text: 'Swap the board',
          onclick: function () {
            setFlipped(S.rid, !isFlipped(S.rid));
            local.dismissed = 'switch'; api.render();
          } }),
        el('button', { class: 'board-btn', text: 'Leave it',
          onclick: function () { local.dismissed = 'switch'; api.render(); } })
      ]);
    }
    return null;
  }

  function bottomRow(S, api, sum, engine) {
    var note = '';
    if (sum.complete) note = (sum.resultText ? sum.resultText + '  ·  ' : '') + sum.line;
    else if (engine === 'cricket') {
      var ci = sum.innings[sum.currentInnings];
      note = ci ? ('Innings ' + (sum.currentInnings + 1) + '  ·  ' +
                   api.entrantName(api.sidesOf(S.fid)[ci.battingSide]) + ' batting') : '';
    }
    else if (engine === 'tennis') {
      note = sum.inTiebreak ? 'Tie-break'
        : 'Sets ' + sum.gamesWon.home + '-' + sum.gamesWon.away +
          '  ·  games ' + sum.gamesNow.home + '-' + sum.gamesNow.away;
    }
    else if (engine === 'rally') {
      note = sum.golden
        ? 'Golden point — the next point wins it'
        : (sum.gamesWon.home || sum.gamesWon.away)
          ? 'Set ' + (sum.games || []).length + ' to ' + sum.target +
            '  ·  sets ' + sum.gamesWon.home + '-' + sum.gamesWon.away
          : 'First to ' + sum.target +
            ((sum.winBy || 1) > 1 ? ', two clear' : '');
      // The call a pickleball server shouts before serving: us, them, server.
      if (sum.callScore) note = 'Call ' + sum.callScore + '  ·  ' + note;
    }

    var r = S.rubber;
    var order = S.rubbers.slice().sort(function (a, b) { return a.order - b.order; });

    // Tap the rules to change them for THIS game only - "we played this
    // one to 30" should not mean redoing the tournament settings.
    var noteEl = (engine === 'rally' || engine === 'tennis')
      ? el('button', { class: 'board-note board-note-tap',
          text: note + '  ·  change',
          onclick: function () {
            TS.settings.matchRules(S, api, S.rubber, scoringFor(S), function () {
              api.render();
            });
          } })
      : el('div', { class: 'board-note', text: note });

    var controls = [
      el('button', {
        class: 'board-ctl',
        disabled: !canWrite() || !E.lastUndoableId(local.events),
        onclick: function () { undo(S, api); }
      }, ctl('↺', 'Undo')),
      el('button', {
        class: 'board-ctl',
        title: 'Put the other team on the left',
        onclick: function () { setFlipped(S.rid, !isFlipped(S.rid)); api.render(); }
      }, ctl('⇄', 'Swap sides')),
      // In doubles the serve is the thing most often set wrong at the start.
      (serveTracked(S) && (r.homePlayers || []).length > 1 &&
       (sum.engine === 'rally' || sum.engine === 'tennis')) ? el('button', {
        class: 'board-ctl',
        onclick: function () { serveFix(S, api); }
      }, ctl('●', 'Edit server')) : null,
      // An innings can also be closed early - a declaration, or rain.
      (engine === 'cricket' && !sum.complete && sum.innings.length) ? el('button', {
        class: 'board-ctl', text: 'End innings', disabled: !canWrite(),
        onclick: function () {
          U.confirmSheet({
            title: 'Close this innings?',
            message: 'Use this for a declaration, or when an innings is cut short. ' +
                     'The innings ends on its own at the overs limit or all out.',
            confirmLabel: 'Close innings'
          }).then(function (yes) { if (yes) push(S, api, 'endInnings', { declared: true }); });
        }
      }) : null,
      // A running count has no winning score, so it needs a full-time
      // whistle before the result can reach the table.
      (engine === 'tally' && !sum.complete) ? el('button', {
        class: 'board-ctl', text: 'Full time', disabled: !canWrite(),
        onclick: function () {
          U.confirmSheet({
            title: 'End the game?',
            message: 'The score stands at ' + sum.current.home + '–' +
                     sum.current.away + '. This puts it into the table.',
            confirmLabel: 'End game'
          }).then(function (yes) { if (yes) push(S, api, 'end', {}); });
        }
      }) : null,
      /* "Fix" sounded like something had gone wrong. This is where the
       * score, the players, the recording level and a walkover all live,
       * and most of that is setting the game up, not repairing it. */
      el('button', { class: 'board-ctl',
        onclick: function () { corrections(S, api, sum); } },
        ctl('✎', 'Edit game')),
      /* "Lock" on its own read as locking the RESULT. What it locks is
       * the screen, against a pocket or a lean on the table. */
      el('button', {
        class: 'board-ctl', 'aria-pressed': String(locked),
        title: 'Stop the board responding to taps',
        onclick: function () { locked = !locked; api.render(); }
      }, ctl(locked ? '⊘' : '○', locked ? 'Taps locked' : 'Lock taps')),
      /* Last, and set apart, because it is the one that leaves. */
      el('button', { class: 'board-ctl board-ctl-done',
        onclick: function () {
          // A match holding one game opens straight onto this board, so
          // going "back" to it would bounce right here again.
          leave(S, api);
          if (order.length > 1) api.go('fixture', { fid: S.fid, meeting: true });
          else { api.openFixture(null); api.go('hub', { tab: 'matches' }); }
        } }, ctl('✓', 'Done'))
    ];

    return el('div', { class: 'board-bottom' }, [
      noteEl,
      el('div', { class: 'board-controls' }, controls)
    ]);
  }

  function undo(S, api) {
    var id = E.lastUndoableId(local.events);
    if (!id) return;
    push(S, api, 'undo', { targetEventId: id });
  }

  function nextRubber(S, api) {
    var order = S.rubbers.slice().sort(function (a, b) { return a.order - b.order; });
    var i = order.findIndex ? order.findIndex(function (r) { return r.id === S.rid; }) : -1;
    if (i < 0) { for (var k = 0; k < order.length; k++) if (order[k].id === S.rid) i = k; }
    var next = order.slice(i + 1).filter(function (r) {
      var s = (S.fixturesById[S.fid].rubberSummary || {})[r.id];
      return !(s && s.complete);
    })[0];
    flush(S, api, true);
    leave(S, api);
    if (next) api.go('score', { rid: next.id, fid: S.fid });
    else if (order.length > 1) api.go('fixture', { fid: S.fid, meeting: true });
    else { api.openFixture(null); api.go('hub', { tab: 'matches' }); }
  }

  /* Corrections: the umpire was wrong, or the match never happened. */
  function corrections(S, api, sum) {
    var sides = api.sidesOf(S.fid);

    U.sheet('Edit this game', function (close) {
      var host = el('div', { class: 'stack' });

      /* Take a point off, or put one back, on either side - the umpire was
       * wrong, or a tap landed on the wrong half. Undo only ever reaches
       * the last point, which is not always the one that was wrong. */
      function bump(i, side, delta) {
        var now = currentSummary(S);
        var g = (now.games || [])[i];
        if (!g) return;
        var payload = { gameIndex: i, home: g.home, away: g.away };
        payload[side] = Math.max(0, (g[side] || 0) + delta);
        push(S, api, 'setScore', payload);
        paint();
      }

      function stepper(i, g, side) {
        return el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, [
          el('span', { class: 'spacer', style:
            'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
            text: api.entrantName(sides[side]) }),
          el('button', { class: 'btn btn-sm', 'aria-label': 'one less',
            text: '−', onclick: function () { bump(i, side, -1); } }),
          el('b', { class: 'num', style: 'min-width:34px;text-align:center;font-size:17px',
            text: String(g[side] || 0) }),
          el('button', { class: 'btn btn-sm', 'aria-label': 'one more',
            text: '+', onclick: function () { bump(i, side, 1); } })
        ]);
      }

      function paint() {
        var now = currentSummary(S);
        var blocks = [];

        (now.games || []).forEach(function (g, i) {
          blocks.push(el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
            el('div', { class: 'eyebrow', text:
              (now.games.length > 1 ? 'Set ' + (i + 1) : 'The score') }),
            stepper(i, g, 'home'),
            stepper(i, g, 'away')
          ]));
        });

        if ((now.engine === 'rally' || now.engine === 'tennis') && serveTracked(S)) {
          blocks.push(el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
            el('div', { class: 'eyebrow', text: 'Serving' }),
            el('button', { class: 'btn btn-block', text: 'Change who is serving',
              onclick: function () { close(); serveFix(S, api); } }),
            el('button', { class: 'btn btn-block btn-sm',
              text: 'Stop tracking serve in this game',
              onclick: function () { close(); stopTrackingServe(S, api); } })
          ]));
        }

        blocks.push(el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
          el('div', { class: 'eyebrow', text: 'The board' }),
          el('button', { class: 'btn btn-block',
            text: isFlipped(S.rid)
              ? 'Put ' + api.entrantName(sides.home) + ' back on the left'
              : 'Put ' + api.entrantName(sides.away) + ' on the left',
            onclick: function () {
              setFlipped(S.rid, !isFlipped(S.rid)); close(); api.render();
            } }),
          el('p', { class: 'tiny muted', text:
            'For when the players change ends. Only moves the board on this ' +
            'phone — the scores stay with their teams.' })
        ]));

        blocks.push(el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
          el('div', { class: 'eyebrow', text: 'Players' }),
          el('button', { class: 'btn btn-block', text: 'Change who is playing',
            onclick: function () { close(); lineupSheet(S, api); } })
        ]));

        U.mount(host, blocks.concat(extras(S, api, sides, close)));
      }

      paint();
      return host;
    });
  }

  /* How much gets recorded about each point. This is a SCORING decision,
   * so it is asked here and not buried in a setup screen somebody filled
   * in before they had thought about it. It applies to the whole
   * tournament, which the note says out loud. */
  /* A sheet is deliberately NOT rebuilt when the app re-renders behind it,
   * so that a snapshot landing mid-edit cannot close it under anyone's
   * hands. The cost is that anything chosen inside one has to repaint
   * itself - and until this did, tapping Pro saved Pro, toasted Pro, and
   * left Advance looking selected. The setting worked; the screen said it
   * had not, which is the same thing to whoever is holding the phone. */
  function recordingLevel(S, api) {
    var levels = TS.analysis.LEVELS;
    var host = el('div', { class: 'stack-s', style: 'margin-bottom:16px' });

    function paint() {
      var now = (S.tournament.config || {}).detail || 'none';
      U.mount(host, [
        el('div', { class: 'eyebrow', text: 'How much to record' }),
        el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
          levels.map(function (lv) {
            return el('button', {
              class: 'btn btn-sm' + (now === lv.id ? ' btn-primary' : ''),
              text: lv.label,
              onclick: function () {
                if (now === lv.id) return;
                var t = JSON.parse(JSON.stringify(S.tournament));
                t.config.detail = lv.id;
                api.saveTournament(t).then(function () {
                  paint();
                  api.recompute(); api.render();
                  U.toast(lv.label + ' — ' + lv.hint.toLowerCase());
                });
              }
            });
          })),
        el('p', { class: 'tiny muted', text:
          (levels.filter(function (l) { return l.id === now; })[0] || levels[0]).hint +
          '  ·  Applies to every game in the tournament.' })
      ]);
    }
    paint();
    return host;
  }

  function extras(S, api, sides, close) {
    return [
      recordingLevel(S, api),
      el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
        el('div', { class: 'eyebrow', text: 'Award the game' }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-sm', text: api.entrantName(sides.home),
            onclick: function () {
              push(S, api, 'award', { side: 'home', reason: 'walkover' }); close();
            } }),
          el('button', { class: 'btn btn-sm', text: api.entrantName(sides.away),
            onclick: function () {
              push(S, api, 'award', { side: 'away', reason: 'walkover' }); close();
            } })
        ]),
        el('p', { class: 'tiny muted', text: 'For a walkover or a retirement.' })
      ]),

      el('div', { class: 'stack-s' }, [
        el('div', { class: 'eyebrow', text: 'Not played' }),
        el('button', { class: 'btn btn-sm btn-danger', text: 'Mark as not played',
          onclick: function () {
            var copy = JSON.parse(JSON.stringify(S.rubber));
            copy.status = M.STATUS.NOT_PLAYED;
            copy.summary = { complete: false, status: M.STATUS.NOT_PLAYED,
                             current: { home: 0, away: 0 }, line: 'not played' };
            var fstatus = fixtureStatus(S, copy.fixtureId, copy.id, copy.summary);
            api.saveRubber(copy).then(function () {
              return api.patchFixtureRubber(copy.fixtureId, copy.id,
                { status: M.STATUS.NOT_PLAYED, complete: false }, fstatus);
            }).then(function () {
              close(); leave(S, api);
              api.openFixture(null); api.go('hub', { tab: 'matches' });
            });
          } }),
        el('p', { class: 'tiny muted', text:
          'A game the teams skipped, or a dead one. It is left out of the table.' })
      ])
    ];
  }

  /* If the rotation ever drifts from what happened on court, name the
   * player who should be serving and everything re-derives around them. */
  function serveFix(S, api) {
    var sum = currentSummary(S);
    var sides = api.sidesOf(S.fid);
    var r = S.rubber;

    U.sheet('Who is serving?', function (close) {
      function ids(side) { return (side === 'home' ? r.homePlayers : r.awayPlayers) || []; }
      function nameOf(side, i) {
        var p = S.playersById[ids(side)[i]];
        return p ? p.name : 'Player ' + (i + 1);
      }

      var out = [el('p', { class: 'small muted', style: 'margin-bottom:14px', text:
        'Tap whoever should be serving the next point. The receiver and the ' +
        'court follow from that, and the rest of the rotation corrects itself.' })];

      ['home', 'away'].forEach(function (side) {
        var list = ids(side);
        if (!list.length) return;
        out.push(el('div', { class: 'stack-s', style: 'margin-bottom:14px' }, [
          el('div', { class: 'eyebrow', text: api.entrantName(sides[side]) })
        ].concat(list.map(function (pid, i) {
          var isServer = sum.serving === side && sum.serverIndex === i;
          return el('button', {
            class: 'btn btn-block' + (isServer ? ' btn-primary' : ''),
            text: nameOf(side, i) + (isServer ? '  ·  serving from the ' + sum.serveCourt : ''),
            onclick: function () {
              push(S, api, 'serve', { side: side, serverIndex: i });
              close();
            }
          });
        }))));
      });

      var recvSide = sum.serving === 'home' ? 'away' : 'home';
      if (ids(recvSide).length > 1 && sum.receiverIndex != null) {
        var otherIdx = sum.receiverIndex === 0 ? 1 : 0;
        out.push(el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'Receiving' }),
          el('div', { class: 'row' }, [
            el('span', { class: 'spacer',
              text: nameOf(recvSide, sum.receiverIndex) + ' is receiving' }),
            el('button', { class: 'btn btn-sm',
              text: 'It is ' + nameOf(recvSide, otherIdx),
              onclick: function () {
                push(S, api, 'serve', { receiverIndex: otherIdx });
                close();
              } })
          ])
        ]));
      }
      return out;
    });
  }

  /* Substitutions. The lineup lives on the fixture, not on the player, so a
   * change here never rewrites the squad. */
  /* Names are typed here, at the match, because that is usually when they
   * are known. Anyone new is added to that team's squad on the way past, so
   * nobody is ever entered twice and the leaderboard still adds up. */
  function lineupSheet(S, api) {
    var r = S.rubber;
    var sides = api.sidesOf(S.fid);

    U.sheet('Who is playing this game?', function (close) {
      var fields = { home: [], away: [] };
      var out = [el('p', { class: 'small muted', style: 'margin-bottom:16px', text:
        'Tap a name from the squad, or type a new one. Anyone not in the ' +
        'squad yet is added to it, so you only enter them once for the ' +
        'whole tournament.' })];

      ['home', 'away'].forEach(function (side) {
        var entrant = S.entrantsById[sides[side]];
        var slots = (side === 'home' ? r.homeSlots : r.awaySlots) || [];
        var current = (side === 'home' ? r.homePlayers : r.awayPlayers) || [];
        // Singles wants one name, doubles two. Only fall back to guessing
        // when the match has no type of its own.
        var need = M.playersNeeded(r.kind);
        var howMany = need || Math.max(slots.length, current.length, 1);
        var listId = 'squad-' + side + '-' + r.id;
        var rows = [];

        for (var i = 0; i < howMany; i++) {
          var p = current[i] ? S.playersById[current[i]] : null;
          var box = U.input({
            value: p ? p.name : '', placeholder: 'Name',
            list: listId, autocomplete: 'off', autocapitalize: 'words'
          });
          fields[side].push(box);
          rows.push(U.field((slots[i] || ('Player ' + (i + 1))) + ' (optional)', box));
        }

        /* The squad as tappable names. A datalist alone is invisible
         * until you start typing and barely exists on a phone, so a team
         * with eleven players already entered still looked as though the
         * app had never heard of them. */
        var dl = el('datalist', { id: listId },
          ((entrant && entrant.members) || []).map(function (m) {
            var pl = S.playersById[m.playerId];
            return pl ? el('option', { value: pl.name }) : null;
          }).filter(Boolean));

        var boxes = fields[side];
        var squad = ((entrant && entrant.members) || []).map(function (m) {
          var pl = S.playersById[m.playerId];
          return pl ? { name: pl.name, slot: m.slot } : null;
        }).filter(Boolean);

        var picker = squad.length ? el('div', { class: 'stack-s' }, [
          el('div', { class: 'tiny muted', text: 'Tap a name from the squad' }),
          el('div', { class: 'chiplist' }, squad.map(function (p) {
            return el('button', {
              class: 'btn btn-sm', type: 'button',
              text: p.slot ? p.slot + ' ' + p.name : p.name,
              onclick: function () {
                // Into the first empty box, or the last one when they are
                // all taken - a second tap should correct, not do nothing.
                var target = null, j;
                for (j = 0; j < boxes.length; j++) {
                  if (!(boxes[j].value || '').trim()) { target = boxes[j]; break; }
                }
                if (!target) target = boxes[boxes.length - 1];
                if (target) { target.value = p.name; target.focus(); }
              }
            });
          }))
        ]) : null;

        out.push(el('div', { class: 'stack-s', style: 'margin-bottom:18px' }, [
          el('div', { class: 'eyebrow', text: entrant ? entrant.name : side }), dl
        ].concat(rows).concat([picker])));
      });

      out.push(el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-primary', text: 'Save',
          onclick: function () { saveLineup(S, api, fields, sides, close); } }),
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
      ]));
      return out;
    });
  }

  function saveLineup(S, api, fields, sides, close) {
    var t = JSON.parse(JSON.stringify(S.tournament));
    var rubber = JSON.parse(JSON.stringify(S.rubber));
    var added = 0;

    ['home', 'away'].forEach(function (side) {
      var entrant = (t.entrants || []).filter(function (e) {
        return e.id === sides[side];
      })[0];
      var slots = (side === 'home' ? rubber.homeSlots : rubber.awaySlots) || [];
      var ids = [];
      fields[side].forEach(function (box, i) {
        var name = (box.value || '').trim();
        if (!name) return;
        var found = M.findOrAddPlayer(t, entrant, name, slots[i]);
        if (found.created) added += 1;
        ids.push(found.id);
      });
      if (side === 'home') rubber.homePlayers = ids;
      else rubber.awayPlayers = ids;
    });

    api.saveTournament(t)
      .then(function () { return api.saveRubber(rubber); })
      .then(function () {
        close(); api.recompute(); api.render();
        if (added) {
          U.toast(added + ' player' + (added > 1 ? 's' : '') + ' added to the squad.');
        }
      });
  }

  /* Matched within the team only: two teams may each have a Dev, and they
   * are not the same person. */
  TS.score = { render: render, leave: leave, mergeEvents: mergeEvents };

})(window.TS = window.TS || {});
