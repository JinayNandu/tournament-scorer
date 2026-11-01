/* Tournament Scorer - building the fixtures
 *
 * Local tournaments are improvised: teams turn up, someone decides who
 * plays who, and names get written down as the match starts. So nothing
 * here is required up front. Add one match at a time, or let it draw the
 * whole round robin, and change any of it later.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, SCH = TS.schedule, el = U.el;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* The league everything hangs off when nobody has asked for groups. Its
   * one group holds every team, and is kept in step as teams come and go,
   * so the table is right without anyone configuring a thing. */
  function ensureLeague(t) {
    var stage = (t.stages || [])[0];
    if (!stage) {
      stage = M.makeStage({ name: 'Matches', type: 'roundrobin', groups: [] });
      stage.auto = true;
      t.stages = [stage];
    }
    if (!(stage.groups || []).length) {
      stage.groups = [{ id: M.uid('g'), name: 'League', entrantRefs: [] }];
    }
    if (stage.auto !== false) {
      stage.groups[0].entrantRefs = (t.entrants || []).map(function (e) {
        return M.Ref.entrant(e.id);
      });
      if (stage.groups.length > 1) stage.groups = [stage.groups[0]];
    }
    return stage;
  }

  function syncLeague(S, api) {
    var t = clone(S.tournament);
    ensureLeague(t);
    return api.saveTournament(t);
  }

  /* --------------------------------------------------- the add sheet --- */

  function addSheet(S, api) {
    var teams = S.entrants.length;
    if (teams < 2) {
      U.toast('Add at least two teams first.', 'warn');
      api.go('hub', { tab: 'teams' });
      return;
    }
    U.sheet('Plan the rounds', function (close) {
      return [
        el('p', { class: 'small muted', style: 'margin-bottom:12px',
          text: 'What do you want to set up?' }),
        el('div', { class: 'stack-s' }, [
          el('button', { class: 'preset', type: 'button',
            onclick: function () { close(); everyone(S, api); } }, [
            el('b', { text: S.fixtures.length
              ? 'Redraw the round robin' : 'A round robin' }),
            el('span', { text: S.fixtures.length
              ? 'Change the groups, who is in each, and how many times they ' +
                'play. This replaces the matches already drawn, scores and all.'
              : 'Every team plays every other team. Split them into groups ' +
                'first if you want, and the whole draw is made in one go.' })
          ]),
          el('button', { class: 'preset', type: 'button',
            onclick: function () { close(); oneMatch(S, api); } }, [
            el('b', { text: 'One match at a time' }),
            el('span', { text: 'Pick two teams and that match is added. ' +
              'Come back and add the next whenever it is decided — for a ' +
              'day that makes itself up as it goes.' })
          ]),
          S.fixtures.length ? el('button', {
            class: 'preset', type: 'button',
            onclick: function () { close(); TS.stages.nextStage(S, api); } }, [
            el('b', { text: 'A round after this one' }),
            el('span', { text: 'A Super 6 or Super 4, a knockout, or just a ' +
              'final — played by whoever finishes top of what is already here.' })
          ]) : null
        ])
      ];
    });
  }

  /* ---------------------------------------------------- one at a time -- */

  function oneMatch(S, api) {
    var choice = { home: null, away: null };

    U.sheet('Add a match', function (close) {
      var host = el('div', { class: 'stack' });

      function paint() {
        U.mount(host, [
          el('p', { class: 'small muted', text: choice.home
            ? 'Playing ' + nameOf(S, choice.home) + ' — pick who against.'
            : 'Pick the first team.' }),
          el('div', { class: 'stack-s' }, S.entrants.map(function (e) {
            var picked = choice.home === e.id;
            var disabled = !!(choice.home && picked);
            return el('button', {
              class: 'btn btn-block' + (picked ? ' btn-primary' : ''),
              disabled: disabled,
              style: 'justify-content:flex-start;gap:10px',
              onclick: function () {
                if (!choice.home) { choice.home = e.id; paint(); return; }
                choice.away = e.id;
                close();
                createMatch(S, api, choice.home, choice.away);
              }
            }, [
              el('span', { class: 'swatch', style: 'background:' + (e.color || 'var(--rule-2)') }),
              el('span', { text: e.name })
            ]);
          })),
          choice.home ? el('button', { class: 'btn btn-ghost', text: 'Start again',
            onclick: function () { choice.home = null; paint(); } }) : null
        ]);
      }
      paint();
      return host;
    });
  }

  function nameOf(S, id) {
    var e = S.entrantsById[id];
    return e ? e.name : 'Team';
  }

  function createMatch(S, api, homeId, awayId) {
    var t = clone(S.tournament);
    var stage = ensureLeague(t);
    var round = 1;
    S.fixtures.forEach(function (f) {
      if (f.stageId === stage.id && f.round >= round) round = f.round + 1;
    });
    var f = M.makeFixture({
      tournamentId: S.tid, stageId: stage.id, groupId: stage.groups[0].id,
      round: round,
      home: M.Ref.entrant(homeId), away: M.Ref.entrant(awayId),
      matchCount: defaultMatchCount(t)
    });
    api.saveTournament(t).then(function () {
      return TS.store.set('tournaments/' + S.tid + '/fixtures/' + f.id, f);
    }).then(function () {
      S.tab = 'matches';
      api.recompute(); api.render();
      U.toast(nameOf(S, homeId) + ' v ' + nameOf(S, awayId) + ' added.');
    }).catch(api.writeFailed);
  }

  function defaultMatchCount(t) {
    var r = ((t.config.tieTemplate || {}).rubbers) || [];
    return Math.max(1, r.length);
  }

  /* ------------------------------------------------- the whole draw ---- */

  function everyone(S, api) {
    var teams = S.entrants.length;
    var opts = { groupCount: 1, legs: 1, courts: S.tournament.config.courts || 1 };
    var assign = {};            // entrantId -> which group it is in

    function deal(shuffle) {
      var list = S.entrants.slice();
      if (shuffle) {
        for (var i = list.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var x = list[i]; list[i] = list[j]; list[j] = x;
        }
      }
      var n = Math.max(1, opts.groupCount);
      list.forEach(function (e, i) { assign[e.id] = i % n; });
    }

    function groups() {
      var n = Math.max(1, opts.groupCount);
      var out = [];
      for (var g = 0; g < n; g++) out.push([]);
      S.entrants.forEach(function (e) {
        var g = assign[e.id];
        out[(g == null || g >= n) ? 0 : g].push(e);
      });
      return out;
    }

    deal(false);

    U.sheet(S.fixtures.length ? 'Change the groups' : 'Make the draw', function (close) {
      var host = el('div', { class: 'stack' });

      function paint() {
        var gs = groups();
        var short = gs.filter(function (g) { return g.length < 2; }).length;
        var meetings = gs.reduce(function (acc, g) {
          return acc + g.length * (g.length - 1) / 2 * opts.legs;
        }, 0);
        var per = defaultMatchCount(S.tournament);
        var maxGroups = Math.max(1, Math.floor(teams / 2));

        U.mount(host, [
          el('div', { class: 'stack-s' }, [
            el('div', { class: 'eyebrow', text: 'How the teams are split' })
          ].concat(groupChoices(teams, opts.legs).map(function (c) {
            return el('button', {
              class: 'preset preset-row', type: 'button',
              'aria-pressed': String(opts.groupCount === c.value),
              onclick: function () {
                opts.groupCount = c.value; deal(false); paint();
              }
            }, [
              el('b', { text: c.label }),
              el('span', { text: c.note })
            ]);
          }))),
          maxGroups < 8 ? el('p', { class: 'tiny muted', text:
            'Every group needs at least two teams, so ' + teams +
            ' teams allow at most ' + maxGroups +
            (maxGroups === 1 ? ' group.' : ' groups.') }) : null,

          U.field('Times they play each other',
            U.numberInput(opts.legs, function (v) { opts.legs = v; paint(); },
              { min: 1, max: 20 })),

          // Put each team where you want it, rather than wherever the deal
          // happened to land.
          opts.groupCount > 1 ? el('div', { class: 'stack-s' }, [
            el('div', { class: 'row' }, [
              el('div', { class: 'eyebrow', text: 'Who goes where' }),
              el('div', { class: 'spacer' }),
              el('button', { class: 'btn btn-sm', text: 'Shuffle',
                onclick: function () { deal(true); paint(); } })
            ])
          ].concat(S.entrants.map(function (e) {
            return el('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, [
              el('span', { class: 'swatch',
                style: 'background:' + (e.color || 'var(--rule-2)') }),
              el('span', { class: 'spacer',
                style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                text: e.name }),
              U.select(groupLetters(opts.groupCount),
                assign[e.id] == null ? 0 : assign[e.id],
                function (v) { assign[e.id] = Number(v); paint(); },
                { style: 'width:auto;flex:none' })
            ]);
          }))) : null,

          // Each split already shows its own match count, so the only
          // thing left worth saying is how many GAMES that comes to.
          per > 1 ? el('p', { class: 'small muted', text:
            meetings + ' matches, ' + (meetings * per) + ' games in all.' }) : null,

          short ? U.banner('Every group needs at least two teams in it.', 'warn') : null,
          S.fixtures.length ? U.banner(
            S.fixtures.length === 1
              ? 'This replaces the match already there, score and all.'
              : 'This replaces all ' + S.fixtures.length +
                ' matches already there, scores and all.',
            'warn') : null,

          el('div', { class: 'row', style: 'margin-top:12px' }, [
            el('button', { class: 'btn btn-primary btn-lg', text: S.fixtures.length ? 'Redraw them' : 'Make the draw',
              disabled: !!short || !meetings,
              onclick: function () { close(); buildDraw(S, api, groups(), opts); } }),
            el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
          ])
        ]);
      }
      paint();
      return host;
    });
  }

  /* Every way the teams go, spelled out. A dropdown reading "3 groups"
   * left the organiser doing the division in their head and still not
   * knowing how many matches it came to. Sizes are worked out the same
   * way the draw deals them, so the label is the truth and not a guess. */
  function groupChoices(n, legs) {
    var out = [];
    var max = Math.max(1, Math.floor(n / 2));
    legs = legs || 1;
    for (var g = 1; g <= Math.min(8, max); g++) {
      var sizes = [], i, t;
      for (i = 0; i < g; i++) sizes.push(0);
      for (t = 0; t < n; t++) sizes[t % g] += 1;

      var even = true;
      for (i = 1; i < g; i++) if (sizes[i] !== sizes[0]) even = false;

      var matches = 0;
      for (i = 0; i < g; i++) matches += sizes[i] * (sizes[i] - 1) / 2 * legs;

      out.push({
        value: g,
        label: g === 1 ? 'One table, all ' + n + ' teams'
             : even ? g + ' groups of ' + sizes[0] + ' teams each'
                    : g + ' groups of ' + sizes.join(', ') + ' teams',
        note: matches + (matches === 1 ? ' match' : ' matches')
      });
    }
    return out;
  }

  function groupLetters(n) {
    var out = [];
    for (var g = 0; g < n; g++) {
      out.push({ value: g, label: 'Group ' + String.fromCharCode(65 + g) });
    }
    return out;
  }

  function buildDraw(S, api, grouped, opts) {
    var t = clone(S.tournament);
    var stage = ensureLeague(t);
    stage.auto = opts.groupCount === 1;
    stage.rounds = { legs: opts.legs };
    stage.groups = grouped.map(function (list, i) {
      return {
        id: M.uid('g'),
        name: opts.groupCount === 1 ? 'League' : 'Group ' + String.fromCharCode(65 + i),
        entrantRefs: list.map(function (e) { return M.Ref.entrant(e.id); })
      };
    });

    var per = defaultMatchCount(t);
    var fixtures = [];
    stage.groups.forEach(function (gr) {
      fixtures = fixtures.concat(SCH.roundRobinFixtures({
        tournamentId: S.tid, stageId: stage.id, groupId: gr.id,
        entrantRefs: gr.entrantRefs, legs: opts.legs
      }));
    });
    fixtures.forEach(function (f) { f.matchCount = per; });

    var old = S.fixtures.filter(function (f) { return f.stageId === stage.id; });
    api.saveTournament(t).then(function () {
      return clearFixtures(S, old);
    }).then(function () {
      return TS.store.runLimited(fixtures.map(function (f) {
        return function () {
          return TS.store.set('tournaments/' + S.tid + '/fixtures/' + f.id, f);
        };
      }), 4);
    }).then(function () {
      S.tab = 'matches';
      api.recompute(); api.render();
      U.toast(fixtures.length + (fixtures.length === 1 ? ' match drawn.' : ' matches drawn.'));
    }).catch(api.writeFailed);
  }

  function clearFixtures(S, list) {
    if (!list.length) return Promise.resolve();
    return TS.store.list('tournaments/' + S.tid + '/rubbers').then(function (rubbers) {
      var ids = {};
      list.forEach(function (f) { ids[f.id] = true; });
      return TS.store.runLimited(rubbers.filter(function (r) {
        return ids[r.fixtureId];
      }).map(function (r) {
        return function () {
          return TS.store.del('tournaments/' + S.tid + '/rubbers/' + r.id);
        };
      }), 4);
    }).then(function () {
      return TS.store.runLimited(list.map(function (f) {
        return function () {
          return TS.store.del('tournaments/' + S.tid + '/fixtures/' + f.id);
        };
      }), 4);
    });
  }

  /* The way into a meeting that holds only one match, which otherwise
   * opens straight onto the scoreboard. */
  function fixtureOptions(S, api, f) {
    var sides = api.sidesOf(f.id);
    var count = f.matchCount == null ? defaultMatchCount(S.tournament) : f.matchCount;

    U.sheet(api.entrantName(sides.home) + ' v ' + api.entrantName(sides.away),
      function (close) {
        return [el('div', { class: 'stack-s' }, [
          el('button', { class: 'btn btn-block', text: 'Score it',
            onclick: function () { close(); api.go('fixture', { fid: f.id }); } }),
          el('button', { class: 'btn btn-block', text: 'Set up the games',
            onclick: function () { close(); setupMeeting(S, api, f); } }),
          count > 1 ? el('button', { class: 'btn btn-block', text: 'Open the match',
            onclick: function () {
              close(); api.go('fixture', { fid: f.id, meeting: true });
            } }) : null,
          el('button', { class: 'btn btn-block btn-danger', text: 'Remove this match',
            onclick: function () { close(); removeFixture(S, api, f); } }),
          count === 1 ? el('p', { class: 'tiny muted', style: 'margin-top:6px', text:
            'Two teams can play several games — name them once and it ' +
            'applies to every match in the tournament.' }) : null
        ])];
      });
  }

  function removeFixture(S, api, f) {
    U.confirmSheet({
      title: 'Remove this match?', danger: true,
      message: 'Any score in it goes too.', confirmLabel: 'Remove'
    }).then(function (yes) {
      if (!yes) return;
      clearFixtures(S, [f]).then(function () {
        api.openFixture(null);
        api.go('hub', { tab: 'matches' });
      }).catch(api.writeFailed);
    });
  }

  /* ----------------------------------- the matches inside one meeting -- */

  /* Created once, when the meeting is first opened and the store has
   * actually told us what is there. Never on an unloaded list. */
  /* Categories switched on after the games were already created leaves
   * every one of them with nobody in it, because the players are chosen
   * when a game is made and never again. Fill in the blanks when the
   * match is opened: only games that have NOBODY and whose label now
   * names a category somebody holds, so a line-up picked by hand is
   * never overwritten. */
  function fillFromCategories(S, api, f, sides) {
    if (!S.rubbersLoaded || !S.rubbers.length) return;
    if (!(S.tournament.config || {}).useGrades) return;
    if (filling[f.id]) return;

    var home = SCH.lineupOf(S.entrantsById[sides.home], f, 'home');
    var away = SCH.lineupOf(S.entrantsById[sides.away], f, 'away');
    var todo = [];

    S.rubbers.forEach(function (r) {
      if ((r.homePlayers || []).length || (r.awayPlayers || []).length) return;
      var slots = M.slotsForLabel(S.tournament, r.label);
      if (!slots.length) return;
      var hp = slots.map(function (s) { return home[s] || null; }).filter(Boolean);
      var ap = slots.map(function (s) { return away[s] || null; }).filter(Boolean);
      if (!hp.length && !ap.length) return;
      var copy = clone(r);
      copy.homeSlots = slots.slice();
      copy.awaySlots = slots.slice();
      copy.homePlayers = hp;
      copy.awayPlayers = ap;
      todo.push(copy);
    });

    if (!todo.length) return;
    filling[f.id] = true;
    TS.store.runLimited(todo.map(function (r) {
      return function () {
        return TS.store.set('tournaments/' + S.tid + '/rubbers/' + r.id, r);
      };
    }), 4).then(function () { filling[f.id] = false; })
      ['catch'](function () { filling[f.id] = false; });
  }

  var filling = {};

  function ensure(S, api, f, sides) {
    if (!S.rubbersLoaded) return;
    if (S.rubbers.length) { fillFromCategories(S, api, f, sides); return; }
    var want = f.matchCount == null ? defaultMatchCount(S.tournament) : f.matchCount;
    if (want < 1) return;
    if (ensuring[f.id]) return;
    ensuring[f.id] = true;

    var template = S.tournament.config.tieTemplate;
    var rs;
    if ((template.rubbers || []).length === want) {
      rs = SCH.rubbersForFixture({
        tournamentId: S.tid, fixture: f, template: template,
        homeEntrant: S.entrantsById[sides.home],
        awayEntrant: S.entrantsById[sides.away]
      });
    } else {
      rs = [];
      for (var i = 0; i < want; i++) {
        rs.push(M.makeRubber({
          tournamentId: S.tid, fixtureId: f.id, order: i,
          label: want > 1 ? 'Game ' + (i + 1) : 'Game'
        }));
      }
    }
    SCH.assignRubberSlots(rs, S.tournament.config.courts || 1);
    TS.store.runLimited(rs.map(function (r) {
      return function () {
        return TS.store.set('tournaments/' + S.tid + '/rubbers/' + r.id, r);
      };
    }), 4).then(function () { ensuring[f.id] = false; })
      .catch(function (e) { ensuring[f.id] = false; api.writeFailed(e); });
  }

  var ensuring = {};

  /* The one number to show per side for a meeting. A meeting of a single
   * one-set match IS that match, so its points are the meaningful figure;
   * the matches-won tally reads "1 - 0" for every result there has ever
   * been. Over several sets, or several matches, the units are what
   * counts and the points belong in their own column. */
  function sideScores(S, f, res) {
    var count = f.matchCount == null ? defaultMatchCount(S.tournament) : f.matchCount;
    var sc = (S.tournament.config && S.tournament.config.scoring) || {};
    if (count <= 1 && (sc.bestOf == null || sc.bestOf <= 1)) {
      var ks = Object.keys(f.rubberSummary || {});
      if (ks.length === 1) {
        var s = f.rubberSummary[ks[0]];
        if (s && s.secondary && (s.complete || s.rallies)) {
          return { home: s.secondary.home, away: s.secondary.away };
        }
      }
    }
    return res ? { home: res.units.home, away: res.units.away } : null;
  }

  /* The gap between "the store says there are none" and "the ones we just
   * asked for have been written". The empty state must not render here: it
   * reads as nothing to score, and its Add button would create a second
   * set on top of the one in flight. */
  function settingUp(S, f) {
    if (!S.rubbersLoaded || S.rubbers.length) return false;
    if (ensuring[f.id]) return true;
    var want = f.matchCount == null ? defaultMatchCount(S.tournament) : f.matchCount;
    return want >= 1;
  }

  /* How many matches two teams play when they meet, and what each is
   * called. This is the pickleball-league shape: eleven matches a meeting
   * named AA, BB, C1D1 and so on. Set once and it applies to every meeting
   * nobody has started scoring, in every group and every round. */
  function setupMeeting(S, api, f) {
    var current = (f && f.matchCount != null)
      ? f.matchCount : defaultMatchCount(S.tournament);
    var base = (S.tournament.config || {}).scoring || {};
    var graded = !!(S.tournament.config || {}).useGrades;
    var cats = M.gradesOf(S.tournament);
    // A target per game only means something where there is one to hit.
    var perGame = (S.tournament.config || {}).engine === 'rally';

    var list = ((S.tournament.config.tieTemplate.rubbers) || []).map(function (r) {
      var own = U.gameScoringOf(base, r.scoringOverride);
      return { label: r.label, kind: r.kind || 'team',
               points: own.points, sets: own.sets };
    });
    while (list.length < current) {
      list.push({ label: 'Game ' + (list.length + 1), kind: 'team',
                  points: null, sets: null });
    }
    list = list.slice(0, Math.max(1, current));

    U.sheet('Games in this match', function (close) {
      var host = el('div', { class: 'stack' });

      /* Built once; see the note in ui-settings. A rebuilt builder
       * forgets what is already picked. */
      var builder = U.categoryBuilder(S.tournament, function (made) {
        list = made.map(function (g) {
          return { label: g.label, kind: g.kind, points: null, sets: null };
        });
        paint();
      });

      /* The same row the wizard shows, because this IS the wizard's
       * screen again: the categories were missing here, so a game added
       * after setup had no way to say who plays it short of typing the
       * label by hand. */
      function row(m, i) {
        var need = M.playersNeeded(m.kind);
        var slots = graded ? (M.parseRubberLabel(m.label, cats) || []) : [];

        return el('div', { class: 'card stack-s', style: 'padding:12px' }, [
          el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, [
            el('span', { class: 'tiny muted', style: 'width:18px;flex:none',
              text: String(i + 1) }),
            U.input({ value: m.label, placeholder: 'Name',
              style: 'flex:1;min-width:0',
              oninput: function (e) { m.label = e.target.value; } }),
            U.select(M.MATCH_KINDS.map(function (k) {
              return { value: k.id, label: k.label };
            }), m.kind, function (v) { m.kind = v; paint(); },
              { style: 'width:auto;flex:none' }),
            el('button', { class: 'btn btn-ghost btn-sm', text: '×',
              'aria-label': 'remove',
              onclick: function () {
                if (list.length < 2) {
                  U.toast('A match needs at least one game.', 'warn'); return;
                }
                list.splice(i, 1); paint();
              } })
          ]),

          (graded && need) ? U.catPickers(cats, m, need, paint) : null,

          (graded && need && slots.length === need)
            ? el('p', { class: 'tiny muted',
                text: slots.join(' and ') + ' of each team' }) : null,

          perGame ? U.gameScoring(base, m, paint) : null
        ]);
      }

      function paint() {
        U.mount(host, [
          el('p', { class: 'small muted', text:
            'Two teams can play several games, each scored on its own. ' +
            'Whoever wins more of them wins the match.' }),

          builder,

          el('div', { class: 'stack-s' }, list.map(row)),

          el('div', { class: 'row' }, [
            el('button', { class: 'btn btn-sm', text: '+ Add a game',
              onclick: function () {
                var last = list[list.length - 1];
                list.push({ label: 'Game ' + (list.length + 1),
                            kind: last ? last.kind : 'team',
                            points: null, sets: null });
                paint();
              } }),
            el('button', { class: 'btn btn-sm btn-ghost', text: 'Paste names',
              onclick: function () { pasteNames(S, list, paint); } })
          ]),
          el('p', { class: 'tiny muted', text:
            'Name them anything — AA, BB, C1D1, "Kids doubles". The type only ' +
            'decides how many names are asked for when the game starts.' }),

          el('div', { class: 'stack-s', style: 'margin-top:18px' }, [
            el('button', { class: 'btn btn-primary btn-lg btn-block',
              text: 'Use this for every match',
              onclick: function () { applyTemplate(S, api, list, true, f, close); } }),
            el('button', { class: 'btn btn-block', text: 'Just this match',
              onclick: function () { applyTemplate(S, api, list, false, f, close); } }),
            el('p', { class: 'tiny muted', text:
              'Every match means all groups and all rounds. Matches already ' +
              'being scored keep what they have either way.' }),
            el('button', { class: 'btn btn-ghost btn-block', text: 'Cancel',
              onclick: close })
          ])
        ]);
      }
      paint();
      return host;
    });
  }

  function pasteNames(S, list, paint) {
    U.sheet('Paste the names', function (close) {
      var box = el('textarea', { class: 'textarea', rows: 4,
        text: list.map(function (m) { return m.label; }).join(', ') });
      return [
        U.field('Names, separated by commas', box),
        el('p', { class: 'tiny muted', text:
          'For example: AA, BB, CC, DD, EE, A1B1, A2B2, C1D1, C2D2, A1C1, B1D1' }),
        el('div', { class: 'row', style: 'margin-top:14px' }, [
          el('button', { class: 'btn btn-primary', text: 'Use these',
            onclick: function () {
              var names = U.parseLabels(box.value);
              if (!names.length) { U.toast('No names found.', 'warn'); return; }
              var kind = list.length ? list[0].kind : 'team';
              list.length = 0;
              names.forEach(function (n) {
                list.push({ label: n, kind: kind, points: null, sets: null });
              });
              close(); paint();
            } }),
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
        ])
      ];
    });
  }

  function applyTemplate(S, api, list, everywhere, fixture, close) {
    var t = clone(S.tournament);
    var base = (t.config || {}).scoring || {};
    /* Keep each entry's id. A game already on a court points back here by
     * id to find its own points target, and minting fresh ids every time
     * this sheet was saved quietly cut every one of those threads - so a
     * target set on a game that already existed never reached the board. */
    var was = (t.config.tieTemplate.rubbers || []).slice();
    t.config.tieTemplate.rubbers = list.map(function (m, i) {
      var slots = M.slotsForLabel(t, m.label);
      var need = M.playersNeeded(m.kind);
      if (need && slots.length !== need) slots = slots.slice(0, need);
      var tr = { id: (was[i] && was[i].id) || M.uid('tr'),
                 label: m.label, kind: m.kind,
                 homeSlots: slots.slice(), awaySlots: slots.slice() };
      var own = U.scoringOverrideFor(base, m);
      if (own) tr.scoringOverride = own;
      return tr;
    });

    var n = list.length;
    var targets = (everywhere ? S.fixtures : [fixture]).filter(function (fx) {
      return fx && !Object.keys(fx.rubberSummary || {}).length;
    });

    /* Hold the rebuild off for the whole operation. In between dropping
     * the old games and the new count arriving, a render would find a
     * match with no games, read a count that is still the OLD one, see it
     * disagree with the new template and fall back to inventing "Game 1"
     * through "Game 10" - which then stick, because a match that HAS
     * games is never rebuilt. Writing the count first is not enough on
     * its own: the snapshot carrying it comes back when it comes back. */
    targets.forEach(function (fx) { ensuring[fx.id] = true; });
    function release() { targets.forEach(function (fx) { ensuring[fx.id] = false; }); }

    api.saveTournament(t).then(function () {
      // The count first, so no reader ever sees the new template beside
      // the old number.
      return TS.store.runLimited(targets.map(function (fx) {
        return function () {
          var copy = clone(fx);
          copy.matchCount = n;
          return TS.store.set('tournaments/' + S.tid + '/fixtures/' + fx.id, copy);
        };
      }), 4);
    }).then(function () {
      return TS.store.list('tournaments/' + S.tid + '/rubbers');
    }).then(function (rubbers) {
      var ids = {};
      targets.forEach(function (fx) { ids[fx.id] = true; });
      // Drop the old games so they are rebuilt from the new list.
      return TS.store.runLimited(rubbers
        .filter(function (r) { return ids[r.fixtureId]; })
        .map(function (r) {
          return function () {
            return TS.store.del('tournaments/' + S.tid + '/rubbers/' + r.id);
          };
        }), 4);
    }).then(function () {
      release();
      close(); api.recompute(); api.render();
      U.toast((everywhere ? targets.length + ' matches now have ' : 'This match now has ') +
              n + (n === 1 ? ' game.' : ' games.'));
    }).catch(function (e) { release(); close(); api.writeFailed(e); });
  }

  function addToMeeting(S, api, f) {
    var order = S.rubbers.length;
    var r = M.makeRubber({
      tournamentId: S.tid, fixtureId: f.id, order: order,
      label: 'Game ' + (order + 1)
    });
    var fx = clone(f);
    fx.matchCount = order + 1;
    TS.store.set('tournaments/' + S.tid + '/rubbers/' + r.id, r)
      .then(function () { return api.saveFixture(fx); })
      .then(function () { api.recompute(); api.render(); })
      .catch(api.writeFailed);
  }

  /* ------------------------------------------- who is playing a match --- */

  /* "Jinay was D1, but today he is not playing." The squad's own
   * categories answer this for every match at once; here is where ONE
   * match differs from them. What is set goes on the fixture, so the
   * squad - and every other match - is left exactly as it was.
   */
  function whosPlaying(S, api, f, sides) {
    if (!S.rubbersLoaded || !S.rubbers.length) {
      U.toast('The games are still being set up.', 'warn');
      return;
    }
    var slots = slotsInMatch(S);
    if (slots.length) byCategory(S, api, f, sides, slots);
    else byGame(S, api, f, sides);
  }

  /* The categories this match's games actually name, in the order the
   * categories were defined rather than the order the games fall in, so
   * the sheet reads A1, A2, B1... Anything a label names that is not in
   * the list still gets a row: it is in a game, so somebody plays it. */
  function slotsInMatch(S) {
    var want = {}, out = [];
    S.rubbers.forEach(function (r) {
      M.slotsForLabel(S.tournament, r.label).forEach(function (s) { want[s] = true; });
    });
    M.gradesOf(S.tournament).forEach(function (g) {
      if (want[g]) { out.push(g); delete want[g]; }
    });
    Object.keys(want).forEach(function (s) { out.push(s); });
    return out;
  }

  function teamIn(t, id) {
    return (t.entrants || []).filter(function (e) { return e.id === id; })[0] || null;
  }

  function hasScore(f, r) {
    var sum = (f.rubberSummary || {})[r.id] || r.summary;
    return !!(sum && (sum.complete || sum.rallies));
  }

  /* The squad as a datalist, so a name already entered is one tap rather
   * than typed again - and spelt the same way it was the first time. */
  function squadOptions(S, entrant, id) {
    return el('datalist', { id: id },
      ((entrant && entrant.members) || []).map(function (m) {
        var p = S.playersById[m.playerId];
        return p ? el('option', { value: p.name }) : null;
      }).filter(Boolean));
  }

  /* Enter walks down the sheet, so a whole line-up is typed without
   * reaching for the next box each time. The last one closes the
   * keyboard rather than saving: Save is a deliberate tap. */
  function enterMoves(box, fields) {
    box.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
      ev.preventDefault();
      var next = fields[fields.indexOf(box) + 1];
      if (next) { next.focus(); next.select(); } else { box.blur(); }
    });
  }

  /* ---- one row per category: set it once, every game follows ---------- */

  function byCategory(S, api, f, sides, slots) {
    U.sheet('Who is playing this match?', function (close) {
      var boxes = { home: {}, away: {} };
      var fields = [];
      var out = [el('p', { class: 'small muted', style: 'margin-bottom:14px', text:
        'Set a category here and every game in this match that names it ' +
        'follows. This match only - the squad is left as it is.' })];

      ['home', 'away'].forEach(function (side) {
        var entrant = S.entrantsById[sides[side]];
        var squad = SCH.lineupFor(entrant || {});
        var now = SCH.lineupOf(entrant, f, side);
        var listId = 'sq-' + side + '-' + f.id;
        var rows = [];

        slots.forEach(function (s) {
          var p = now[s] ? S.playersById[now[s]] : null;
          var was = squad[s] ? S.playersById[squad[s]] : null;
          var note = el('span', { class: 'tiny muted' });
          var box = U.input({
            value: p ? p.name : '', placeholder: 'Nobody',
            list: listId, autocomplete: 'off', autocapitalize: 'words',
            style: 'border:0;background:none;padding:2px 0'
          });
          /* Whose place is being taken, shown only once the box differs
           * from the squad - which is the question this sheet answers. */
          function mark() {
            var v = (box.value || '').trim();
            var same = was ? v.toLowerCase() === was.name.toLowerCase() : !v;
            note.textContent = same ? '' : (was ? 'was ' + U.shortName(was.name) : 'new');
          }
          box.addEventListener('input', mark);
          mark();
          enterMoves(box, fields);
          fields.push(box);
          boxes[side][s] = box;
          rows.push(el('div', { class: 'plrow' }, [
            el('span', { class: 'g', text: s }), box, note
          ]));
        });

        out.push(el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
          el('div', { class: 'eyebrow', text: entrant ? entrant.name : side }),
          squadOptions(S, entrant, listId),
          el('div', { class: 'teamcard' }, rows)
        ]));
      });

      out.push(el('p', { class: 'tiny muted', style: 'margin-bottom:12px', text:
        'A game that already has a score keeps the players it was played ' +
        'with. Open that game to change those.' }));
      out.push(el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-primary', text: 'Save',
          onclick: function () {
            saveByCategory(S, api, f, sides, slots, boxes, close);
          } }),
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
      ]));
      return out;
    });
  }

  function saveByCategory(S, api, f, sides, slots, boxes, close) {
    var t = clone(S.tournament);
    var fx = clone(f);
    var added = 0;
    fx.lineup = { home: {}, away: {} };

    ['home', 'away'].forEach(function (side) {
      var entrant = teamIn(t, sides[side]);
      var squad = SCH.lineupFor(entrant || {});
      var own = {};
      slots.forEach(function (s) {
        var name = ((boxes[side][s] || {}).value || '').trim();
        /* Only what actually differs from the squad is stored, so a
         * category left alone here keeps following the squad when it
         * changes. Blanking one is itself a difference, but only where
         * the squad had somebody to drop. */
        if (!name) { if (squad[s]) own[s] = null; return; }
        var found = M.findOrAddPlayer(t, entrant, name, s);
        if (found.created) added += 1;
        if (found.id !== squad[s]) own[s] = found.id;
      });
      fx.lineup[side] = own;
    });

    var lineup = {
      home: SCH.lineupOf(teamIn(t, sides.home), fx, 'home'),
      away: SCH.lineupOf(teamIn(t, sides.away), fx, 'away')
    };

    var todo = [], kept = 0;
    S.rubbers.forEach(function (r) {
      var sl = M.slotsForLabel(t, r.label);
      if (!sl.length) return;
      var home = namesFor(lineup.home, sl), away = namesFor(lineup.away, sl);
      var moved = JSON.stringify([home, away]) !==
                  JSON.stringify([r.homePlayers || [], r.awayPlayers || []]);
      /* Only a game the change would actually have reached is worth
       * reporting as left alone. A scored game nobody touched is not
       * news, and counting it reads as though something was refused. */
      if (hasScore(f, r)) { if (moved) kept += 1; return; }
      var copy = clone(r);
      copy.homeSlots = sl.slice();
      copy.awaySlots = sl.slice();
      copy.homePlayers = home;
      copy.awayPlayers = away;
      if (JSON.stringify(copy) !== JSON.stringify(r)) todo.push(copy);
    });

    close();
    applyLineup(S, api, f, added ? t : null, fx, todo, added, kept);
  }

  function namesFor(map, slots) {
    return slots.map(function (s) { return map[s] || null; }).filter(Boolean);
  }

  /* ---- no categories: one block per game, names typed straight in ----- */

  function byGame(S, api, f, sides) {
    U.sheet('Who is playing this match?', function (close) {
      var boxes = {}, fields = [];
      var ids = { home: 'sq-home-' + f.id, away: 'sq-away-' + f.id };
      var out = [
        el('p', { class: 'small muted', style: 'margin-bottom:14px', text:
          'Every game in one place. Anyone new is added to that team’s ' +
          'squad, so you only enter them once.' }),
        squadOptions(S, S.entrantsById[sides.home], ids.home),
        squadOptions(S, S.entrantsById[sides.away], ids.away)
      ];

      S.rubbers.forEach(function (r) {
        boxes[r.id] = { home: [], away: [] };
        var rows = ['home', 'away'].map(function (side) {
          var entrant = S.entrantsById[sides[side]];
          var current = (side === 'home' ? r.homePlayers : r.awayPlayers) || [];
          var slots = (side === 'home' ? r.homeSlots : r.awaySlots) || [];
          // Singles wants one name and doubles two; only guess from what
          // is already there when the game has no type of its own.
          var howMany = M.playersNeeded(r.kind) ||
            Math.max(slots.length, current.length, 1);
          var ins = [];
          for (var i = 0; i < howMany; i++) {
            var p = current[i] ? S.playersById[current[i]] : null;
            var box = U.input({
              value: p ? p.name : '', placeholder: slots[i] || 'Name',
              list: ids[side], autocomplete: 'off', autocapitalize: 'words',
              style: 'border:0;background:none;padding:2px 0;min-width:0'
            });
            enterMoves(box, fields);
            fields.push(box);
            boxes[r.id][side].push(box);
            ins.push(box);
          }
          return el('div', { class: 'plrow' }, [
            el('span', { class: 'g', text: entrant
              ? (entrant.shortName || entrant.name) : side }),
            el('div', { class: 'row' }, ins),
            el('span')
          ]);
        });
        out.push(el('div', { class: 'teamcard', style: 'margin-bottom:10px' },
          [el('header', {}, [el('span', { class: 'nm', text: r.label })])].concat(rows)));
      });

      out.push(el('div', { class: 'row', style: 'margin-top:14px' }, [
        el('button', { class: 'btn btn-primary', text: 'Save',
          onclick: function () { saveByGame(S, api, f, sides, boxes, close); } }),
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
      ]));
      return out;
    });
  }

  function saveByGame(S, api, f, sides, boxes, close) {
    var t = clone(S.tournament);
    var added = 0, todo = [];

    S.rubbers.forEach(function (r) {
      var copy = clone(r);
      ['home', 'away'].forEach(function (side) {
        var entrant = teamIn(t, sides[side]);
        var slots = (side === 'home' ? r.homeSlots : r.awaySlots) || [];
        var ids = [];
        (boxes[r.id][side] || []).forEach(function (box, i) {
          var name = (box.value || '').trim();
          if (!name) return;
          var found = M.findOrAddPlayer(t, entrant, name, slots[i]);
          if (found.created) added += 1;
          ids.push(found.id);
        });
        if (side === 'home') copy.homePlayers = ids; else copy.awayPlayers = ids;
      });
      if (JSON.stringify(copy) !== JSON.stringify(r)) todo.push(copy);
    });

    close();
    applyLineup(S, api, f, added ? t : null, null, todo, added, 0);
  }

  /* The squad first, because the games about to be written point at the
   * players in it. The auto-fill is held off meanwhile: it would see the
   * half-written games and fill them from the squad we are overriding. */
  function applyLineup(S, api, f, t, fx, todo, added, kept) {
    filling[f.id] = true;
    (t ? api.saveTournament(t) : Promise.resolve())
      .then(function () { return fx ? api.saveFixture(fx) : null; })
      .then(function () {
        return TS.store.runLimited(todo.map(function (r) {
          return function () {
            return TS.store.set('tournaments/' + S.tid + '/rubbers/' + r.id, r);
          };
        }), 4);
      })
      .then(function () {
        filling[f.id] = false;
        U.toast(saidWhat(todo.length, kept, added));
        api.recompute(); api.render();
      })['catch'](function (e) {
        filling[f.id] = false;
        api.writeFailed(e);
      });
  }

  function saidWhat(changed, kept, added) {
    var bits = [changed
      ? changed + (changed === 1 ? ' game updated' : ' games updated')
      : 'Nothing to change'];
    if (added) bits.push(added + (added === 1 ? ' new name' : ' new names') +
      ' added to the squad');
    if (kept) bits.push(kept + ' already scored, left alone');
    return bits.join(', ') + '.';
  }

  function matchOptions(S, api, f, r) {
    U.sheet(r.label, function (close) {
      var nameBox = U.input({ value: r.label, placeholder: 'Game name' });
      return [
        U.field('Call it (optional)', nameBox),
        el('p', { class: 'tiny muted', text:
          'Anything you like — "Doubles 1", "AA", "Kids game".' }),
        el('div', { class: 'row', style: 'margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', text: 'Save',
            onclick: function () {
              var copy = clone(r);
              copy.label = (nameBox.value || '').trim() || r.label;
              api.saveRubber(copy).then(function () { close(); api.render(); });
            } }),
          el('button', { class: 'btn', text: 'Who is playing',
            onclick: function () {
              close();
              api.go('score', { rid: r.id, fid: f.id });
            } })
        ]),
        el('div', { class: 'row', style: 'margin-top:20px' }, [
          el('button', { class: 'btn btn-sm btn-danger', text: 'Remove this game',
            onclick: function () { close(); removeMatch(S, api, f, r); } })
        ])
      ];
    });
  }

  function removeMatch(S, api, f, r) {
    U.confirmSheet({
      title: 'Remove ' + r.label + '?', danger: true,
      message: 'Any score in it goes too.', confirmLabel: 'Remove'
    }).then(function (yes) {
      if (!yes) return;
      var fx = clone(f);
      delete (fx.rubberSummary || {})[r.id];
      fx.matchCount = Math.max(0, (S.rubbers.length - 1));
      TS.store.del('tournaments/' + S.tid + '/rubbers/' + r.id)
        .then(function () {
          // rubberSummary is a map, and update() merges - so the whole
          // fixture is rewritten to actually drop the removed key.
          return TS.store.set('tournaments/' + S.tid + '/fixtures/' + f.id, fx);
        })
        .then(function () { api.recompute(); api.render(); })
        .catch(api.writeFailed);
    });
  }

  TS.matches = {
    addSheet: addSheet, oneMatch: oneMatch, everyone: everyone,
    ensure: ensure, addToMeeting: addToMeeting, matchOptions: matchOptions,
    fixtureOptions: fixtureOptions, setupMeeting: setupMeeting,
    whosPlaying: whosPlaying, slotsInMatch: slotsInMatch,
    removeFixture: removeFixture, ensureLeague: ensureLeague,
    syncLeague: syncLeague, defaultMatchCount: defaultMatchCount,
    settingUp: settingUp, sideScores: sideScores
  };

})(window.TS = window.TS || {});
