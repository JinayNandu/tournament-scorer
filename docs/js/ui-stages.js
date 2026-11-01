/* Tournament Scorer - stages and brackets
 *
 * Adding a Super 6 or a knockout is mostly a matter of writing down WHO
 * comes through, as references: "Winner Group A", "Runner-up Group B". The
 * resolver fills them in when the earlier stage finishes, so the whole
 * schedule exists and can be printed on day one.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, SCH = TS.schedule, el = U.el;

  /* ------------------------------------------------------------- panel -- */

  function panel(S, api) {
    var stages = S.tournament.stages || [];
    var blocks = stages.map(function (stage, i) {
      return stageCard(S, api, stage, i);
    });

    blocks.push(el('div', { class: 'card stack' }, [
      el('h2', { text: 'Add the next stage' }),
      el('p', { class: 'small muted', text:
        'The teams coming through do not have to be known yet. Add it now and the fixtures fill themselves in when the stage before finishes.' }),
      el('div', { class: 'grid2' }, [
        el('button', { class: 'preset', type: 'button',
          onclick: function () { addGroupStage(S, api); } }, [
          el('b', { text: 'Another group round' }),
          el('span', { text: 'A Super 6 or Super 8 - the teams who came through play a new table, optionally carrying their group results with them.' })
        ]),
        el('button', { class: 'preset', type: 'button',
          onclick: function () { addKnockout(S, api); } }, [
          el('b', { text: 'Knockout rounds' }),
          el('span', { text: 'Quarters, semis and a final, seeded so the group winners cross over. Byes handled.' })
        ])
      ])
    ]));

    return el('div', { class: 'stack' }, blocks);
  }

  function stageCard(S, api, stage, i) {
    var fixtures = S.fixtures.filter(function (f) { return f.stageId === stage.id; });
    var done = fixtures.filter(function (f) {
      return M.countsForStandings(f.status) || f.status === M.STATUS.BYE;
    }).length;
    var carries = ((stage.standings && stage.standings.counts) || [])
      .filter(function (c) { return c.stageId && c.stageId !== 'self'; });

    var body = [];
    if (stage.type === 'knockout') {
      body.push(bracketView(S, api, stage, fixtures));
    } else {
      body.push(el('div', { class: 'small muted', text:
        (stage.groups || []).map(function (g) {
          return g.name + ' (' + (g.entrantRefs || []).length + ')';
        }).join('  ·  ') }));
    }

    if (carries.length) {
      body.push(el('p', { class: 'tiny muted', text:
        'Carries ' + carries.map(function (c) {
          var from = (S.tournament.stages || []).filter(function (s) {
            return s.id === c.stageId; })[0];
          return (c.weight === 0.5 ? 'half the points from ' : 'points from ') +
                 (from ? from.name : 'an earlier stage') +
                 (c.filter === 'bothEntrantsInThisStage'
                    ? ', for matches between teams who both came through' : '');
        }).join('; ') + '.' }));
    }

    var frozen = stage.standings && stage.standings.frozen;
    if (frozen) {
      var diverged = hasDiverged(S, stage, frozen);
      body.push(U.banner(
        diverged
          ? 'A result has changed since this table was locked. The standings now differ from what was agreed.'
          : 'Table locked on ' + frozen.at.slice(0, 10) + '.',
        diverged ? 'warn' : null,
        el('button', { class: 'btn btn-sm', text: diverged ? 'Re-lock' : 'Unlock',
          onclick: function () {
            setFrozen(S, api, stage, diverged ? snapshot(S, stage) : null);
          } })));
    }

    return el('div', { class: 'card stack' }, [
      el('div', { class: 'row' }, [
        el('div', {}, [
          el('div', { class: 'eyebrow', text: 'Stage ' + (i + 1) }),
          el('h2', { text: stage.name })
        ]),
        el('div', { class: 'spacer' }),
        U.pill(done + ' of ' + fixtures.length + ' played',
          done && done === fixtures.length ? 'done' : null)
      ])
    ].concat(body).concat([
      el('div', { class: 'row' }, [
        !frozen ? el('button', { class: 'btn btn-sm', text: 'Lock this table',
          onclick: function () { setFrozen(S, api, stage, snapshot(S, stage)); } }) : null,
        i === (S.tournament.stages || []).length - 1 && i > 0 ? el('button', {
          class: 'btn btn-sm btn-danger', text: 'Remove stage',
          onclick: function () { removeStage(S, api, stage); }
        }) : null
      ])
    ]));
  }

  /* --------------------------------------------------- freeze / unfreeze -- */

  function snapshot(S, stage) {
    var tables = (S.resolved && S.resolved.tables[stage.id]) || {};
    var rows = {};
    Object.keys(tables).forEach(function (gid) {
      rows[gid] = tables[gid].table.map(function (r) {
        return { entrantId: r.entrantId, rank: r.rank, points: r.points };
      });
    });
    return { at: new Date().toISOString(), rows: rows };
  }

  function hasDiverged(S, stage, frozen) {
    var tables = (S.resolved && S.resolved.tables[stage.id]) || {};
    var keys = Object.keys(frozen.rows || {});
    for (var i = 0; i < keys.length; i++) {
      var was = frozen.rows[keys[i]] || [];
      var now = (tables[keys[i]] && tables[keys[i]].table) || [];
      if (was.length !== now.length) return true;
      for (var j = 0; j < was.length; j++) {
        if (was[j].entrantId !== now[j].entrantId) return true;
      }
    }
    return false;
  }

  function setFrozen(S, api, stage, value) {
    var t = JSON.parse(JSON.stringify(S.tournament));
    (t.stages || []).forEach(function (s) {
      if (s.id === stage.id) {
        s.standings = s.standings || {};
        s.standings.frozen = value;
      }
    });
    api.saveTournament(t).then(function () { api.recompute(); api.render(); });
  }

  function removeStage(S, api, stage) {
    U.confirmSheet({
      title: 'Remove ' + stage.name + '?', danger: true,
      message: 'Its fixtures and any scores in them are deleted. Earlier stages are untouched.',
      confirmLabel: 'Remove'
    }).then(function (yes) {
      if (!yes) return;
      var t = JSON.parse(JSON.stringify(S.tournament));
      t.stages = (t.stages || []).filter(function (s) { return s.id !== stage.id; });
      var doomed = S.fixtures.filter(function (f) { return f.stageId === stage.id; });
      api.saveTournament(t).then(function () {
        return TS.store.runLimited(doomed.map(function (f) {
          return function () {
            return TS.store.del('tournaments/' + S.tid + '/fixtures/' + f.id);
          };
        }), 4);
      }).then(function () { api.recompute(); api.render(); });
    });
  }

  /* ------------------------------------------------------ add a stage --- */

  function previousStage(S) {
    var stages = S.tournament.stages || [];
    return stages[stages.length - 1] || null;
  }

  function addGroupStage(S, api) {
    var prev = previousStage(S);
    if (!prev) { U.toast('Add a first stage from the wizard.', 'warn'); return; }
    var opts = { perGroup: 2, groupCount: 1, carry: 'coQualifiers',
                 legs: 1, name: 'Super 4' };

    var fromGroups = Math.max(1, (prev.groups || []).length);
    var nameEdited = false;
    var nameBox = U.input({
      oninput: function (e) { opts.name = e.target.value; nameEdited = true; }
    });

    /* Who comes through is fixed by the positions; HOW they are split is
     * yours, the same as the first draw. Assignments are keyed by position
     * so they survive a repaint. */
    var assign = {};
    function keyOf(r) { return r.groupId + '#' + r.position; }

    function deal(refs) {
      var n = Math.max(1, opts.groupCount);
      refs.forEach(function (r, i) {
        var band = Math.floor(i / n), pos = i % n;
        assign[keyOf(r)] = (band % 2 === 0) ? pos : (n - 1 - pos);
      });
    }

    function grouped(refs) {
      var n = Math.max(1, opts.groupCount);
      var out = [];
      for (var g = 0; g < n; g++) out.push([]);
      refs.forEach(function (r) {
        var g = assign[keyOf(r)];
        out[(g == null || g >= n) ? 0 : g].push(r);
      });
      return out;
    }

    U.sheet('Another group round', function (close) {
      var host = el('div', { class: 'stack' });
      var lastShape = '';

      function paint() {
        var refs = SCH.qualifierRefs(prev, opts.perGroup);
        var shape = opts.perGroup + 'x' + opts.groupCount;
        if (shape !== lastShape) { lastShape = shape; deal(refs); }

        var gs = grouped(refs);
        var through = refs.length;
        var short = gs.filter(function (g) { return g.length < 2; }).length;
        var matches = gs.reduce(function (acc, g) {
          return acc + g.length * (g.length - 1) / 2 * opts.legs;
        }, 0);

        // "Super 6" names itself from how many come through.
        if (!nameEdited) {
          opts.name = 'Super ' + through;
          nameBox.value = opts.name;
        }

        U.mount(host, [
          U.field('Name', nameBox),
          el('div', { class: 'grid3' }, [
            U.field('Through from each group',
              U.numberInput(opts.perGroup, function (v) {
                opts.perGroup = v; paint();
              }, { min: 1, max: 12 })),
            U.field('Groups in this round', U.numberInput(opts.groupCount, function (v) {
              opts.groupCount = v; paint();
            }, { min: 1, max: 8 })),
            U.field('Times they play each other',
              U.numberInput(opts.legs, function (v) { opts.legs = v; paint(); },
                { min: 1, max: 20 }))
          ]),
          el('p', { class: 'small muted', text:
            through + ' teams come through from ' + fromGroups +
            (fromGroups === 1 ? ' group' : ' groups') + ', ' +
            (opts.groupCount === 1 ? 'into one table' :
              'into ' + opts.groupCount + ' groups') +
            ', ' + matches + ' matches.' }),

          opts.groupCount > 1 ? el('div', { class: 'stack-s' }, [
            el('div', { class: 'row' }, [
              el('div', { class: 'eyebrow', text: 'Who goes where' }),
              el('div', { class: 'spacer' }),
              el('button', { class: 'btn btn-sm', text: 'Spread them out',
                onclick: function () { deal(refs); paint(); } })
            ])
          ].concat(refs.map(function (r) {
            return el('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, [
              el('span', { class: 'spacer',
                style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                text: M.refLabel(r, S.tournament) }),
              U.select(letters(opts.groupCount), assign[keyOf(r)] || 0,
                function (v) { assign[keyOf(r)] = Number(v); paint(); },
                { style: 'width:auto;flex:none' })
            ]);
          }))) : null,

          short ? U.banner(
            'Every group needs at least two teams in it.', 'warn') : null,

          U.field('What they bring with them', U.select([
            { value: 'coQualifiers', label: 'Their result against the others who came through' },
            { value: 'half', label: 'The same, at half weight' },
            { value: 'all', label: 'All their points so far' },
            { value: 'none', label: 'Nothing, everyone starts level' }
          ], opts.carry, function (v) { opts.carry = v; })),
          el('p', { class: 'tiny muted', text:
            'Carried results are counted as real matches rather than copied as a number, so head to head and difference stay right, and fixing an earlier score later flows through on its own.' }),

          el('div', { class: 'row', style: 'margin-top:14px' }, [
            el('button', { class: 'btn btn-primary btn-lg', text: 'Add this stage',
              disabled: !!short || !matches,
              onclick: function () {
                close(); buildGroupStage(S, api, prev, opts, grouped(refs));
              } }),
            el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
          ])
        ]);
      }
      paint();
      return host;
    });
  }

  function letters(n) {
    var out = [];
    for (var g = 0; g < n; g++) {
      out.push({ value: g, label: 'Group ' + String.fromCharCode(65 + g) });
    }
    return out;
  }

  /* ----------------------------------------------- pick the next stage -- */

  function nextStage(S, api) {
    var prev = previousStage(S);
    if (!prev) { U.toast('Draw the first round first.', 'warn'); return; }

    /* A later stage takes its teams from the previous stage's TABLES. A
     * knockout has none - it ends with one winner - so nothing can follow
     * it. Without this guard the app happily made an empty stage. */
    if (!(prev.groups || []).length) {
      U.sheet('Nothing comes after ' + prev.name, function (close) {
        return [
          el('p', { class: 'small muted', text:
            prev.name + ' is a knockout, so it already ends with a single ' +
            'winner. There is no table to take the next teams from. If you ' +
            'wanted something else after the groups, remove it and add that ' +
            'instead.' }),
          el('div', { class: 'row', style: 'margin-top:18px' }, [
            el('button', { class: 'btn btn-danger', text: 'Remove ' + prev.name,
              onclick: function () { close(); removeStage(S, api, prev); } }),
            el('button', { class: 'btn btn-ghost', text: 'Leave it', onclick: close })
          ])
        ];
      });
      return;
    }

    U.sheet('Add the next stage', function (close) {
      return [
        el('p', { class: 'small muted', style: 'margin-bottom:14px', text:
          'Nobody has to have qualified yet. Add it now and the teams fill ' +
          'themselves in as soon as ' + prev.name + ' is finished.' }),
        el('div', { class: 'stack-s' }, [
          el('button', { class: 'preset', type: 'button',
            onclick: function () { close(); addGroupStage(S, api); } }, [
            el('b', { text: 'Another group round' }),
            el('span', { text: 'A Super 6, a Super 4, any size. You choose how many come through and how many groups they play in, and whether they carry their results with them.' })
          ]),
          el('button', { class: 'preset', type: 'button',
            onclick: function () { close(); addKnockout(S, api); } }, [
            el('b', { text: 'Knockout rounds' }),
            el('span', { text: 'Quarters, semis and a final, seeded so group winners meet runners-up from elsewhere.' })
          ]),
          el('button', { class: 'preset', type: 'button',
            onclick: function () { close(); addFinal(S, api); } }, [
            el('b', { text: 'Just a final' }),
            el('span', { text: 'One match between the top two.' })
          ])
        ])
      ];
    });
  }

  function addFinal(S, api) {
    var prev = previousStage(S);
    if (!prev) return;
    var groups = Math.max(1, (prev.groups || []).length);
    buildKnockout(S, api, prev, {
      perGroup: groups >= 2 ? 1 : 2, thirdPlace: false, name: 'Final'
    });
  }

  /* `grouped` is the split chosen on the sheet: an array of ref arrays. */
  function buildGroupStage(S, api, prev, opts, grouped) {
    var groups = grouped.map(function (refs, g) {
      return {
        id: M.uid('g'),
        name: grouped.length === 1 ? opts.name : 'Group ' + String.fromCharCode(65 + g),
        entrantRefs: refs
      };
    });

    var stage = M.makeStage({
      name: opts.name, type: 'roundrobin', groups: groups,
      rounds: { legs: opts.legs },
      qualifyPerGroup: Math.max(1, Math.floor(groups[0].entrantRefs.length / 2))
    });
    stage.standings.counts = SCH.carryCounts(prev.id, opts.carry);

    var fixtures = [];
    groups.forEach(function (gr) {
      fixtures = fixtures.concat(SCH.roundRobinFixtures({
        tournamentId: S.tid, stageId: stage.id, groupId: gr.id,
        entrantRefs: gr.entrantRefs, legs: opts.legs
      }));
    });
    var byRound = {};
    fixtures.forEach(function (f) { (byRound[f.round] = byRound[f.round] || []).push(f); });
    Object.keys(byRound).forEach(function (r) {
      SCH.assignCourts(byRound[r], S.tournament.config.courts || 1);
    });

    commit(S, api, stage, fixtures);
  }

  function addKnockout(S, api) {
    var prev = previousStage(S);
    if (!prev) { U.toast('Add a first stage from the wizard.', 'warn'); return; }
    var opts = { perGroup: 2, thirdPlace: false, name: 'Knockout' };

    U.sheet('Knockout rounds', function (close) {
      var host = el('div', { class: 'stack' });
      var slots = null;          // the first round, laid out by hand
      var lastShape = '';

      function refsNow() { return SCH.qualifierRefs(prev, opts.perGroup); }

      function paint() {
        var refs = refsNow();
        var shape = String(opts.perGroup);
        if (shape !== lastShape) { lastShape = shape; slots = SCH.defaultSlots(refs); }

        var size = slots.length;
        var used = {};
        slots.forEach(function (s) {
          if (s && s.kind !== 'bye') used[keyOfRef(s)] = (used[keyOfRef(s)] || 0) + 1;
        });
        var twice = Object.keys(used).filter(function (k) { return used[k] > 1; });
        var missing = refs.filter(function (r) { return !used[keyOfRef(r)]; });

        var choices = refs.map(function (r, i) {
          return { value: String(i), label: M.refLabel(r, S.tournament) };
        }).concat([{ value: 'bye', label: 'Bye' }]);

        function slotPicker(i) {
          var cur = slots[i];
          var v = 'bye';
          refs.forEach(function (r, j) { if (cur && keyOfRef(cur) === keyOfRef(r)) v = String(j); });
          return U.select(choices, v, function (val) {
            slots[i] = (val === 'bye') ? M.Ref.bye() : refs[Number(val)];
            paint();
          }, { style: 'width:auto;flex:1;min-width:0' });
        }

        var pairs = [];
        for (var i = 0; i < size; i += 2) {
          (function (i) {
            pairs.push(el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, [
              el('span', { class: 'tiny muted', style: 'width:38px;flex:none',
                text: SCH.roundName(size).indexOf('Semi') === 0 ? 'SF' + (i / 2 + 1)
                    : SCH.roundName(size).indexOf('Quarter') === 0 ? 'QF' + (i / 2 + 1)
                    : size === 2 ? 'F' : 'M' + (i / 2 + 1) }),
              slotPicker(i),
              el('span', { class: 'tiny muted', style: 'flex:none', text: 'v' }),
              slotPicker(i + 1)
            ]));
          })(i);
        }

        U.mount(host, [
          U.field('Name', U.input({ value: opts.name,
            oninput: function (e) { opts.name = e.target.value; } })),
          U.field('Through from each group of ' + prev.name,
            U.numberInput(opts.perGroup, function (v) {
              opts.perGroup = v; paint();
            }, { min: 1, max: 8 })),
          el('p', { class: 'small muted', text:
            refs.length + ' teams go through' +
            (size > refs.length ? ', so ' + (size - refs.length) + ' get a bye' : '') +
            (size === 2 ? ' — just the final.'
                        : ' — ' + SCH.roundName(size) + ' through to the final.') }),

          el('div', { class: 'stack-s' }, [
            el('div', { class: 'row' }, [
              el('div', { class: 'eyebrow', text: 'The first round' }),
              el('div', { class: 'spacer' }),
              el('button', { class: 'btn btn-sm', text: 'Seed it for me',
                onclick: function () { slots = SCH.defaultSlots(refsNow()); paint(); } })
            ])
          ].concat(pairs)),
          el('p', { class: 'tiny muted', text:
            'Change any of these. Seeding keeps the top two apart until the final, but with an odd number of groups it can put two teams from the same group together — swap them here if it does.' }),

          twice.length ? U.banner('A team is in the bracket twice.', 'warn') : null,
          missing.length ? U.banner(
            missing.map(function (r) { return M.refLabel(r, S.tournament); }).join(', ') +
            ' left out of the bracket.', 'warn') : null,

          el('label', { class: 'row small', style: 'cursor:pointer' }, [
            el('input', { type: 'checkbox', checked: opts.thirdPlace,
              onchange: function (e) { opts.thirdPlace = e.target.checked; paint(); } }),
            el('span', { text: 'Play a third-place match' })
          ]),

          el('div', { class: 'row', style: 'margin-top:14px' }, [
            el('button', { class: 'btn btn-primary btn-lg', text: 'Add the bracket',
              disabled: !!twice.length || !!missing.length,
              onclick: function () {
                close(); buildKnockout(S, api, prev, opts, slots);
              } }),
            el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
          ])
        ]);
      }
      paint();
      return host;
    });
  }

  function keyOfRef(r) {
    if (!r || r.kind === 'bye') return 'bye';
    if (r.kind === 'groupPosition') return r.groupId + '#' + r.position;
    return r.kind + '#' + (r.entrantId || r.fixtureId || r.position);
  }

  function buildKnockout(S, api, prev, opts, slots) {
    var refs = SCH.qualifierRefs(prev, opts.perGroup);
    var stage = M.makeStage({ name: opts.name, type: 'knockout', groups: [] });
    var fixtures = SCH.knockoutFixtures({
      tournamentId: S.tid, stageId: stage.id,
      entrantRefs: refs, slots: slots || null, thirdPlace: opts.thirdPlace
    });
    commit(S, api, stage, fixtures);
  }

  function commit(S, api, stage, fixtures) {
    // An empty stage is never what anyone meant.
    if (!fixtures.length) {
      U.toast('That would not create any matches, so nothing was added.', 'warn');
      return;
    }

    // Pin each meeting's match count at creation, as the first round does.
    // Left null they would silently follow a later change to the default.
    var per = TS.matches.defaultMatchCount(S.tournament);
    fixtures.forEach(function (f) { if (f.matchCount == null) f.matchCount = per; });

    var t = JSON.parse(JSON.stringify(S.tournament));
    t.stages = (t.stages || []).concat([stage]);
    api.saveTournament(t).then(function () {
      return TS.store.runLimited(fixtures.map(function (f) {
        return function () {
          return TS.store.set('tournaments/' + S.tid + '/fixtures/' + f.id, f);
        };
      }), 4);
    }).then(function () {
      S.tab = 'matches';
      api.recompute(); api.render();
      U.toast(stage.name + ' added — ' + fixtures.length + ' matches.');
    }).catch(api.writeFailed);
  }

  /* ----------------------------------------------------------- bracket -- */

  function bracketView(S, api, stage, fixtures) {
    var rounds = {};
    fixtures.forEach(function (f) {
      if (f.shortLabel === '3P') { (rounds.third = rounds.third || []).push(f); return; }
      (rounds[f.round] = rounds[f.round] || []).push(f);
    });
    var keys = Object.keys(rounds).filter(function (k) { return k !== 'third'; })
      .sort(function (a, b) { return a - b; });

    var cols = keys.map(function (r) {
      var list = rounds[r];
      var name = list[0].roundName || 'Round ' + r;
      return el('div', { style: 'min-width:190px;display:flex;flex-direction:column;' +
        'gap:10px;justify-content:space-around' }, [
        // A one-round knockout called "Final" sits under a stage heading
        // that also says "Final", which read as "FINAL FINAL".
        name === stage.name ? null : el('div', { class: 'eyebrow', text: name })
      ].concat(list.map(function (f) { return bracketMatch(S, api, f); })));
    });

    if (rounds.third) {
      cols.push(el('div', { style: 'min-width:190px;display:flex;flex-direction:column;gap:10px' }, [
        el('div', { class: 'eyebrow', text: 'Third place' }),
        bracketMatch(S, api, rounds.third[0])
      ]));
    }

    return el('div', { style: 'overflow-x:auto;padding-bottom:4px' }, [
      el('div', { style: 'display:flex;gap:14px;min-width:min-content' }, cols)
    ]);
  }

  function bracketMatch(S, api, f) {
    var res = S.resolved && S.resolved.resultsById[f.id];
    var nums = TS.matches.sideScores(S, f, res);
    /* A side that has not resolved yet is a placeholder - "Winner of
     * Group B" - and has no team, so no colour. Those are the rows a
     * bracket is mostly made of before it is played. */
    function line(side) {
      var sides = api.sidesOf(f.id);
      var isWinner = res && res.outcome === side;
      var e = sides[side] && S.entrantsById[sides[side]];
      return el('div', {
        class: 'bk-side' + (isWinner ? ' win' : '') + (sides[side] ? '' : ' tbd'),
        style: e && e.color ? '--side:' + e.color : null
      }, [
        el('span', { class: 'nm', text: api.sideLabel(f, side) }),
        el('span', { class: 'num', text: nums ? String(nums[side]) : '' })
      ]);
    }
    return el('button', {
      class: 'bkm', type: 'button',
      onclick: function () { api.go('fixture', { fid: f.id }); }
    }, [
      el('div', { class: 'bk-lbl',
        text: f.shortLabel + (f.status === M.STATUS.BYE ? '  ·  bye' : '') }),
      line('home'),
      line('away')
    ]);
  }

  TS.stages = { panel: panel, bracketView: bracketView, nextStage: nextStage,
                addKnockout: addKnockout, addGroupStage: addGroupStage,
                addFinal: addFinal, removeStage: removeStage };

})(window.TS = window.TS || {});
