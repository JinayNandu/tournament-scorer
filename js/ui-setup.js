/* Tournament Scorer - setting one up, step by step
 *
 * The old screen asked for a name and left everything else to be hunted
 * down afterwards: teams here, categories buried in settings, groups in
 * one sheet, the game list in another. Everything was reachable and
 * nothing was obvious.
 *
 * So this walks the organiser through the decisions in the order they
 * actually make them:
 *
 *   1  how many teams, how many players in each
 *   2  the categories those players sit in          (optional)
 *   3  the teams, and the names against each category
 *   4  the groups, and how much each group plays
 *   5  the format, and the games inside a match
 *
 * Every one of them is editable afterwards through the screens that
 * already existed - this is a first pass, not a cage. Nothing is written
 * to the store until the last step, so backing out costs nothing.
 *
 * How much to record (Base, Advance, Pro) is deliberately NOT here. It is
 * a scoring decision and it is asked on the scoreboard.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, SCH = TS.schedule, el = U.el;

  /* Each of these is a KIND of scoring, never a particular number. Naming
   * one "First to 21" next to an editable "points to win" box only
   * contradicts itself the moment the number is changed. */
  var WAYS = [
    { id: 'points', label: 'Points', engine: 'rally', sport: 'pickleball',
      hint: 'First to a set number of points. Pickleball, badminton, squash, volleyball, table tennis.',
      scoring: { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false } },
    { id: 'goals', label: 'Goals', engine: 'tally', sport: 'football',
      hint: 'Count them as they go, then call full time. Football, hockey, basketball.',
      scoring: { increments: [1], periods: 2, periodName: 'Half',
                 allowDraw: true, unitName: 'Goals' } },
    { id: 'tennis', label: 'Tennis', engine: 'tennis', sport: 'tennis',
      hint: '15, 30, 40, games and sets, with a tie-break at six games all.',
      scoring: { sets: 3, gamesPerSet: 6, tiebreakAt: 6, adScoring: true,
                 finalSetTiebreak: true } },
    { id: 'cricket', label: 'Cricket', engine: 'cricket', sport: 'cricket',
      hint: 'Ball by ball: runs, wides, no balls, byes and wickets.',
      scoring: { overs: 20, ballsPerOver: 6, wickets: 10, innings: 2,
                 trackPlayers: false } },
    { id: 'manual', label: 'Type the score', engine: 'manual', sport: 'other',
      hint: 'Enter the final score when a match ends. Works for anything at all.',
      scoring: { unitName: 'Score', allowDraw: true } }
  ];

  var STEPS = ['basics', 'categories', 'teams', 'groups', 'format'];

  function wayOf(id) {
    return WAYS.filter(function (w) { return w.id === id; })[0] || WAYS[0];
  }

  /* Only the racket sports break a match into several games played by
   * named pairs. A cricket match is one innings each, by the whole team. */
  function hasGames(way) {
    return way.engine === 'rally' || way.engine === 'tennis';
  }

  function fresh() {
    var w = WAYS[0];
    return {
      step: 'basics',
      name: '',
      way: w.id,
      scoring: JSON.parse(JSON.stringify(w.scoring)),

      teamCount: 4,
      perTeam: 2,

      useCats: false,
      cats: [],

      teams: [],          // [{ name, players: [name] }]

      groupMode: 'auto',  // 'auto' | 'custom'
      groupCount: 1,
      sizes: [],          // custom sizes
      groupPlay: [],      // per group: 0 = all play all, else rounds
      assign: {},         // teamIndex -> groupIndex

      games: [],          // [{ label, kind, home: [cat], away: [cat] }]
      creating: false,
      error: null
    };
  }

  /* ---------------------------------------------------------- helpers -- */

  function letters(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(String.fromCharCode(65 + i));
    return out;
  }

  function defaultCats(n) {
    var out = [], i;
    for (i = 0; i < n; i++) {
      out.push(String.fromCharCode(65 + Math.floor(i / 2)) + ((i % 2) + 1));
    }
    return out;
  }

  function defaultTeams(n, existing) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push(existing && existing[i]
        ? existing[i]
        : { name: 'Team ' + String.fromCharCode(65 + i), players: [] });
    }
    return out;
  }

  /* The sizes a given number of teams can be split into, as whole groups.
   * Each option says what it is in teams, not just how many boxes. */
  function splitOptions(teams) {
    var out = [], g;
    var max = Math.max(1, Math.floor(teams / 2));
    for (g = 1; g <= Math.min(8, max); g++) {
      var sizes = [], i;
      for (i = 0; i < g; i++) sizes.push(0);
      for (i = 0; i < teams; i++) sizes[i % g] += 1;
      var even = true;
      for (i = 1; i < g; i++) if (sizes[i] !== sizes[0]) even = false;
      out.push({
        count: g, sizes: sizes,
        label: g === 1 ? 'One group, all ' + teams + ' teams'
             : even ? g + ' groups of ' + sizes[0] + ' teams each'
                    : g + ' groups of ' + sizes.join(', ') + ' teams'
      });
    }
    return out;
  }

  function groupSizesOf(W) {
    if (W.groupMode === 'custom') return W.sizes.slice();
    var opt = splitOptions(W.teamCount).filter(function (o) {
      return o.count === W.groupCount; })[0];
    return opt ? opt.sizes.slice() : [W.teamCount];
  }

  /* How many teams are actually sitting in each group right now. A team
   * moved out of one group has to land in another before the shape is
   * whole again, and "Next" waits for that. */
  function currentCounts(W) {
    var sizes = groupSizesOf(W);
    var counts = sizes.map(function () { return 0; });
    for (var i = 0; i < W.teamCount; i++) {
      var g = W.assign[i] == null ? 0 : W.assign[i];
      if (counts[g] == null) counts[g] = 0;
      counts[g] += 1;
    }
    return counts;
  }

  function groupsWrong(W) {
    var want = groupSizesOf(W), have = currentCounts(W), bad = [];
    for (var i = 0; i < want.length; i++) {
      if ((have[i] || 0) !== want[i]) {
        bad.push({ i: i, want: want[i], have: have[i] || 0 });
      }
    }
    return bad;
  }

  function dealGroups(W) {
    var sizes = groupSizesOf(W);
    W.assign = {};
    var t = 0;
    for (var g = 0; g < sizes.length; g++) {
      for (var k = 0; k < sizes[g]; k++) { W.assign[t] = g; t += 1; }
    }
    while (t < W.teamCount) { W.assign[t] = sizes.length - 1; t += 1; }
    W.groupPlay = sizes.map(function (_, i) {
      return W.groupPlay[i] == null ? 0 : W.groupPlay[i];
    });
  }

  /* ----------------------------------------------------------- render -- */

  function render(S, api) {
    if (!S.wizard) S.wizard = fresh();
    var W = S.wizard;
    var way = wayOf(W.way);
    var steps = visibleSteps(W, way);
    var at = steps.indexOf(W.step);
    if (at < 0) { W.step = steps[0]; at = 0; }

    var body =
        W.step === 'basics'     ? stepBasics(W, api)
      : W.step === 'categories' ? stepCategories(W, api)
      : W.step === 'teams'      ? stepTeams(W, api)
      : W.step === 'groups'     ? stepGroups(W, api)
      :                           stepFormat(W, way, api);

    return el('div', {}, [
      api.topbar('New tournament',
        'Step ' + (at + 1) + ' of ' + steps.length, null,
        { label: at === 0 ? 'Tournaments' : 'Back',
          onclick: function () {
            if (at === 0) { S.wizard = null; api.go('home'); }
            else { W.step = steps[at - 1]; W.error = null; api.render(); }
          } }),
      el('div', { class: 'wrap stack' }, [
        progress(steps, at),
        W.error ? U.banner(W.error, 'bad') : null,
        body
      ])
    ]);
  }

  /* Categories are optional, so that step drops out when it is not wanted
   * and the count in the header stays honest. */
  function visibleSteps(W, way) {
    return STEPS.filter(function (s) {
      if (s === 'categories') return W.useCats;
      return true;
    });
  }

  function progress(steps, at) {
    return el('div', { class: 'row', style: 'gap:4px;margin-bottom:4px' },
      steps.map(function (s, i) {
        return el('div', { style: 'flex:1;height:3px;border-radius:2px;background:' +
          (i <= at ? 'var(--court)' : 'var(--rule)') });
      }));
  }

  function nextBar(label, enabled, onNext, note) {
    return el('div', { class: 'stack-s', style: 'margin-top:8px' }, [
      el('button', {
        class: 'btn btn-primary btn-lg btn-block',
        text: label, disabled: !enabled, onclick: onNext
      }),
      note ? el('p', { class: 'tiny muted', style: 'text-align:center',
        text: note }) : null
    ]);
  }

  /* A gate on a field that is being TYPED into has to be live. `nextBar`
   * works its answer out once, as the step renders, and a text input must
   * not re-render the screen under the caret - so nothing ever
   * re-evaluated it, and Next stayed grey over a name that had been typed.
   * `liveBar` hands back the bar AND a `sync` for the field's `oninput` to
   * call, which touches the button and the note under it and nothing else.
   *
   * `test` returns the reason the step cannot be left yet, or null when it
   * can; `hint` is the line shown when there is no such reason. */
  function liveBar(label, test, onNext, hint) {
    var note = el('p', { class: 'tiny muted', style: 'text-align:center' });
    var btn = el('button', {
      class: 'btn btn-primary btn-lg btn-block', text: label,
      onclick: function () { if (sync()) onNext(); }
    });
    function sync() {
      var why = test();
      btn.disabled = !!why;
      note.textContent = why || hint || '';
      note.style.display = note.textContent ? '' : 'none';
      return !why;
    }
    sync();
    return {
      el: el('div', { class: 'stack-s', style: 'margin-top:8px' }, [btn, note]),
      sync: sync
    };
  }

  /* -------------------------------------------------------- 1  basics -- */

  function stepBasics(W, api) {
    var way = wayOf(W.way);
    var total = W.teamCount * W.perTeam;
    var bar = liveBar('Next', function () {
      return String(W.name || '').trim() ? null : 'Give it a name to carry on.';
    }, function () {
      W.teams = defaultTeams(W.teamCount, W.teams);
      if (W.useCats && !W.cats.length) W.cats = defaultCats(W.perTeam);
      dealGroups(W);
      W.step = W.useCats ? 'categories' : 'teams';
      api.render();
    });

    return el('div', { class: 'stack' }, [
      el('div', { class: 'card stack' }, [
        U.field('What is it called?', U.input({
          value: W.name, placeholder: 'Sunday pickleball',
          oninput: function (e) { W.name = e.target.value; bar.sync(); }
        })),
        el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'How is it scored?' }),
          el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' },
            WAYS.map(function (w) {
              return el('button', {
                class: 'btn btn-sm' + (W.way === w.id ? ' btn-primary' : ''),
                type: 'button', text: w.label,
                onclick: function () {
                  W.way = w.id;
                  W.scoring = JSON.parse(JSON.stringify(w.scoring));
                  api.render();
                }
              });
            })),
          el('p', { class: 'tiny muted', text: way.hint })
        ])
      ]),

      el('div', { class: 'card stack' }, [
        el('div', { class: 'eyebrow', text: 'Who is playing' }),
        el('div', { class: 'grid2' }, [
          U.field('How many teams', U.numberInput(W.teamCount, function (v) {
            W.teamCount = Math.max(2, Math.min(64, v || 2));
            W.teams = defaultTeams(W.teamCount, W.teams);
            W.groupCount = 1; W.groupMode = 'auto';
            dealGroups(W);
            api.render();
          }, { min: 2, max: 64 })),
          U.field('Players in each team', U.numberInput(W.perTeam, function (v) {
            W.perTeam = Math.max(1, Math.min(26, v || 1));
            W.cats = defaultCats(W.perTeam);
            api.render();
          }, { min: 1, max: 26 }))
        ]),
        el('p', { class: 'small muted', text:
          total + ' players in all. Leave the players blank if you do not ' +
          'know them yet — names can be typed at a match instead.' })
      ]),

      el('div', { class: 'card stack-s' }, [
        el('label', { class: 'row small', style: 'cursor:pointer' }, [
          el('input', { type: 'checkbox', checked: W.useCats,
            onchange: function (e) {
              W.useCats = e.target.checked;
              if (W.useCats && !W.cats.length) W.cats = defaultCats(W.perTeam);
              api.render();
            } }),
          el('span', { text: 'Put the players in categories' })
        ]),
        el('p', { class: 'tiny muted', text:
          'A1, A2, B1 and so on. A game called AA is then played by A1 and ' +
          'A2 of each team, and the right names are filled in for you. ' +
          'Skip it if everyone just turns up and plays.' })
      ]),

      bar.el
    ]);
  }

  /* ---------------------------------------------------- 2  categories -- */

  function dupes(list) {
    var seen = {}, bad = {};
    list.forEach(function (c, i) {
      var k = String(c || '').trim().toUpperCase();
      if (!k) return;
      if (seen[k] != null) { bad[i] = true; bad[seen[k]] = true; }
      else seen[k] = i;
    });
    return bad;
  }

  /* Every keystroke used to repaint the whole step, which threw each box
   * away and built a new one - so focus went with it and "E2" had to be
   * corrected one character per tap. The boxes are built ONCE here and
   * only what actually changes is rewritten: the colour of a repeated
   * one, its note, the warning, and whether Next is live. */
  function stepCategories(W, api) {
    var boxes = [], notes = [];
    var tail = el('div', { class: 'stack' });

    function check() {
      var bad = dupes(W.cats);
      var blank = W.cats.some(function (c) { return !String(c || '').trim(); });
      var clash = Object.keys(bad).length > 0;

      boxes.forEach(function (box, i) {
        box.style.color = bad[i] ? 'var(--loss)' : '';
        box.style.fontWeight = bad[i] ? '700' : '';
        notes[i].textContent = bad[i] ? 'used twice' : '';
      });

      U.mount(tail, [
        clash ? U.banner('Two players cannot share a category. Give each one ' +
          'its own — C1 and C2 rather than C and C.', 'bad') : null,

        el('p', { class: 'tiny muted', text:
          'This is a first pass. Any game can be given different categories ' +
          'later, and any player can be moved.' }),

        nextBar('Next', !clash && !blank, function () {
          W.step = 'teams'; api.render();
        }, clash ? 'Fix the repeated categories to carry on.'
          : blank ? 'Every category needs a name.' : null)
      ]);
    }

    var rows = W.cats.map(function (c, i) {
      var note = el('span', { class: 'tiny', style: 'color:var(--loss)' });
      var box = el('input', {
        class: 'input', value: c, placeholder: 'A1',
        'data-cat': String(i),
        style: 'border:0;background:none;padding:2px 0',
        oninput: function (e) {
          /* Upper-casing by writing the value back moves the caret to the
           * end, which makes an edit in the middle of "E2" impossible. So
           * only write when it actually differs, and put the caret back
           * where the typing left it. */
          var up = String(e.target.value).toUpperCase();
          if (up !== e.target.value) {
            var at = e.target.selectionStart;
            e.target.value = up;
            try { e.target.setSelectionRange(at, at); } catch (err) {}
          }
          W.cats[i] = up;
          check();
        },
        onkeydown: function (ev) {
          if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
          ev.preventDefault();
          var next = boxes[i + 1];
          if (next) { next.focus(); next.select(); } else { ev.target.blur(); }
        }
      });
      boxes.push(box); notes.push(note);
      return el('div', { class: 'plrow' }, [
        el('span', { class: 'g', text: String(i + 1) }), box, note
      ]);
    });

    var card = el('div', { class: 'card stack' }, [
      el('div', { class: 'eyebrow', text: 'Categories' }),
      el('p', { class: 'small muted', text:
        'One per player, the same in every team. Each has to be different ' +
        '— two players cannot both be C, they are C1 and C2.' }),

      el('div', { class: 'teamcard' }, rows),

      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-sm', text: 'Pairs: A1, A2, B1…',
          onclick: function () { W.cats = defaultCats(W.perTeam); api.render(); } }),
        el('button', { class: 'btn btn-sm', text: 'One each: A, B, C…',
          onclick: function () { W.cats = letters(W.perTeam); api.render(); } })
      ])
    ]);

    check();
    return el('div', { class: 'stack' }, [card, tail]);
  }

  /* --------------------------------------------------------- 3  teams -- */

  function stepTeams(W, api) {
    var cats = W.useCats ? W.cats : null;
    var bar = liveBar('Next', function () {
      return W.teams.every(function (t) { return String(t.name || '').trim(); })
        ? null : 'Give every team a name to carry on.';
    }, function () {
      W.step = 'groups'; dealGroups(W); api.render();
    }, 'Every team needs a name. Players can wait.');

    return el('div', { class: 'stack' }, [
      el('p', { class: 'small muted', text:
        'Name the teams, and the players in them if you know them. Tap a ' +
        'team to fill in its squad.' }),

      el('div', { class: 'stack-s' }, W.teams.map(function (team, i) {
        var filled = (team.players || []).filter(function (p) {
          return String(p || '').trim(); }).length;
        return el('div', { class: 'card stack-s' }, [
          el('div', { class: 'row', style: 'gap:10px' }, [
            el('span', { class: 'swatch',
              style: 'background:' + U.colorFor(i) }),
            U.input({ value: team.name, placeholder: 'Team name',
              style: 'flex:1;min-width:0',
              oninput: function (e) {
                team.name = e.target.value; bar.sync(); } }),
            el('span', { class: 'tiny muted', style: 'flex:none',
              text: filled ? filled + ' named' : 'no names' })
          ]),
          el('button', { class: 'btn btn-ghost btn-sm',
            text: filled ? 'Edit the squad' : 'Add the squad',
            onclick: function () { squadSheet(W, team, cats, api); } })
        ]);
      })),

      bar.el
    ]);
  }

  function squadSheet(W, team, cats, api) {
    U.sheet(team.name || 'Team', function (close) {
      var host = el('div', { class: 'stack' });
      var boxes = [];
      var n = W.perTeam;

      function paint() {
        boxes = [];
        var rows = [];
        for (var i = 0; i < n; i++) {
          (function (i) {
            /* Enter goes to the next category, so a squad is typed
             * straight down the list without reaching for the next box
             * each time. On the last one it closes the keyboard rather
             * than committing, since Done is a deliberate tap. */
            var box = U.input({
              value: (team.players || [])[i] || '', placeholder: 'Name',
              style: 'border:0;background:none;padding:2px 0',
              onkeydown: function (ev) {
                if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
                ev.preventDefault();
                var next = boxes[i + 1];
                if (next) { next.focus(); next.select(); }
                else { ev.target.blur(); }
              }
            });
            boxes.push(box);
            rows.push(el('div', { class: 'plrow' }, [
              el('span', { class: 'g', text: cats ? (cats[i] || '--')
                                                  : String(i + 1) }),
              box, el('span')
            ]));
          })(i);
        }

        var paste = el('textarea', { class: 'textarea', rows: 3,
          placeholder: 'Jinay\nAmit\nPiyush' });

        U.mount(host, [
          el('p', { class: 'small muted', text: cats
            ? 'One name per category. Leave any of them blank.'
            : 'One name per player. Leave any of them blank.' }),
          /* Nobody should feel they are committing their season here.
           * The match page can move anyone between categories later,
           * for that match alone, and saying so removes the pressure
           * to get all eleven right the first time. */
          cats ? el('p', { class: 'tiny muted', text:
            'This is a starting point. Before any match you can put ' +
            'somebody else in a category, just for that match.' }) : null,
          el('div', { class: 'teamcard' }, rows),
          el('div', { class: 'stack-s', style: 'margin-top:10px' }, [
            paste,
            el('div', { class: 'row' }, [
              el('button', { class: 'btn btn-sm', text: 'Fill from the list',
                onclick: function () {
                  var names = U.parseLines(paste.value);
                  if (!names.length) return;
                  team.players = team.players || [];
                  for (var k = 0; k < n && k < names.length; k++) {
                    team.players[k] = names[k];
                  }
                  paint();
                } }),
              el('div', { class: 'spacer' }),
              el('span', { class: 'tiny muted',
                text: 'One per line, top to bottom.' })
            ])
          ]),
          el('div', { class: 'row', style: 'margin-top:16px' }, [
            el('button', { class: 'btn btn-primary', text: 'Done',
              onclick: function () {
                team.players = boxes.map(function (b) {
                  return (b.value || '').trim(); });
                close(); api.render();
              } }),
            el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
          ])
        ]);
      }
      paint();
      return host;
    });
  }

  /* -------------------------------------------------------- 4  groups -- */

  function stepGroups(W, api) {
    var opts = splitOptions(W.teamCount);
    var sizes = groupSizesOf(W);
    var wrong = groupsWrong(W);

    var picker = el('div', { class: 'stack-s' },
      opts.map(function (o) {
        return el('button', {
          class: 'preset preset-row', type: 'button',
          'aria-pressed': String(W.groupMode === 'auto' && W.groupCount === o.count),
          onclick: function () {
            W.groupMode = 'auto'; W.groupCount = o.count;
            dealGroups(W); api.render();
          }
        }, [
          el('b', { text: o.label }),
          el('span', { text: matchCount(o.sizes, W) + ' matches' })
        ]);
      }).concat([
        el('button', {
          class: 'preset preset-row', type: 'button',
          'aria-pressed': String(W.groupMode === 'custom'),
          onclick: function () {
            W.groupMode = 'custom';
            if (!W.sizes.length) W.sizes = groupSizesOf(W);
            dealGroups(W); api.render();
          }
        }, [
          el('b', { text: 'Custom groups of my own sizes' }),
          el('span', { text: 'say 4, 4 and 6' })
        ])
      ]));

    var customBox = W.groupMode === 'custom' ? el('div', { class: 'card stack-s' }, [
      U.field('Sizes, in order', U.input({
        value: W.sizes.join(', '), placeholder: '4, 4, 6',
        oninput: function (e) {
          var got = String(e.target.value).split(/[^0-9]+/)
            .map(Number).filter(function (n) { return n > 0; });
          W.sizes = got;
        },
        onchange: function () { dealGroups(W); api.render(); }
      })),
      el('p', { class: 'tiny muted', text:
        W.sizes.length
          ? W.sizes.join(' + ') + ' = ' +
            W.sizes.reduce(function (a, b) { return a + b; }, 0) +
            ' of ' + W.teamCount + ' teams'
          : 'Separate them with commas.' })
    ]) : null;

    var byGroup = sizes.map(function (size, g) {
      var inGroup = [];
      for (var i = 0; i < W.teamCount; i++) {
        if ((W.assign[i] == null ? 0 : W.assign[i]) === g) inGroup.push(i);
      }
      var have = inGroup.length;
      var full = have === size;
      var maxRounds = Math.max(1, have - 1);

      return el('div', { class: 'card stack-s' }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'eyebrow',
            text: 'Group ' + String.fromCharCode(65 + g) }),
          el('div', { class: 'spacer' }),
          el('span', { class: 'tiny', style: full ? 'color:var(--ink-3)'
                                                  : 'color:var(--loss);font-weight:700',
            text: have + ' of ' + size + ' teams' })
        ]),

        el('div', { class: 'stack-s' }, inGroup.map(function (i) {
          return el('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, [
            el('span', { class: 'swatch', style: 'background:' + U.colorFor(i) }),
            el('span', { class: 'spacer small',
              style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
              text: W.teams[i] ? W.teams[i].name : 'Team' }),
            U.select(sizes.map(function (_, k) {
              return { value: k, label: 'Group ' + String.fromCharCode(65 + k) };
            }), g, function (v) {
              W.assign[i] = Number(v); api.render();
            }, { style: 'width:auto;flex:none' })
          ]);
        })),

        /* "Six in a group but everyone plays four." The circle method
         * hands out one match per team per round, so a number of rounds
         * IS a fair partial schedule. */
        have > 2 ? el('div', { class: 'stack-s', style: 'margin-top:6px' }, [
          el('div', { class: 'eyebrow', text: 'How much they play' }),
          el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
            el('button', {
              class: 'btn btn-sm' + (!W.groupPlay[g] ? ' btn-primary' : ''),
              text: 'Everyone plays everyone',
              onclick: function () { W.groupPlay[g] = 0; api.render(); } }),
            el('button', {
              class: 'btn btn-sm' + (W.groupPlay[g] ? ' btn-primary' : ''),
              text: 'A set number of rounds',
              onclick: function () {
                W.groupPlay[g] = Math.min(maxRounds, Math.max(1, have - 2));
                api.render();
              } })
          ]),
          W.groupPlay[g] ? el('div', { class: 'row', style: 'gap:10px' }, [
            U.numberInput(W.groupPlay[g], function (v) {
              W.groupPlay[g] = Math.max(1, Math.min(maxRounds, v || 1));
              api.repaint();
            }, { min: 1, max: maxRounds }),
            el('span', { class: 'small muted', style: 'flex:1',
              text: 'rounds — every team plays ' + W.groupPlay[g] +
                    ' of the other ' + Math.max(0, have - 1) })
          ]) : null
        ]) : null
      ]);
    });

    return el('div', { class: 'stack' }, [
      el('p', { class: 'small muted', text:
        'How the ' + W.teamCount + ' teams are split up.' }),
      picker,
      customBox,
      el('div', { class: 'stack' }, byGroup),

      wrong.length ? U.banner(
        wrong.map(function (b) {
          return 'Group ' + String.fromCharCode(65 + b.i) + ' has ' + b.have +
                 ' of ' + b.want;
        }).join(', ') + '. Move teams until every group is the size you asked for.',
        'bad') : null,

      nextBar('Next', !wrong.length, function () {
        W.step = 'format'; buildGames(W, api); api.render();
      }, wrong.length ? 'Every group has to be the right size first.' : null)
    ]);
  }

  function matchCount(sizes, W) {
    var n = 0;
    sizes.forEach(function (k, g) {
      var rounds = W.groupPlay[g];
      if (rounds) n += Math.round(k * rounds / 2);
      else n += k * (k - 1) / 2;
    });
    return n;
  }

  /* -------------------------------------------------------- 5  format -- */

  function buildGames(W, api) {
    if (W.games.length) return;
    var way = wayOf(W.way);
    if (!hasGames(way)) { W.games = [{ label: 'Game', kind: 'team' }]; return; }
    W.games = [{ label: 'Game', kind: W.useCats ? 'doubles' : 'team' }];
  }

  function stepFormat(W, way, api) {
    var sc = W.scoring;

    var shapeButtons = hasGames(way) && W.useCats
      ? el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: 'What do they play' }),
          el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
            [['doubles', 'All doubles'], ['singles', 'All singles'],
             ['mix', 'A mix of both']].map(function (p) {
              return el('button', { class: 'btn btn-sm', text: p[1],
                onclick: function () { W.games = shapeGames(W, p[0]); api.render(); } });
            })),
          el('p', { class: 'tiny muted', text:
            'Built from the categories. Change any of them below.' })
        ])
      : null;

    return el('div', { class: 'stack' }, [
      el('div', { class: 'card stack' }, [
        el('div', { class: 'eyebrow', text: 'How a game is won' }),
        formatFields(way, sc, api)
      ]),

      hasGames(way) ? el('div', { class: 'card stack' }, [
        el('div', { class: 'row' }, [
          el('div', { class: 'eyebrow', text: 'Games in a match' }),
          el('div', { class: 'spacer' }),
          el('span', { class: 'tiny muted',
            text: W.games.length + (W.games.length === 1 ? ' game' : ' games') })
        ]),
        shapeButtons,
        el('div', { class: 'stack-s' }, W.games.map(function (g, i) {
          return gameRow(W, g, i, api);
        })),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn-sm', text: '+ Add a game',
            onclick: function () {
              W.games.push({ label: 'Game ' + (W.games.length + 1),
                             kind: W.useCats ? 'doubles' : 'team' });
              api.render();
            } })
        ])
      ]) : null,

      nextBar(W.creating ? 'Creating…' : 'Create the tournament',
        !W.creating, function () { create(W, api); },
        'Everything here can be changed afterwards.')
    ]);
  }

  function shapeGames(W, kind) {
    var sets = M.categoryGames(W.cats);
    if (kind === 'doubles') {
      return sets.together.concat(sets.across).map(copyGame);
    }
    if (kind === 'singles') return sets.singles.map(copyGame);
    return sets.together.concat(sets.across).concat(sets.singles).map(copyGame);
  }

  function copyGame(g) {
    return { label: g.label, kind: g.kind, points: null, sets: null };
  }

  function gameRow(W, g, i, api) {
    var need = M.playersNeeded(g.kind);
    var slots = W.useCats ? M.parseRubberLabel(g.label, W.cats) || [] : [];
    /* Only rally has a points target worth setting per game; cricket
     * counts overs and a running tally has no target at all. */
    var perGame = wayOf(W.way).engine === 'rally';

    return el('div', { class: 'card stack-s', style: 'padding:12px' }, [
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, [
        U.input({ value: g.label, placeholder: 'Name',
          style: 'flex:1;min-width:0',
          oninput: function (e) { g.label = e.target.value; } }),
        U.select(M.MATCH_KINDS.map(function (k) {
          return { value: k.id, label: k.label };
        }), g.kind, function (v) { g.kind = v; api.render(); },
          { style: 'width:auto;flex:none' }),
        el('button', { class: 'btn btn-ghost btn-sm', text: '×',
          onclick: function () {
            if (W.games.length < 2) { U.toast('A match needs a game.', 'warn'); return; }
            W.games.splice(i, 1); api.render();
          } })
      ]),

      /* Who plays it, by category. Picking the same one twice on a side
       * would field one player as two, so the clash is shown and Create
       * is not blocked on it - the label is still editable by hand. */
      (W.useCats && need)
        ? U.catPickers(W.cats, g, need, function () { api.render(); }) : null,

      (W.useCats && !need) ? el('p', { class: 'tiny muted',
        text: 'The whole team plays this one.' }) : null,

      (W.useCats && need && slots.length === need) ? el('p', { class: 'tiny muted',
        text: slots.join(' and ') + ' of each team' }) : null,

      perGame ? U.gameScoring(W.scoring, g, function () { api.render(); }) : null
    ]);
  }

  function formatFields(way, sc, api) {
    if (way.engine === 'rally') {
      return el('div', { class: 'stack-s' }, [
        el('div', { class: 'grid3' }, [
          U.field('Points to win', U.numberInput(sc.pointsToWin, function (v) {
            sc.pointsToWin = Math.max(1, v || 21); }, { min: 1, max: 999 })),
          U.field('Sets per game', U.numberInput(sc.bestOf || 1, function (v) {
            sc.bestOf = Math.max(1, v || 1); }, { min: 1, max: 9 })),
          U.field('Highest score (optional)', U.input({
            value: sc.cap == null ? '' : sc.cap, placeholder: 'no limit',
            inputmode: 'numeric',
            oninput: function (e) {
              var n = parseInt(e.target.value, 10);
              sc.cap = isNaN(n) ? null : n;
            }
          }))
        ]),
        /* Nobody knew what "Stop at" meant, and the answer only makes
         * sense once you know a game to 21 can reach 30-29. */
        el('p', { class: 'tiny muted', text:
          'A game must be won by two, so 20-20 plays on. The highest ' +
          'score ends that: at 29-29 with a highest score of 30, the ' +
          'next point takes it. Leave it blank to play on forever.' })
      ]);
    }
    if (way.engine === 'tennis') {
      return el('div', { class: 'grid2' }, [
        U.field('Sets', U.numberInput(sc.sets, function (v) {
          sc.sets = Math.max(1, v || 3); }, { min: 1, max: 5 })),
        U.field('Games in a set', U.numberInput(sc.gamesPerSet, function (v) {
          sc.gamesPerSet = Math.max(1, v || 6); }, { min: 1, max: 9 }))
      ]);
    }
    if (way.engine === 'cricket') {
      return el('div', { class: 'grid2' }, [
        U.field('Overs', U.numberInput(sc.overs, function (v) {
          sc.overs = Math.max(1, v || 20); }, { min: 1, max: 90 })),
        U.field('Wickets', U.numberInput(sc.wickets, function (v) {
          sc.wickets = Math.max(1, v || 10); }, { min: 1, max: 11 }))
      ]);
    }
    return el('p', { class: 'tiny muted', text: way.engine === 'tally'
      ? 'Tap to add a goal, then Full time when it is over.'
      : 'Type the final score when the game finishes.' });
  }

  /* ----------------------------------------------------------- create -- */

  function create(W, api) {
    W.creating = true; W.error = null; api.repaint();
    var way = wayOf(W.way);

    var t = M.makeTournament({
      name: W.name.trim(),
      sport: way.sport,
      engine: way.engine,
      scoring: W.scoring,
      tieTemplate: M.TIE_TEMPLATES.single(),
      points: way.engine === 'tally' ? M.pointsRules(3, 1, 0) : M.pointsRules(2, 1, 0)
    });

    t.config.useGrades = !!W.useCats;
    t.config.grades = W.useCats ? W.cats.slice() : [];
    t.config.detail = 'none';          // asked on the scoreboard instead
    t.players = [];

    t.entrants = W.teams.map(function (team, i) {
      var e = M.makeEntrant({
        name: String(team.name || '').trim() || 'Team ' + (i + 1),
        seed: i + 1
      });
      e.color = U.colorFor(i);
      e.members = [];
      (team.players || []).forEach(function (nm, k) {
        nm = String(nm || '').trim();
        if (!nm) return;
        var p = M.makePlayer({ name: nm });
        t.players.push(p);
        e.members.push({ playerId: p.id, slot: W.useCats ? (W.cats[k] || null) : null });
      });
      return e;
    });

    // The games inside a match.
    t.config.tieTemplate.rubbers = W.games.map(function (g) {
      var slots = W.useCats ? (M.parseRubberLabel(g.label, W.cats) || []) : [];
      var need = M.playersNeeded(g.kind);
      if (need && slots.length > need) slots = slots.slice(0, need);
      var tr = { id: M.uid('tr'), label: g.label, kind: g.kind,
                 homeSlots: slots.slice(), awaySlots: slots.slice() };
      var own = U.scoringOverrideFor(W.scoring, g);
      if (own) tr.scoringOverride = own;
      return tr;
    });

    // One stage, split the way the organiser asked.
    var sizes = groupSizesOf(W);
    var byGroup = sizes.map(function () { return []; });
    t.entrants.forEach(function (e, i) {
      var g = W.assign[i] == null ? 0 : W.assign[i];
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(e);
    });

    var stage = M.makeStage({
      name: 'Matches', type: 'roundrobin',
      groups: byGroup.map(function (list, g) {
        return {
          id: M.uid('g'),
          name: sizes.length > 1 ? 'Group ' + String.fromCharCode(65 + g) : 'League',
          entrantRefs: list.map(function (e) { return M.Ref.entrant(e.id); })
        };
      }),
      qualifyPerGroup: sizes.length > 1 ? 2 : 0
    });
    t.stages = [stage];

    var fixtures = [];
    stage.groups.forEach(function (g, gi) {
      fixtures = fixtures.concat(SCH.roundRobinFixtures({
        tournamentId: t.id, stageId: stage.id, groupId: g.id,
        entrantRefs: g.entrantRefs, legs: 1,
        rounds: W.groupPlay[gi] || 0
      }));
    });
    fixtures.forEach(function (f) { f.matchCount = W.games.length; });

    TS.store.set('tournaments/' + t.id, t).then(function () {
      return TS.store.runLimited(fixtures.map(function (f) {
        return function () {
          return TS.store.set('tournaments/' + t.id + '/fixtures/' + f.id, f);
        };
      }), 4);
    }).then(function () {
      TS.app.state.wizard = null;
      api.go('hub', { tid: t.id, tab: 'matches' });
      U.toast(t.entrants.length + ' teams, ' + fixtures.length + ' matches.');
    })['catch'](function (e) {
      W.creating = false;
      W.error = (e && e.code === 'invalid_argument')
        ? 'You have view-only access here, so a new tournament cannot be saved.'
        : 'Could not save: ' + ((e && e.message) || 'unknown error');
      api.repaint();
    });
  }

  /* Kept for the team paste in settings: a block per team, the name on its
   * own line then its players. */
  function parseBlocks(text, grades) {
    return String(text).split(/\n\s*\n/).map(function (block) {
      var lines = U.parseLines(block);
      if (!lines.length) return null;
      var name = lines[0].split(/\t|,|;/)[0].trim();
      var players = U.parseRoster(lines.slice(1).join('\n'), grades);
      players.forEach(function (p, i) {
        if (!p.grade && grades && grades[i]) p.grade = grades[i];
      });
      return { name: name, players: players };
    }).filter(Boolean);
  }

  TS.setup = { render: render, fresh: fresh, parseBlocks: parseBlocks,
               WAYS: WAYS, splitOptions: splitOptions };

})(window.TS = window.TS || {});
