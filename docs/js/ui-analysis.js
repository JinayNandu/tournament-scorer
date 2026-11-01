/* Tournament Scorer - the analysis tab
 *
 * Only exists when the tournament is recording how points end. Reads every
 * match's event log once, on demand, and caches it - the detail lives in
 * the rubber documents, which the rest of the app deliberately never loads
 * in bulk.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, A = TS.analysis, el = U.el;

  var cache = { tid: null, rubbers: null, loading: false };

  function invalidate() { cache = { tid: null, rubbers: null, loading: false }; }

  function panel(S, api) {
    if (A.levelOf(S.tournament) === 'none') {
      return U.empty('Not recording any detail',
        'Switch the tournament to Advance or Pro in Settings and the app will ' +
        'ask how each point ended, then show it all here.',
        el('button', { class: 'btn btn-primary', text: 'Open settings',
          onclick: function () { TS.settings.sheet(S, api); } }));
    }

    if (cache.tid !== S.tid) {
      if (!cache.loading) {
        cache.loading = true;
        TS.store.list('tournaments/' + S.tid + '/rubbers').then(function (rows) {
          cache = { tid: S.tid, rubbers: rows || [], loading: false };
          if (S.tab === 'analysis') api.render();
        }).catch(function () { cache.loading = false; });
      }
      return el('div', { class: 'card' }, [
        el('p', { class: 'muted', text: 'Reading every game...' })
      ]);
    }

    var matches = buildMatches(S, cache.rubbers);
    var totals = A.aggregate(matches);

    if (!totals.overall.points) {
      return U.empty('Nothing recorded yet',
        'Score a few points and tap how each one ended. It adds up here.');
    }

    return el('div', { class: 'stack' }, [
      headline(S, totals),
      shotTable(S, totals.overall),
      teamTable(S, api, totals),
      playerTable(S, totals),
      extras(S, matches),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Reload',
          onclick: function () { invalidate(); api.render(); } })
      ])
    ]);
  }

  /* Each rubber paired with who was actually playing it. */
  function buildMatches(S, rubbers) {
    return (rubbers || []).map(function (r) {
      var f = S.fixturesById[r.fixtureId];
      var sides = f ? TS.app.sidesOf(f.id) : { home: null, away: null };
      return {
        events: r.events || [],
        label: r.label,
        homeEntrantId: sides.home, awayEntrantId: sides.away,
        homePlayers: r.homePlayers || [], awayPlayers: r.awayPlayers || []
      };
    }).filter(function (m) { return (m.events || []).length; });
  }

  function headline(S, totals) {
    var o = totals.overall;
    var pct = o.points ? Math.round((o.winners / o.points) * 100) : 0;
    return el('div', { class: 'card stack-s' }, [
      el('div', { class: 'eyebrow', text: 'Points recorded' }),
      el('div', { style: 'font-stretch:112%;font-weight:800;font-size:28px',
        text: String(o.points) }),
      el('p', { class: 'small muted', text:
        o.winners + ' won outright, ' + o.errors + ' given away — ' +
        pct + '% of points were earned rather than gifted.' })
    ]);
  }

  function shotTable(S, tally) {
    var rows = Object.keys(tally.shots).map(function (id) {
      var s = A.shotById(S.tournament, id);
      return { id: id, label: (s && s.label) || id,
               kind: (s && s.kind) || 'winner', n: tally.shots[id] };
    }).sort(function (a, b) { return b.n - a.n; });

    return el('div', { class: 'stack-s' }, [
      el('div', { class: 'eyebrow', text: 'How points ended' }),
      el('div', { class: 'tablewrap' }, [
        el('table', { class: 't' }, [
          el('thead', {}, [el('tr', {}, ['Shot', '', 'Count', 'Share'].map(function (h, i) {
            return el('th', { class: i === 0 ? 'c-name' : '', text: h });
          }))]),
          el('tbody', {}, rows.map(function (r) {
            return el('tr', {}, [
              el('td', { class: 'c-name', text: r.label }),
              el('td', {}, [U.pill(r.kind === 'error' ? 'given away' : 'won',
                r.kind === 'error' ? null : 'done')]),
              el('td', { text: String(r.n) }),
              el('td', { text: Math.round((r.n / tally.points) * 100) + '%' })
            ]);
          }))
        ])
      ])
    ]);
  }

  function teamTable(S, api, totals) {
    var ids = Object.keys(totals.byEntrant);
    if (!ids.length) return null;
    var rows = ids.map(function (id) {
      var t = totals.byEntrant[id];
      return { id: id, t: t, net: t.winners - t.errors };
    }).sort(function (a, b) { return b.net - a.net; });

    return el('div', { class: 'stack-s' }, [
      el('div', { class: 'eyebrow', text: 'By team' }),
      el('div', { class: 'tablewrap' }, [
        el('table', { class: 't' }, [
          el('thead', {}, [el('tr', {}, ['Team', 'Won', 'Given away', 'Net', 'Best shot']
            .map(function (h, i) {
              return el('th', { class: i === 0 ? 'c-name' : '', text: h });
            }))]),
          el('tbody', {}, rows.map(function (r) {
            var e = S.entrantsById[r.id];
            return el('tr', {}, [
              el('td', { class: 'c-name' }, [
                el('span', { class: 'swatch',
                  style: e && e.color ? 'background:' + e.color : '' }),
                el('span', { text: e ? e.name : r.id })
              ]),
              el('td', { text: String(r.t.winners) }),
              el('td', { text: String(r.t.errors) }),
              el('td', { class: 'c-pts', text: U.fmtSigned(r.net) }),
              el('td', { text: topShot(S, r.t) })
            ]);
          }))
        ])
      ])
    ]);
  }

  function playerTable(S, totals) {
    var ids = Object.keys(totals.byPlayer);
    if (!ids.length) return null;
    var rows = ids.map(function (id) {
      var t = totals.byPlayer[id];
      return { id: id, t: t, net: t.winners - t.errors };
    }).sort(function (a, b) { return b.net - a.net; });

    return el('div', { class: 'stack-s' }, [
      el('div', { class: 'eyebrow', text: 'By player' }),
      el('div', { class: 'tablewrap' }, [
        el('table', { class: 't' }, [
          el('thead', {}, [el('tr', {}, ['Player', 'Won', 'Given away', 'Net', 'Best shot']
            .map(function (h, i) {
              return el('th', { class: i === 0 ? 'c-name' : '', text: h });
            }))]),
          el('tbody', {}, rows.map(function (r) {
            var p = S.playersById[r.id];
            return el('tr', {}, [
              el('td', { class: 'c-name', text: p ? p.name : 'Unknown' }),
              el('td', { text: String(r.t.winners) }),
              el('td', { text: String(r.t.errors) }),
              el('td', { class: 'c-pts', text: U.fmtSigned(r.net) }),
              el('td', { text: topShot(S, r.t) })
            ]);
          }))
        ])
      ]),
      el('p', { class: 'tiny muted', text:
        '"Net" is shots won less points given away — the number that says ' +
        'who was actually winning rallies rather than being handed them.' })
    ]);
  }

  function topShot(S, tally) {
    var best = null;
    Object.keys(tally.shots).forEach(function (id) {
      var s = A.shotById(S.tournament, id);
      if (s && s.kind === 'error') return;
      if (!best || tally.shots[id] > best.n) {
        best = { n: tally.shots[id], label: (s && s.label) || id };
      }
    });
    return best ? best.label + ' ×' + best.n : '—';
  }

  /* Things the log gives away for free. */
  function extras(S, matches) {
    var runs = [], mins = [];
    matches.forEach(function (m) {
      var st = A.longestStreak(m.events);
      if (st.run > 1) {
        runs.push({ run: st.run, label: m.label,
                    who: st.side === 'home' ? m.homeEntrantId : m.awayEntrantId });
      }
      var d = A.durationMinutes(m.events);
      if (d != null && d > 0) mins.push(d);
    });
    runs.sort(function (a, b) { return b.run - a.run; });
    var avg = mins.length
      ? Math.round(mins.reduce(function (a, b) { return a + b; }, 0) / mins.length)
      : null;

    var best = runs[0];
    if (!best && avg == null) return null;

    return el('div', { class: 'card stack-s' }, [
      el('div', { class: 'eyebrow', text: 'Also worth knowing' }),
      best ? el('p', { class: 'small', text:
        'Longest run of points: ' + best.run + ' in a row by ' +
        (S.entrantsById[best.who] ? S.entrantsById[best.who].name : 'someone') +
        (best.label ? ' (' + best.label + ')' : '') + '.' }) : null,
      avg != null ? el('p', { class: 'small', text:
        'A game takes about ' + avg + (avg === 1 ? ' minute' : ' minutes') +
        ', from ' + mins.length + (mins.length === 1 ? ' game' : ' games') +
        ' timed so far.' }) : null
    ]);
  }

  TS.uiAnalysis = { panel: panel, invalidate: invalidate };

})(window.TS = window.TS || {});
