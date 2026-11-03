/* Tournament Scorer - app shell, routing and live data
 *
 * Navigation is in-page state rather than URL routing: the artifact frame
 * only ever hands the page a bare "#token" on load and never reflects the
 * page's own URL changes, so a path-shaped hash would be a lie. "#selftest"
 * is honoured on load because it is exactly that: one bare token.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model;

  var S = {
    /* THE CHOOSER IS THE FRONT DOOR, every time the app is opened.
     * Not the list: three people open this link wanting three
     * different things, and the list answers only one of them. */
    screen: 'welcome',
    booted: false,
    info: { mode: 'local', role: 'admin', canEdit: true },
    pending: 0,

    tournaments: [],
    tid: null, tournament: null,
    entrants: [], players: [], fixtures: [],
    fid: null, rubbers: [], rubbersLoaded: false,
    rid: null, rubber: null, rubberLoaded: false,

    tab: 'matches',
    stageId: null,
    groupId: null,

    entrantsById: {}, playersById: {}, fixturesById: {},
    resolved: null,
    loading: true,
    wizard: null
  };

  var subs = { list: [], tour: [], fix: [], rub: [] };

  function drop(scope) {
    (subs[scope] || []).forEach(function (f) { try { f(); } catch (e) {} });
    subs[scope] = [];
  }

  /* Entrants and players live INSIDE the tournament document: the organiser
   * writes them once at setup, and 132 separate documents would be 132
   * sequential writes for no benefit. Fixtures and rubbers are their own
   * documents because scorers write those, from different phones at once. */
  function paths(tid) {
    var b = 'tournaments/' + tid;
    return { doc: b, fixtures: b + '/fixtures', rubbers: b + '/rubbers' };
  }

  /* ------------------------------------------------------------- derive -- */

  function index() {
    S.entrantsById = {}; S.playersById = {}; S.fixturesById = {};
    S.entrants.forEach(function (e) { S.entrantsById[e.id] = e; });
    S.players.forEach(function (p) { S.playersById[p.id] = p; });
    S.fixtures.forEach(function (f) { S.fixturesById[f.id] = f; });
  }

  /* The store hands rows back in the order it happens to hold them, which
   * listed the semi-finals SF2 before SF1 and let the round-robin list
   * shuffle itself between renders. Sorting here means every screen sees
   * one order. Labels sort as text on purpose: SF1 before SF2, QF1 before
   * QF4, and anything unlabelled falls through to the id so it is at least
   * stable. */
  function byFixture(a, b) {
    var ra = a.round == null ? 0 : a.round, rb = b.round == null ? 0 : b.round;
    if (ra !== rb) return ra - rb;
    var oa = a.order == null ? 0 : a.order, ob = b.order == null ? 0 : b.order;
    if (oa !== ob) return oa - ob;
    var la = a.shortLabel || '', lb = b.shortLabel || '';
    if (la !== lb) return la < lb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /* A meeting whose matches are all played but which is still marked
   * "scheduled" cannot have happened, so it is a dropped write - the score
   * reached the store and the status did not. Until this was fixed at the
   * source, every played meeting ended up this way, which left the table
   * empty. Correcting it on load rescues those tournaments; a meeting that
   * is genuinely unfinished is left alone, and nothing is written when
   * there is nothing to correct. */
  var healed = {};
  function healStatuses() {
    if (!S.tournament) return;
    S.fixtures.forEach(function (f) {
      if (healed[f.id]) return;
      if (M.countsForStandings(f.status) || f.status === M.STATUS.NOT_PLAYED ||
          f.status === M.STATUS.VOID || f.status === M.STATUS.BYE) return;
      var total = f.matchCount == null
        ? TS.matches.defaultMatchCount(S.tournament)
        : f.matchCount;
      if (total < 1) total = 1;
      var map = f.rubberSummary || {};
      var done = 0;
      Object.keys(map).forEach(function (k) {
        var s = map[k];
        if (s && (s.complete || s.status === M.STATUS.NOT_PLAYED)) done += 1;
      });
      if (done < total) return;
      healed[f.id] = true;
      // Only the store is written: the row itself is a frozen snapshot,
      // and assigning to it throws. The corrected status arrives back on
      // the next snapshot, one round trip later.
      TS.store.update(paths(S.tid).fixtures + '/' + f.id,
        { status: M.STATUS.COMPLETED })['catch'](function () { /* read-only viewer */ });
    });
  }

  function makeResult(f, homeId, awayId) {
    return TS.standings.tieResult({
      fixture: f,
      template: S.tournament.config.tieTemplate,
      summaries: f.rubberSummary || {},
      homeId: homeId, awayId: awayId
    });
  }

  function recompute() {
    index();
    if (!S.tournament) { S.resolved = null; return; }
    try {
      S.resolved = TS.progression.resolveTournament({
        tournament: S.tournament,
        entrants: S.entrants,
        fixtures: S.fixtures,
        makeResult: makeResult,
        adjustments: S.tournament.adjustments || [],
        adjudications: S.tournament.adjudications || {}
      });
    } catch (e) {
      if (window.console) console.error(e);
      S.resolved = null;
    }
  }

  // The two entrants actually playing a fixture, resolved or not.
  function sidesOf(fixtureId) {
    return (S.resolved && S.resolved.sides[fixtureId]) || { home: null, away: null };
  }

  function entrantName(id, fallback) {
    var e = S.entrantsById[id];
    return e ? e.name : (fallback || 'TBD');
  }

  function sideLabel(fixture, side) {
    var s = sidesOf(fixture.id);
    if (s[side]) return entrantName(s[side]);
    return M.refLabel(fixture[side], S.tournament);
  }

  /* --------------------------------------------------------- navigation -- */

  function go(screen, params) {
    params = params || {};
    /* The chooser is a sibling of the list, not a step in front of it,
     * so arriving at either one lets go of whatever was open. */
    if (screen === 'home' || screen === 'welcome') {
      drop('tour'); drop('fix'); drop('rub');
      S.tid = null; S.tournament = null; S.fid = null; S.rid = null;
      S.entrants = []; S.players = []; S.fixtures = []; S.rubbers = [];
      watchList();
    }
    if (params.tid && params.tid !== S.tid) { openTournament(params.tid); }
    // Moving between matches of the SAME tie must not drop the rubber
    // subscription: it would blank the list the match switcher reads from.
    if ('fid' in params && params.fid !== S.fid) openFixture(params.fid);
    if ('rid' in params) openRubber(params.rid);
    // A meeting with one match is just that match, so opening it jumps
    // straight to the scoreboard. `meeting: true` asks for the meeting
    // screen itself, to add matches to it.
    if (screen === 'fixture') S.showMeeting = !!params.meeting;
    if (params.tab) S.tab = params.tab;
    if ('stageId' in params) S.stageId = params.stageId;
    if ('groupId' in params) S.groupId = params.groupId;
    S.screen = screen;
    render();
  }

  /* ----------------------------------------------------- subscriptions -- */

  function watchList() {
    drop('list');
    S.loading = true;
    subs.list.push(TS.store.watchCollection('tournaments', {}, function (rows) {
      S.tournaments = (rows || []).map(M.migrate).sort(function (a, b) {
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
      S.loading = false;
      /* The chooser reads the list too - how many tournaments there
       * are decides where each answer lands - so it repaints when the
       * list arrives, exactly as the list itself does. */
      if (S.screen === 'home' || S.screen === 'welcome') render();
    }));
  }

  function openTournament(tid) {
    drop('tour'); drop('fix'); drop('rub');
    /* Who you are here is not who you were on the last one. */
    TS.store.useTournament(tid);
    S.tid = tid; S.tournament = null;
    S.entrants = []; S.players = []; S.fixtures = []; S.rubbers = [];
    S.loading = true;
    var p = paths(tid);

    S.tournamentLoaded = false;
    subs.tour.push(TS.store.watchDoc(p.doc, function (d) {
      S.tournament = d ? M.migrate(d) : null;
      S.tournamentLoaded = true;
      S.entrants = (S.tournament && S.tournament.entrants) || [];
      S.players = (S.tournament && S.tournament.players) || [];
      if (S.tournament && !S.stageId && (S.tournament.stages || []).length) {
        S.stageId = S.tournament.stages[0].id;
      }
      S.loading = false;
      recompute(); render();
    }));
    S.fixturesLoaded = false;
    subs.tour.push(TS.store.watchCollection(p.fixtures, {}, function (rows) {
      S.fixtures = (rows || []).slice().sort(byFixture);
      S.fixturesLoaded = true;
      healStatuses();
      recompute(); render();
    }));
  }

  function openFixture(fid) {
    drop('fix'); drop('rub');
    S.fid = fid; S.rubbers = [];
    // Until the store has answered, we do not know whether this meeting
    // already has its matches. Creating them on an empty-but-unloaded list
    // is how a tie ended up with four copies of every match.
    S.rubbersLoaded = false;
    if (!fid || !S.tid) return;
    subs.fix.push(TS.store.watchCollection(paths(S.tid).rubbers,
      { where: [['fixtureId', '==', fid]] }, function (rows) {
        S.rubbers = (rows || []).slice().sort(function (a, b) { return a.order - b.order; });
        S.rubbersLoaded = true;
        render();
      }));
  }

  function openRubber(rid) {
    drop('rub');
    S.rid = rid; S.rubber = null;
    // "Still loading" and "no longer exists" look identical otherwise, and
    // the second one has to offer a way out.
    S.rubberLoaded = false;
    if (!rid || !S.tid) return;
    subs.rub.push(TS.store.watchDoc(paths(S.tid).rubbers + '/' + rid, function (d) {
      S.rubber = d;
      S.rubberLoaded = true;
      render();
    }));
  }

  /* ------------------------------------------------------------ writes -- */

  function saveTournament(t) {
    S.tournament = t;
    // Reflect it locally at once rather than waiting for the snapshot, so a
    // name typed courtside appears the moment it is saved.
    S.entrants = t.entrants || [];
    S.players = t.players || [];
    index();
    return TS.store.set(paths(t.id).doc, t).catch(writeFailed);
  }

  function saveFixture(f) {
    return TS.store.set(paths(S.tid).fixtures + '/' + f.id, f).catch(writeFailed);
  }

  function saveRubber(r) {
    return TS.store.set(paths(S.tid).rubbers + '/' + r.id, r).catch(writeFailed);
  }

  /* Eleven scorers write eleven different keys of one fixture document.
   * Nested merge keeps them from clobbering each other. */
  function patchFixtureRubber(fixtureId, rubberId, summary, status, played) {
    var patch = { rubberSummary: {} };
    patch.rubberSummary[rubberId] = summary;
    if (status) patch.status = status;
    if (played) patch.resolved = played;
    return TS.store.update(paths(S.tid).fixtures + '/' + fixtureId, patch)
      .catch(writeFailed);
  }

  function writeFailed(e) {
    var code = e && e.code;
    if (code === 'invalid_argument') {
      U.toast('You have view-only access, so scores cannot be saved.', 'bad');
    } else if (code === 'quota_exceeded') {
      U.toast((e && e.message) || 'Storage is full.', 'bad');
    } else {
      U.toast('That change could not be saved. It is kept on this device and will sync when the connection is back.', 'warn');
    }
    if (window.console) console.warn(e);
  }

  /* ------------------------------------------------------------ render -- */

  function render() {
    var root = document.getElementById('root');
    if (!root) return;
    if (S.screen === 'score') { TS.score.render(S, api); return; }
    // The overlay is deliberately NOT cleared here: a live snapshot arriving
    // while a sheet is open must not close it under the user's hands.
    var body;
    switch (S.screen) {
      case 'selftest': body = renderSelftest(); break;
      case 'wizard':   body = TS.setup.render(S, api); break;
      case 'fixture':  body = TS.views.fixture(S, api); break;
      case 'hub':      body = TS.views.hub(S, api); break;
      case 'welcome':  body = TS.views.welcome(S, api); break;
      default:         body = TS.views.home(S, api); break;
    }
    U.mount(root, body);
    window.scrollTo(0, 0);
  }

  // Render without resetting scroll - used after an in-place change.
  function repaint() {
    var root = document.getElementById('root');
    if (!root) return;
    var y = window.scrollY;
    if (S.screen === 'score') { TS.score.render(S, api); return; }
    var body;
    switch (S.screen) {
      case 'selftest': body = renderSelftest(); break;
      case 'wizard':   body = TS.setup.render(S, api); break;
      case 'fixture':  body = TS.views.fixture(S, api); break;
      case 'hub':      body = TS.views.hub(S, api); break;
      case 'welcome':  body = TS.views.welcome(S, api); break;
      default:         body = TS.views.home(S, api); break;
    }
    U.mount(root, body);
    window.scrollTo(0, y);
  }

  function renderSelftest() {
    var host = U.el('div');
    var out = U.el('div');
    var wrap = U.el('div', { class: 'wrap' }, [
      U.el('div', { style: 'margin-bottom:20px' }, [
        U.el('div', { class: 'eyebrow', text: 'Self test' }),
        U.el('h1', { text: 'Scoring and table logic' })
      ]),
      U.el('p', { class: 'muted small', style: 'margin-bottom:20px', text:
        'Every rule the app relies on, checked against the pure logic. Run this after any change.' }),
      out
    ]);
    host.appendChild(topbar('Self test', null, null,
      { label: 'Tournaments', onclick: function () { go('home'); } }));
    host.appendChild(wrap);
    setTimeout(function () { TS.selftest.render(out); }, 0);
    return host;
  }

  /* `back` is {label, onclick} and sits to the LEFT of the title, in the
   * same place on every screen, because that is where a thumb goes
   * looking for the way out. Actions stay on the right. */
  function topbar(title, subtitle, actions, back) {
    return U.el('div', { class: 'topbar' }, [
      U.el('div', { class: 'topbar-in' }, [
        back ? U.el('button', {
          class: 'topbar-back', type: 'button',
          'aria-label': 'Back to ' + (back.label || 'the last screen'),
          onclick: back.onclick
        }, [
          U.el('span', { class: 'tb-chev', text: '‹' }),
          U.el('span', { text: back.label || 'Back' })
        ]) : null,
        U.el('div', { class: 'title' }, [
          U.el('b', { text: title }),
          subtitle ? U.el('span', { text: subtitle }) : null
        ])
      ].concat(actions || []).concat([U.themeToggle()]))
    ]);
  }

  /* -------------------------------------------------------------- boot -- */

  function boot() {
    var root = document.getElementById('root');
    U.mount(root, U.el('div', { class: 'wrap' }, [
      U.el('p', { class: 'muted', text: 'Opening your scorebook...' })
    ]));

    TS.store.init().then(function (info) {
      S.info = info;
      S.booted = true;
      /* The role lands after a round trip, and every screen is drawn
       * from it - so a screen drawn before it arrives has to be drawn
       * again, not left showing controls that will refuse. */
      TS.store.onRole(function () {
        S.info = TS.store.info();
        if (S.booted) render();
      });
      TS.store.onPending(function (n) {
        if (n !== S.pending) { S.pending = n; if (S.booted) repaint(); }
      });
      var token = (location.hash || '').replace(/^#/, '');
      if (token === 'selftest') { S.screen = 'selftest'; render(); return; }
      watchList();
      render();
    });
  }

  var api = {
    state: S,
    go: go,
    render: render,
    repaint: repaint,
    topbar: topbar,
    paths: paths,
    sidesOf: sidesOf,
    sideLabel: sideLabel,
    entrantName: entrantName,
    makeResult: makeResult,
    recompute: recompute,
    saveTournament: saveTournament,
    saveFixture: saveFixture,
    saveRubber: saveRubber,
    patchFixtureRubber: patchFixtureRubber,
    writeFailed: writeFailed,
    openFixture: openFixture,
    openRubber: openRubber,
    openTournament: openTournament,
    watchList: watchList
  };

  TS.app = api;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window.TS = window.TS || {});
