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
      return U.empty('Results', 'They appear here as they come in, newest first.');
    }
    return el('div', { class: 'stack-s' }, items.slice(0, 120).map(function (it) {
      var sides = api.sidesOf(it.fixture.id);
      var s = it.s;
      var winnerName = s.winner ? api.entrantName(sides[s.winner]) : null;
      var players = (s.winner === 'away' ? s.awayPlayers : s.homePlayers) || [];
      /* A flat list of results is hard to read down. The edge is the
       * winner's colour - the one their half of the board wore - so a run
       * of them shows at a glance who has been winning. */
      var wonBy = s.winner && sides[s.winner];
      var wonColour = wonBy && (S.entrantsById[wonBy] || {}).color;
      return el('div', { class: 'feedrow',
                         style: wonColour ? '--side:' + wonColour : null }, [
        el('div', { style: 'flex:1;min-width:0' }, [
          el('div', { class: 'fr-teams' }, [
            el('span', { text: api.entrantName(sides.home) }),
            el('span', { class: 'muted', text: '  v  ' }),
            el('span', { text: api.entrantName(sides.away) })
          ]),
          el('div', { class: 'fr-meta' }, [
            s.label ? el('span', { text: s.label + '  ·  ' }) : null,
            el('span', { text: s.complete
              ? (winnerName ? winnerName + ' won ' : 'drawn ') : 'in play ' }),
            el('b', { class: 'fr-line', text: s.line }),
            players.length ? el('span', { text: '  ·  ' +
              U.playerNames(players, S.playersById, { short: true }) }) : null
          ])
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

  /* ------------------------------------------------------ who scores -- */

  /* One button, four answers, because "who can score this?" is a single
   * question to the person asking and three different mechanisms
   * underneath. Which one applies is the backend's to say and not this
   * sheet's to guess, so it asks TS.store.access() and does as it is
   * told. The sheet repaints itself rather than calling render(), the
   * same as every other sheet in the app. */
  function accessSheet(S, api) {
    U.sheet('Who can score', function (close) {
      var host = el('div', { class: 'stack' });
      paintAccess(S, api, host, close);
      return [host];
    });
  }

  function paintAccess(S, api, host, close) {
    var a = TS.store.access();
    if (!a.shared) return U.mount(host, deviceOnly());
    if (!a.codes) return U.mount(host, claudeShare(a));
    if (a.canEdit) return U.mount(host, scoringCode(S, api, host, close, a));
    return U.mount(host, joinPane(S, api, host, close));
  }

  function deviceOnly() {
    return [
      U.banner('Nothing here is shared. This tournament is saved on this ' +
               'phone and nowhere else, so there is nobody to give access ' +
               'to and nothing to keep anybody out of.', 'warn'),
      el('p', { class: 'small muted', text:
        'Once the shared backend is set up, this becomes a link anyone ' +
        'can watch live, with a code for the people doing the scoring.' })
    ];
  }

  /* On the artifact, claude.ai has already decided this and the app must
   * not pretend to. Saying where the real switch is beats offering a
   * second one that does nothing. */
  function claudeShare(a) {
    return [
      el('div', { class: 'card stack-s' }, [
        el('div', { class: 'eyebrow', text: 'On this link you are' }),
        el('div', { style: 'font-weight:800;font-size:20px',
          text: a.canEdit ? 'Scoring' : 'Watching' })
      ]),
      el('p', { class: 'small muted', text:
        'Who can score here is set in the share menu of this page, not ' +
        'in the app. Give somebody Can edit or Can contribute and they ' +
        'can score; give them Can view and they watch it live. This app ' +
        'cannot override that, and does not try to.' })
    ];
  }

  function scoringCode(S, api, host, close, a) {
    var box = el('div', { class: 'codebox', text: '…' });
    var rows = [
      el('div', { class: 'card stack-s' }, [
        el('div', { class: 'eyebrow', text: 'The code for this tournament' }),
        box,
        el('p', { class: 'tiny muted', text:
          'Read it out to whoever is scoring. They open this same link, ' +
          'tap "I am scoring" and type it in. Everybody else watches ' +
          'live with nothing to type at all.' })
      ])
    ];

    if (a.organiser) {
      rows.push(el('div', { class: 'row', style: 'gap:8px' }, [
        el('button', { class: 'btn btn-sm', text: 'Copy',
          onclick: function () {
            U.copyText(box.textContent); U.toast('Copied.');
          } }),
        el('button', { class: 'btn btn-sm', text: 'New code',
          onclick: function () {
            TS.store.setScorerCode(S.tid, TS.store.newCode()).then(function (made) {
              box.textContent = made;
              U.toast('New code. The old one stops working.');
            }, function (e) { U.toast(e.message || 'Could not change it.', 'bad'); });
          } })
      ]));
      rows.push(el('p', { class: 'tiny muted', text:
        'A new code does not stop anybody already scoring — it only ' +
        'changes what the next person has to type. Remove somebody from ' +
        'the Firebase console, under tournaments › scorers.' }));
    } else {
      rows.push(el('p', { class: 'tiny muted', text:
        'You can score this tournament. Only the organiser can change ' +
        'the code or hand out access to the others.' }));
    }

    TS.store.scorerCode(S.tid).then(function (c) {
      if (c) { box.textContent = c; return; }
      if (!a.organiser) { box.textContent = '—'; return; }
      /* A tournament that has never been shared has no code yet. Minting
       * one on sight beats a button that says "make a code": there is no
       * such thing as wanting a shared tournament without one. */
      TS.store.setScorerCode(S.tid, TS.store.newCode()).then(function (made) {
        box.textContent = made;
      }, function () { box.textContent = '—'; });
    });
    return rows;
  }

  function joinPane(S, api, host, close) {
    var rows = [];

    if (S.tid) {
      var code = U.input({ placeholder: 'Code', autocomplete: 'off',
        autocapitalize: 'characters', spellcheck: 'false',
        style: 'text-transform:uppercase;letter-spacing:.14em;font-weight:700' });
      var who = U.input({ placeholder: 'Your name', autocomplete: 'off' });
      var go = el('button', { class: 'btn btn-primary btn-lg btn-block',
        text: 'Start scoring' });
      go.onclick = function () {
        go.disabled = true;
        TS.store.joinTournament(S.tid, code.value, who.value).then(function () {
          close();
          U.toast('You can score this tournament now.');
          api.render();
        }, function (e) {
          go.disabled = false;
          U.toast((e && e.message) || 'That did not work.', 'bad');
        });
      };
      rows.push(el('div', { class: 'card stack' }, [
        el('div', { class: 'eyebrow', text: 'Scoring this tournament' }),
        U.field('The code the organiser gave you', code),
        U.field('Your name', who),
        go
      ]));
      rows.push(el('p', { class: 'small muted', text:
        'Without a code you can still watch all of it, live. The code is ' +
        'only needed to change something.' }));
    }

    rows.push(el('div', { class: 'row', style: 'margin-top:4px' }, [
      el('button', { class: 'btn btn-ghost btn-sm', text: 'I am the organiser',
        onclick: function () { organiserPane(S, api, host, close); } })
    ]));
    return rows;
  }

  /* The organiser key lets somebody CREATE tournaments, so it is
   * app-wide rather than per tournament and is typed once, ever.
   *
   * ONE form for both cases. The page cannot read the key - that is the
   * whole point of it - so it cannot know whether one has been set, and
   * every attempt to word the screen for one case or the other is a
   * guess that is sometimes wrong about a credential. The rules already
   * answer it properly: they take the first key typed into a database
   * that has none, take a matching one after that, and refuse anything
   * else. So the screen says both things and the server decides. */
  function organiserPane(S, api, host, close) {
    var key = U.input({ placeholder: 'Organiser key',
      autocomplete: 'off', spellcheck: 'false',
      style: 'text-transform:uppercase;letter-spacing:.14em;font-weight:700' });
    var who = U.input({ placeholder: 'Your name', autocomplete: 'off' });
    var go = el('button', { class: 'btn btn-primary btn-lg btn-block',
      text: 'Continue' });
    go.onclick = function () {
      go.disabled = true;
      TS.store.becomeOrganiser(key.value, who.value).then(function () {
        close();
        U.toast('You are set up as an organiser.');
        api.render();
      }, function (e) {
        go.disabled = false;
        U.toast((e && e.message) || 'That did not work.', 'bad');
      });
    };
    U.mount(host, [
      el('div', { class: 'card stack' }, [
        el('div', { class: 'eyebrow', text: 'Organiser' }),
        U.field('The organiser key', key),
        U.field('Your name', who),
        go
      ]),
      el('p', { class: 'small muted', text:
        'If nobody has set a key yet, whatever you type here becomes it — ' +
        'so do that before the link goes to anybody. If one has been set, ' +
        'type that one.' }),
      el('p', { class: 'small muted', text:
        'An organiser can create tournaments and score all of them. Each ' +
        'tournament then gets its own short code for the people scoring ' +
        'it — if somebody gave you one of those, go back and use it there.' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Back',
          onclick: function () { paintAccess(S, api, host, close); } })
      ])
    ]);
  }

  /* The setup has six steps and five of them fail without a sound. This
   * runs them in order and says which one is wrong, which is the whole
   * difference between "it does not work" and a thing you can fix. */
  function setupSheet(S, api) {
    U.sheet('Shared setup', function (close) {
      var host = el('div', { class: 'stack' }, [
        el('p', { class: 'muted', text: 'Checking…' })
      ]);
      TS.firestore.check().then(function (rows) {
        U.mount(host, [
          el('div', { class: 'stack-s' }, rows.map(function (r) {
            /* Three outcomes, not two: null means the check genuinely
             * cannot be made from here, which is not a failure. */
            return el('div', { class: 'chkrow' +
                (r.ok === true ? '' : r.ok === false ? ' bad' : ' unknown') }, [
              el('span', { class: 'chkmark',
                text: r.ok === true ? '✓' : r.ok === false ? '✕' : '–' }),
              el('div', { style: 'min-width:0' }, [
                el('b', { text: r.name }),
                el('div', { class: 'small muted', text: r.detail })
              ])
            ]);
          })),
          el('p', { class: 'tiny muted', text:
            'Run this again after any change in the Firebase console. A ' +
            'new config needs the page reloaded before it is picked up.' })
        ]);
      }, function (e) {
        U.mount(host, [U.banner('The check itself failed: ' +
          ((e && e.message) || 'unknown') + '.', 'bad')]);
      });
      return [host];
    });
  }

  TS.extras = {
    setupSheet: setupSheet,
    leaderboard: leaderboard, timeline: timeline, bigScreen: bigScreen,
    dataSheet: dataSheet, playerRows: playerRows, feedItems: feedItems,
    accessSheet: accessSheet
  };

})(window.TS = window.TS || {});
