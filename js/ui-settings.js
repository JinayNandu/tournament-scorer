/* Tournament Scorer - settings
 *
 * Everything chosen at the start can be changed here, and most of it can be
 * ignored entirely. Options that only matter to some tournaments (player
 * grades, several matches per meeting) stay out of the way until switched on.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, el = U.el;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------------------------ sheet -- */

  function sheet(S, api) {
    var t = clone(S.tournament);
    var sc = t.config.scoring;
    var eng = t.config.engine;
    var pts = pointsOf(t);

    U.sheet('Settings', function (close) {
      var body = el('div', { class: 'stack' });

      var scoringFields =
        (eng === 'rally' || eng === 'tennis')
          ? el('div', { class: 'stack-s' }, [
            el('div', { class: 'grid3' }, [
              U.field('Points to win', U.numberInput(sc.pointsToWin, function (v) {
                sc.pointsToWin = Math.max(1, v || 1);
              }, { min: 1, max: 999 })),
              U.field('Stop at (optional)', U.input({
                value: sc.cap == null ? '' : sc.cap, placeholder: 'no limit',
                inputmode: 'numeric',
                oninput: function (e) {
                  var n = parseInt(e.target.value, 10);
                  sc.cap = isNaN(n) ? null : n;
                }
              })),
              U.field('Sets per game', U.numberInput(sc.bestOf || 1, function (v) {
                sc.bestOf = Math.max(1, v || 1);
              }, { min: 1, max: 9 })),
              U.field('Scoring', U.select([
                { value: 'rally', label: 'Every rally is a point' },
                { value: 'sideout', label: 'Only the server can score' }
              ], sc.sideOut ? 'sideout' : 'rally', function (v) {
                sc.sideOut = (v === 'sideout');
              }))
            ]),
            /* Asked as a yes or no, not as "must win by: ___". A number
             * there invited answers nobody plays - win by three - and
             * read as a puzzle. Everyone either plays two clear or they
             * do not, and a golden point on the scoreboard covers the
             * rest on the day. */
            el('label', { class: 'row small', style: 'cursor:pointer' }, [
              el('input', { type: 'checkbox', checked: (sc.winBy == null ? 2 : sc.winBy) > 1,
                onchange: function (e) { sc.winBy = e.target.checked ? 2 : 1; } }),
              el('span', { text: 'Two clear points to win from deuce' })
            ]),
            el('p', { class: 'tiny muted', text:
              'Off means the first to the target wins, however close it is. ' +
              'Either way the scoreboard can call a golden point mid-game.' })
          ])
          : eng === 'cricket'
            ? el('div', { class: 'grid3' }, [
                U.field('Overs', U.numberInput(sc.overs, function (v) {
                  sc.overs = Math.max(1, v || 20); }, { min: 1, max: 90 })),
                U.field('Balls an over', U.numberInput(sc.ballsPerOver, function (v) {
                  sc.ballsPerOver = Math.max(1, v || 6); }, { min: 1, max: 8 })),
                U.field('Wickets', U.numberInput(sc.wickets, function (v) {
                  sc.wickets = Math.max(1, v || 10); }, { min: 1, max: 11 }))
              ])
            : el('p', { class: 'small muted', text: 'Scores are typed in by hand.' });

      U.mount(body, [
        U.field('Name', U.input({ value: t.name,
          oninput: function (e) { t.name = e.target.value; } })),

        el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'How a game is won' }),
          scoringFields,
          el('p', { class: 'tiny muted', text:
            'Any single game can be played to something else — tap the line at the bottom of the scoring screen.' })
        ]),

        el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'Table points' }),
          el('div', { class: 'grid3' }, [
            U.field('Win', U.numberInput(pts.win, function (v) { pts.win = v; })),
            U.field('Draw', U.numberInput(pts.draw, function (v) { pts.draw = v; })),
            U.field('Loss', U.numberInput(pts.loss, function (v) { pts.loss = v; }))
          ])
        ]),

        el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'How much to record' }),
          levelRow(t),
          el('p', { class: 'tiny muted', text:
            'Base is just the score. Advance asks how each point ended. Pro ' +
            'also asks who played the shot. Both show up under Analysis.' })
        ]),

        el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'Extras' }),
          toggle('Several games in each match',
            (t.config.tieTemplate.rubbers || []).length > 1,
            function (on) {
              if (on && (t.config.tieTemplate.rubbers || []).length <= 1) {
                close(); defaultMatches(S, api);
              } else if (!on) {
                t.config.tieTemplate = M.TIE_TEMPLATES.single();
              }
            }),
          el('button', { class: 'btn btn-block',
            text: t.config.useGrades ? 'Player categories ('
              + M.gradesOf(t).join(', ') + ')' : 'Use player categories',
            onclick: function () {
              api.saveTournament(t).then(function () {
                close(); categoriesSheet(S, api);
              });
            } }),
          (eng === 'rally' || eng === 'tennis')
            ? toggle('Keep track of who serves', sc.trackServe !== false,
                function (on) { sc.trackServe = on; })
            : null,
          U.field('Courts', U.numberInput(t.config.courts || 1, function (v) {
            t.config.courts = Math.max(1, v || 1);
          }, { min: 1, max: 20 }))
        ]),

        el('div', { class: 'stack-s' }, [
          el('button', { class: 'btn btn-block', text: 'Games in each match',
            onclick: function () { close(); defaultMatches(S, api); } }),
          el('button', { class: 'btn btn-block', text: 'Redraw every match',
            onclick: function () { close(); TS.matches.everyone(S, api); } }),
          el('button', { class: 'btn btn-block', text: 'Add the next stage',
            onclick: function () { close(); TS.stages.nextStage(S, api); } })
        ]),

        el('div', { class: 'row', style: 'margin-top:14px' }, [
          el('button', { class: 'btn btn-primary', text: 'Save',
            onclick: function () {
              t.config.standings.points = M.pointsRules(pts.win, pts.draw, pts.loss);
              api.saveTournament(t).then(function () {
                close(); api.recompute(); api.render(); U.toast('Saved.');
              });
            } }),
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn btn-sm btn-danger', text: 'Delete',
            onclick: function () { close(); removeTournament(S, api); } })
        ])
      ]);
      return body;
    });
  }

  /* Three choices behind a dropdown, with the sentence explaining them
   * somewhere underneath, meant nobody compared them - they picked
   * whatever was already showing. All three are on screen now.
   *
   * It repaints itself rather than asking for a render: this lives in a
   * sheet, and render() deliberately leaves the overlay alone. */
  function levelRow(t) {
    var row = el('div', { class: 'row', role: 'group',
                          'aria-label': 'How much to record' });
    function paint() {
      var now = t.config.detail || 'none';
      U.mount(row, TS.analysis.LEVELS.map(function (l) {
        return el('button', {
          class: 'btn btn-sm' + (now === l.id ? ' btn-primary' : ''),
          type: 'button', text: l.label, 'aria-pressed': String(now === l.id),
          onclick: function () { t.config.detail = l.id; paint(); }
        });
      }));
    }
    paint();
    return row;
  }

  function toggle(label, on, onchange) {
    return el('label', { class: 'row small', style: 'cursor:pointer' }, [
      el('input', { type: 'checkbox', checked: on,
        onchange: function (e) { onchange(e.target.checked); } }),
      el('span', { text: label })
    ]);
  }

  function pointsOf(t) {
    var rule = ((t.config.standings || {}).points || [])
      .filter(function (r) { return r.per === 'outcome'; })[0];
    var m = (rule && rule.map) || {};
    return { win: m.win == null ? 2 : m.win,
             draw: m.draw == null ? 1 : m.draw,
             loss: m.loss == null ? 0 : m.loss };
  }

  /* ------------------------------------ how many matches in a meeting -- */

  /* The default for NEW meetings. Any meeting already made keeps what it
   * has, and matches can be added to it one at a time from its own screen. */
  function defaultMatches(S, api) {
    var t = clone(S.tournament);
    var labels = ((t.config.tieTemplate.rubbers) || []).map(function (r) {
      return r.label;
    });
    if (!labels.length) labels = ['Game'];

    U.sheet('Games in each match', function (close) {
      var host = el('div', { class: 'stack' });
      var countBox, namesBox;

      /* Built ONCE and re-appended, never rebuilt. paint() re-renders the
       * whole sheet, and a fresh builder forgets which options are
       * already picked - so choosing a second one replaced the first
       * instead of adding to it. */
      var builder = U.categoryBuilder(t, function (made) {
        labels = made.map(function (g) { return g.label; });
        paint();
      });

      function paint() {
        countBox = U.numberInput(labels.length, function (v) {
          var n = Math.max(1, Math.min(30, v || 1));
          while (labels.length > n) labels.pop();
          while (labels.length < n) labels.push('Game ' + (labels.length + 1));
          // One match is just "Match"; a list reads badly as
          // "Match, Match 2, Match 3", so number them all or none.
          // "Match" is what the single game used to be called, so a
          // tournament set up before the rename tidies up here too.
          if (labels[0] === 'Match') labels[0] = 'Game';
          if (n > 1 && labels[0] === 'Game') labels[0] = 'Game 1';
          if (n === 1 && labels[0] === 'Game 1') labels[0] = 'Game';
          namesBox.value = labels.join(', ');
        }, { min: 1, max: 30 });
        namesBox = el('textarea', { class: 'textarea', rows: 3,
          text: labels.join(', '),
          oninput: function (e) {
            var got = U.parseLabels(e.target.value);
            if (got.length) labels = got;
          } });

        U.mount(host, [
          el('p', { class: 'small muted', text:
            'When two teams play each other they can play more than one ' +
            'game. This is the starting point for new matches — you can ' +
            'always add or remove games inside a match afterwards.' }),
          builder,
          U.field('How many', countBox),
          U.field('Call them (optional)', namesBox),
          el('p', { class: 'tiny muted', text:
            'Any names you like, separated by commas. With categories switched on, ' +
            'names like AA or C1D1 also pick the players automatically.' })
        ]);
      }
      paint();

      return [host, el('div', { class: 'row', style: 'margin-top:18px' }, [
        el('button', { class: 'btn btn-primary', text: 'Save',
          onclick: function () {
            t.config.tieTemplate.rubbers = labels.map(function (l) {
              var slots = M.slotsForLabel(t, l);
              return { id: M.uid('tr'), label: l,
                       kind: slots.length > 1 ? 'doubles'
                           : slots.length === 1 ? 'singles' : 'team',
                       homeSlots: slots.slice(), awaySlots: slots.slice() };
            });
            api.saveTournament(t).then(function () {
              close(); api.recompute(); api.render();
              U.toast('New matches will have ' + labels.length +
                      (labels.length === 1 ? ' game.' : ' games.'));
            });
          } }),
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
      ])];
    });
  }

  /* ----------------------------------------------------------- delete -- */

  /* ------------------------------------------------------- categories -- */

  /* Set the categories ONCE for the tournament, then every team sheet is
   * a list of them waiting for names. Typing "A1 Jinay" on every line was
   * the tedious way round: the structure is the same for all twelve
   * teams, so it belongs here and the names belong there. */
  function categoriesSheet(S, api, onSaved) {
    var t = clone(S.tournament);
    var list = (t.config.grades || []).slice();
    if (!list.length) list = M.DEFAULT_GRADES.slice();

    var style = looksLikePairs(list) ? 'pairs' : 'single';
    var count = list.length;

    function looksLikePairs(l) {
      for (var i = 0; i < l.length; i++) {
        if (!/^[A-Za-z][12]$/.test(l[i])) return false;
      }
      return l.length > 0;
    }

    function build(n, kind) {
      var out = [], i;
      if (kind === 'pairs') {
        for (i = 0; i < n; i++) {
          out.push(String.fromCharCode(65 + Math.floor(i / 2)) + ((i % 2) + 1));
        }
      } else {
        for (i = 0; i < n; i++) out.push(String.fromCharCode(65 + i));
      }
      return out;
    }

    U.sheet('Player categories', function (close) {
      var host = el('div', { class: 'stack' });
      var box;

      function paint() {
        box = el('textarea', { class: 'textarea', rows: 3,
          text: list.join(', '),
          oninput: function (e) {
            var got = U.parseLabels(e.target.value);
            if (got.length) { list = got; count = got.length; }
          } });

        U.mount(host, [
          el('p', { class: 'small muted', text:
            'The slots every team fills. Set them once here and each team ' +
            'sheet becomes a list of them waiting for names.' }),

          U.field('How many players in a team',
            U.numberInput(count, function (v) {
              count = Math.max(1, Math.min(26, v || 1));
              list = build(count, style);
              paint();
            }, { min: 1, max: 26 })),

          el('div', { class: 'stack-s' }, [
            el('div', { class: 'eyebrow', text: 'Named as' }),
            el('div', { class: 'stack-s' }, [
              { id: 'pairs', label: 'Pairs', note: 'A1, A2, B1, B2 — a game called AA is the A pair' },
              { id: 'single', label: 'One each', note: 'A, B, C, D — a game called AB is A against B' }
            ].map(function (o) {
              return el('button', {
                class: 'preset', type: 'button',
                'aria-pressed': String(style === o.id),
                onclick: function () {
                  style = o.id; list = build(count, style); paint();
                }
              }, [el('b', { text: o.label }), el('span', { text: o.note })]);
            }))
          ]),

          el('div', { class: 'stack-s' }, [
            U.field('The categories', box),
            el('p', { class: 'tiny muted', text:
              'Edit the list directly if you want your own names for them.' })
          ]),

          el('div', { class: 'row', style: 'margin-top:18px' }, [
            el('button', { class: 'btn btn-primary', text: 'Save',
              onclick: function () {
                t.config.grades = list.slice();
                t.config.useGrades = true;
                M.reparseTemplate(t);
                api.saveTournament(t).then(function () {
                  close(); api.recompute(); api.render();
                  if (onSaved) onSaved();
                  U.toast(list.length + ' categories set.');
                });
              } }),
            el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
          ])
        ]);
      }
      paint();
      return host;
    });
  }

  function removeTournament(S, api) {
    U.confirmSheet({
      title: 'Delete this tournament?', danger: true,
      message: 'Every team, match and score goes with it. This cannot be undone.',
      confirmLabel: 'Delete'
    }).then(function (yes) {
      if (!yes) return;
      var tid = S.tid;
      TS.store.list('tournaments/' + tid + '/rubbers').then(function (rs) {
        return TS.store.runLimited(rs.map(function (r) {
          return function () { return TS.store.del('tournaments/' + tid + '/rubbers/' + r.id); };
        }), 4);
      }).then(function () {
        return TS.store.runLimited(S.fixtures.map(function (f) {
          return function () { return TS.store.del('tournaments/' + tid + '/fixtures/' + f.id); };
        }), 4);
      }).then(function () {
        return TS.store.del('tournaments/' + tid);
      }).then(function () { api.go('home'); U.toast('Deleted.'); })
        .catch(api.writeFailed);
    });
  }

  /* ---------------------------------------------- one match, own rules -- */

  function matchRules(S, api, rubber, current, onSaved) {
    var sc = clone(current || {});
    U.sheet('Rules for this game', function (close) {
      return [
        el('p', { class: 'small muted', style: 'margin-bottom:14px', text:
          'Changes only this game. Everything else keeps the tournament setting.' }),
        el('div', { class: 'grid3' }, [
          U.field('Points to win', U.numberInput(sc.pointsToWin, function (v) {
            sc.pointsToWin = Math.max(1, v || 1);
          }, { min: 1, max: 999 })),
          U.field('Stop at (optional)', U.input({
            value: sc.cap == null ? '' : sc.cap, placeholder: 'no limit',
            inputmode: 'numeric',
            oninput: function (e) {
              var n = parseInt(e.target.value, 10);
              sc.cap = isNaN(n) ? null : n;
            }
          })),
          U.field('Sets per game', U.numberInput(sc.bestOf || 1, function (v) {
            sc.bestOf = Math.max(1, v || 1);
          }, { min: 1, max: 9 }))
        ]),
        el('div', { class: 'row', style: 'margin-top:18px' }, [
          el('button', { class: 'btn btn-primary', text: 'Use these',
            onclick: function () {
              var copy = clone(rubber);
              copy.scoringOverride = sc;
              api.saveRubber(copy).then(function () { close(); if (onSaved) onSaved(); });
            } }),
          rubber.scoringOverride ? el('button', {
            class: 'btn btn-ghost', text: 'Back to the normal rules',
            onclick: function () {
              var copy = clone(rubber);
              delete copy.scoringOverride;
              api.saveRubber(copy).then(function () { close(); if (onSaved) onSaved(); });
            }
          }) : null,
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
        ])
      ];
    });
  }

  TS.settings = {
    categories: categoriesSheet,
    sheet: sheet, defaultMatches: defaultMatches, matchRules: matchRules,
    removeTournament: removeTournament
  };

})(window.TS = window.TS || {});
