/* Tournament Scorer - player leaderboard, result feed, big screen, backup
 *
 * All of these read the fixture documents only. Each rubber's compact
 * summary carries who played and when, so none of this has to load the
 * hundreds of rubber documents a season produces.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, el = U.el;

  /* ------------------------------------------------------ leaderboard -- */

  function playerRows(S) {
    var rows = {};
    function row(id) {
      if (!rows[id]) {
        rows[id] = { playerId: id, played: 0, won: 0, lost: 0, drawn: 0,
                     pointsFor: 0, pointsAgainst: 0, partners: {} };
      }
      return rows[id];
    }

    S.fixtures.forEach(function (f) {
      var map = f.rubberSummary || {};
      Object.keys(map).forEach(function (rid) {
        var s = map[rid];
        if (!s || !s.complete) return;
        [['home', s.homePlayers], ['away', s.awayPlayers]].forEach(function (pair) {
          var side = pair[0], ids = pair[1] || [];
          var opp = side === 'home' ? 'away' : 'home';
          ids.forEach(function (id) {
            if (!id) return;
            var r = row(id);
            r.played += 1;
            if (s.winner === side) r.won += 1;
            else if (s.winner === opp) r.lost += 1;
            else r.drawn += 1;
            r.pointsFor += (s.secondary && s.secondary[side]) || 0;
            r.pointsAgainst += (s.secondary && s.secondary[opp]) || 0;
            // Doubles partnerships, for the "best pairing" line.
            ids.forEach(function (mate) {
              if (!mate || mate === id) return;
              var key = [id, mate].sort().join('|');
              var p = r.partners[key] || (r.partners[key] = { mate: mate, w: 0, l: 0 });
              if (s.winner === side) p.w += 1; else if (s.winner === opp) p.l += 1;
            });
          });
        });
      });
    });

    return Object.keys(rows).map(function (id) {
      var r = rows[id];
      r.winPct = r.played ? Math.round((r.won / r.played) * 100) : 0;
      r.diff = r.pointsFor - r.pointsAgainst;
      return r;
    });
  }

  function leaderboard(S, api) {
    var rows = playerRows(S);
    if (!rows.length) {
      return U.empty('No player results yet',
        'Once matches are scored, every player\'s record shows up here.');
    }
    rows.sort(function (a, b) {
      return (b.won - a.won) || (b.winPct - a.winPct) || (b.diff - a.diff);
    });

    var teamOf = {};
    S.entrants.forEach(function (e) {
      (e.members || []).forEach(function (m) { teamOf[m.playerId] = e; });
    });

    var body = rows.map(function (r, i) {
      var p = S.playersById[r.playerId];
      var team = teamOf[r.playerId];
      return el('tr', {}, [
        el('td', { class: 'c-pos', text: String(i + 1) }),
        el('td', { class: 'c-name' }, [
          el('span', { class: 'swatch',
            style: team && team.color ? 'background:' + team.color : '' }),
          el('span', { text: p ? p.name : 'Unknown' }),
          team ? el('span', { class: 'tiny muted', style: 'margin-left:8px',
            text: team.shortName }) : null
        ]),
        el('td', { text: String(r.played) }),
        el('td', { text: String(r.won) }),
        el('td', { text: String(r.lost) }),
        el('td', { class: 'c-pts', text: r.winPct + '%' }),
        el('td', { text: U.fmtSigned(r.diff) })
      ]);
    });

    var best = bestPairing(rows);

    return el('div', { class: 'stack' }, [
      best ? el('div', { class: 'card' }, [
        el('div', { class: 'eyebrow', text: 'Best pairing' }),
        el('div', { style: 'font-size:17px;font-weight:700;margin-top:4px',
          text: best.names }),
        el('div', { class: 'small muted', text: best.w + ' won, ' + best.l + ' lost' })
      ]) : null,
      el('div', { class: 'tablewrap' }, [
        el('table', { class: 't' }, [
          el('thead', {}, [el('tr', {}, ['', 'Player', 'P', 'W', 'L', 'Win', '+/-']
            .map(function (h, i) {
              return el('th', { class: i === 1 ? 'c-name' : i === 0 ? 'c-pos' : '', text: h });
            }))]),
          el('tbody', {}, body)
        ])
      ]),
      el('p', { class: 'tiny muted', text:
        'Counts every game a player appeared in. "+/-" is points scored less points conceded.' })
    ]);

    function bestPairing(rs) {
      var seen = {}, best = null;
      rs.forEach(function (r) {
        Object.keys(r.partners).forEach(function (k) {
          if (seen[k]) return;
          seen[k] = true;
          var p = r.partners[k];
          if (p.w + p.l < 2) return;
          var score = p.w - p.l;
          if (!best || score > best.score || (score === best.score && p.w > best.w)) {
            var a = S.playersById[r.playerId], b = S.playersById[p.mate];
            best = { score: score, w: p.w, l: p.l,
                     names: (a ? a.name : '?') + ' & ' + (b ? b.name : '?') };
          }
        });
      });
      return best;
    }
  }

  /* ----------------------------------------------------------- feed ---- */

  function feedItems(S, api) {
    var items = [];
    S.fixtures.forEach(function (f) {
      var map = f.rubberSummary || {};
      Object.keys(map).forEach(function (rid) {
        var s = map[rid];
        if (!s || !s.at) return;
        items.push({ at: s.at, fixture: f, rubberId: rid, s: s });
      });
    });
    items.sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    return items;
  }

  function timeline(S, api) {
    var items = feedItems(S, api);
    if (!items.length) {
      return U.empty('Nothing played yet', 'Results appear here as they come in, newest first.');
    }
    return el('div', { class: 'stack-s' }, items.slice(0, 120).map(function (it) {
      var sides = api.sidesOf(it.fixture.id);
      var s = it.s;
      var winnerName = s.winner ? api.entrantName(sides[s.winner]) : null;
      var players = (s.winner === 'away' ? s.awayPlayers : s.homePlayers) || [];
      return el('div', { class: 'row', style:
        'border:1px solid var(--rule);border-radius:10px;padding:10px 14px;' +
        'background:var(--surface);align-items:flex-start' }, [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { style: 'font-weight:600' }, [
            el('span', { text: api.entrantName(sides.home) }),
            el('span', { class: 'muted', text: '  v  ' }),
            el('span', { text: api.entrantName(sides.away) })
          ]),
          el('div', { class: 'small muted', text:
            (s.label ? s.label + '  ·  ' : '') +
            (s.complete
              ? (winnerName ? winnerName + ' won ' + s.line : 'drawn ' + s.line)
              : 'in play ' + s.line) +
            (players.length ? '  ·  ' +
              U.playerNames(players, S.playersById, { short: true }) : '') })
        ]),
        s.complete ? U.pill('Final', 'done') : U.pill('Live', 'live')
      ]);
    }));
  }

  /* ------------------------------------------------------ big screen --- */

  function bigScreen(S, api) {
    var close = function () { U.closeSheet(); };
    var host = el('div', { style:
      'position:fixed;inset:0;z-index:150;background:var(--bg);overflow:auto;' +
      'padding:max(20px,env(safe-area-inset-top,0px)) max(20px,env(safe-area-inset-right,0px)) 20px max(20px,env(safe-area-inset-left,0px))' });

    function paint() {
      var live = S.fixtures.filter(function (f) { return f.status === M.STATUS.LIVE; });
      var recent = feedItems(S, api).filter(function (i) { return i.s.complete; }).slice(0, 8);
      var tables = [];
      (S.tournament.stages || []).forEach(function (stage) {
        /* A knockout has no table, so the screen used to go blank for the
         * part of the day everyone is actually watching. */
        if (stage.type === 'knockout') {
          var mine = S.fixtures.filter(function (x) { return x.stageId === stage.id; });
          if (mine.length) {
            tables.push(el('div', {}, [
              el('div', { class: 'eyebrow', style: 'margin-bottom:8px', text: stage.name }),
              TS.stages.bracketView(S, api, stage, mine)
            ]));
          }
          return;
        }
        var byGroup = (S.resolved && S.resolved.tables[stage.id]) || {};
        Object.keys(byGroup).forEach(function (gid) {
          var g = (stage.groups || []).filter(function (x) { return x.id === gid; })[0];
          tables.push(miniTable(S, api, stage, g, byGroup[gid]));
        });
      });

      U.mount(host, el('div', { style: 'max-width:1400px;margin:0 auto' }, [
        el('div', { class: 'row', style: 'margin-bottom:20px' }, [
          el('h1', { class: 'bs-title', text: S.tournament.name }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn', text: 'Close', onclick: close })
        ]),
        live.length ? el('div', { style: 'margin-bottom:24px' }, [
          el('div', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'On court now' }),
          el('div', { style: 'display:grid;gap:10px;' +
            'grid-template-columns:repeat(auto-fit,minmax(260px,1fr))' },
            live.map(function (f) { return liveCard(S, api, f); }))
        ]) : null,
        el('div', { style: 'display:grid;gap:20px;' +
          'grid-template-columns:repeat(auto-fit,minmax(320px,1fr))' }, tables),
        recent.length ? el('div', { style: 'margin-top:24px' }, [
          el('div', { class: 'eyebrow', style: 'margin-bottom:8px', text: 'Latest results' }),
          el('div', { class: 'stack-s' }, recent.map(function (it) {
            var sides = api.sidesOf(it.fixture.id);
            return el('div', { class: 'small' }, [
              el('b', { text: it.s.winner ? api.entrantName(sides[it.s.winner]) : 'Drawn' }),
              el('span', { class: 'muted', text: '  ' + (it.s.label || '') + '  ' + it.s.line })
            ]);
          }))
        ]) : null
      ]));
    }
    paint();

    var timer = setInterval(function () {
      if (!document.body.contains(host)) { clearInterval(timer); return; }
      paint();
    }, 5000);

    U.mount(document.getElementById('overlay'), host);
  }

  /* This one is read from the far side of a hall, off a projector, by
   * people who are not holding it. Everything here is sized off the
   * viewport rather than fixed, and both teams carry the same colour the
   * board washes their half with. */
  function liveCard(S, api, f) {
    var sides = api.sidesOf(f.id);
    var tally = TS.views.liveTally(f, f.matchCount == null ? 1 : f.matchCount);
    function side(eid, right) {
      var e = eid && S.entrantsById[eid];
      return el('div', {
        class: 'bs-side' + (right ? ' r' : ''),
        style: e && e.color ? '--side:' + e.color : null,
        text: api.entrantName(eid)
      });
    }
    return el('div', { class: 'card bs-live' }, [
      el('div', { class: 'row' }, [
        side(sides.home, true),
        el('div', { class: 'bs-score', text: tally.home + ' - ' + tally.away }),
        side(sides.away, false)
      ]),
      f.court ? el('div', { class: 'bs-court', text: 'Court ' + f.court }) : null
    ]);
  }

  function miniTable(S, api, stage, group, tbl) {
    var qualify = (stage.groups || []).length > 1 ? (stage.qualifyPerGroup || 0) : 0;
    return el('div', {}, [
      el('div', { class: 'eyebrow', style: 'margin-bottom:6px',
        text: (group ? group.name : stage.name) }),
      el('div', { class: 'tablewrap' }, [
        el('table', { class: 't' }, [
          el('thead', {}, [el('tr', {}, ['', 'Team', 'P', 'W', 'Pts'].map(function (h, i) {
            return el('th', { class: i === 1 ? 'c-name' : i === 0 ? 'c-pos' : '', text: h });
          }))]),
          el('tbody', {}, tbl.table.map(function (r, i) {
            var e = S.entrantsById[r.entrantId];
            return el('tr', { class: qualify && i < qualify ? 'qualify' : '' }, [
              el('td', { class: 'c-pos', text: String(r.rank) + (r.sharedRank ? '=' : '') }),
              el('td', { class: 'c-name', text: e ? e.name : r.entrantId }),
              el('td', { text: String(r.played) }),
              el('td', { text: String(r.won) }),
              el('td', { class: 'c-pts', text: String(Math.round(r.points * 100) / 100) })
            ]);
          }))
        ])
      ])
    ]);
  }

  /* ---------------------------------------------------------- backup --- */

  function dataSheet(S, api) {
    U.sheet('Backup and housekeeping', function (close) {
      var out = el('div', { class: 'stack' });

      var exportBtn = el('button', {
        class: 'btn btn-primary', text: 'Export this tournament',
        onclick: function () {
          TS.store.exportTournament(S.tid).then(function (bundle) {
            var text = JSON.stringify(bundle);
            var name = (S.tournament.name || 'tournament')
              .replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() + '.json';
            offerFile(name, text, out);
          }).catch(function (e) { U.toast('Export failed: ' + e.message, 'bad'); });
        }
      });

      var importArea = el('textarea', { class: 'textarea', rows: 4,
        placeholder: 'Paste an exported tournament here' });
      var importBtn = el('button', {
        class: 'btn', text: 'Import',
        onclick: function () {
          var bundle;
          try { bundle = JSON.parse(importArea.value); }
          catch (e) { U.toast('That is not valid JSON.', 'bad'); return; }
          TS.store.importTournament(bundle).then(function (tid) {
            close();
            api.go('home');
            U.toast('Imported. Open it from the list.');
          }).catch(function (e) { U.toast(e.message, 'bad'); });
        }
      });

      var compactBtn = el('button', {
        class: 'btn', text: 'Compact finished games',
        onclick: function () {
          U.confirmSheet({
            title: 'Compact finished games?',
            message: 'Drops the point-by-point history of games that are over, keeping every score and result. Frees space; undo inside those games is lost.',
            confirmLabel: 'Compact'
          }).then(function (yes) {
            if (!yes) return;
            TS.store.compact(S.tid).then(function (n) {
              U.toast(n + ' games compacted.');
            }).catch(function (e) { U.toast('Failed: ' + e.message, 'bad'); });
          });
        }
      });

      U.mount(out, [
        el('p', { class: 'small muted', text:
          'An export is a single JSON file holding the teams, the draw and every score. Keep one before a big event.' }),
        el('div', { class: 'row' }, [exportBtn]),
        el('div', { class: 'stack-s', style: 'margin-top:18px' }, [
          el('div', { class: 'eyebrow', text: 'Restore' }),
          importArea, el('div', { class: 'row' }, [importBtn])
        ]),
        el('div', { class: 'stack-s', style: 'margin-top:18px' }, [
          el('div', { class: 'eyebrow', text: 'Space' }),
          el('div', { class: 'row' }, [compactBtn])
        ])
      ]);
      return out;
    });
  }

  /* The viewer frame blocks downloads a page starts by itself, so offer the
   * file through the downloads capability and fall back to the clipboard. */
  function offerFile(filename, text, host) {
    var done = function (msg, kind) { U.toast(msg, kind); };
    if (window.claude && window.claude.use) {
      window.claude.use('downloads').then(function (d) {
        if (!d) return fallback();
        d.save({ filename: filename, data: text }).then(function () {
          done('Saved ' + filename + '.');
        }, function () { fallback(); });
      }, fallback);
    } else { fallback(); }

    function fallback() {
      U.copyText(text).then(function (ok) {
        if (ok) { done('Copied to the clipboard — paste it into a file.'); return; }
        var ta = el('textarea', { class: 'textarea', rows: 6, text: text });
        host.appendChild(el('div', { class: 'stack-s', style: 'margin-top:12px' }, [
          el('div', { class: 'eyebrow', text: 'Copy this and save it as ' + filename }),
          ta
        ]));
        ta.select();
      });
    }
  }

  TS.extras = {
    leaderboard: leaderboard, timeline: timeline, bigScreen: bigScreen,
    dataSheet: dataSheet, playerRows: playerRows, feedItems: feedItems
  };

})(window.TS = window.TS || {});
