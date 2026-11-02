/* Tournament Scorer - the screens
 *
 * Three tabs: Matches, Table, Teams. Anything else only turns up once it
 * has something in it.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, el = U.el;

  /* ============================================================== home == */

  /* ------------------------------------------------------- welcome -- */

  /* THREE PEOPLE OPEN THIS LINK AND THEY WANT THREE DIFFERENT THINGS.
   * Most are there to watch. A few are scoring one court. One is running
   * the whole event. The first screen used to be a list of tournaments
   * with a note underneath, which answers a question nobody asked and
   * leaves all three of them guessing. So it asks instead.
   *
   * It is NOT a gate, and that distinction is the whole design. It opens
   * BY ITSELF only where the app genuinely does not know yet - the
   * tournament is shared, this phone cannot edit, and nobody has
   * answered before. A scorer or an organiser is never stopped by it,
   * because the role they already hold IS the answer.
   *
   * But it is a SCREEN, not a one-off. Somebody who came to watch and is
   * then handed a court has to be able to say so, and a question you can
   * only answer once is a trap however politely it is worded. So
   * `welcome` is a route like any other: the list carries a back button
   * to it and it carries one back to the list. Every button on it leads
   * somewhere real, so there is nothing to dismiss either. */
  var WELCOME_KEY = 'ts1:welcomed';

  function welcomed() {
    try { return window.localStorage.getItem(WELCOME_KEY) === '1'; }
    catch (e) { return true; }   // no storage: never stand in the way
  }

  function setWelcomed() {
    try { window.localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {}
  }

  function needsWelcome(S) {
    if (S.loading || welcomed()) return false;
    var a = TS.store.access();
    /* On a lone device there is nobody else and no role to pick, and the
     * empty screen already says "start a tournament". */
    return a.shared && !a.canEdit;
  }

  function choiceIcon(kind) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ci');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var paths = kind === 'watch'
      ? ['M1.5 12S5.6 5 12 5s10.5 7 10.5 7-4.1 7-10.5 7S1.5 12 1.5 12z']
      : kind === 'score'
      ? ['M12 20h9', 'M16.4 3.6a2.12 2.12 0 0 1 3 3L7.5 18.5l-4 1 1-4z']
      : ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22V2'];
    paths.forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    if (kind === 'watch') {
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '3.1');
      svg.appendChild(c);
    }
    return svg;
  }

  function choice(kind, title, sub, onclick) {
    return el('button', { class: 'choice', type: 'button', onclick: onclick }, [
      choiceIcon(kind),
      el('span', { style: 'min-width:0' }, [
        el('span', { class: 'ct', text: title }),
        el('span', { class: 'cs', text: sub })
      ])
    ]);
  }

  function welcomeScreen(S, api) {
    var many = S.tournaments.length;
    var only = many === 1 ? S.tournaments[0] : null;

    function openOnly(tab) {
      S.stageId = null;
      api.go('hub', { tid: only.id, tab: tab || 'matches' });
    }

    return el('div', {}, [
      /* Only once somebody has been past it: a way back on the very
       * first screen points at nothing they have seen. */
      api.topbar('Tournament Scorebook', null, null,
        welcomed() ? { label: 'Tournaments',
                       onclick: function () { api.go('home'); } } : null),
      el('div', { class: 'wrap stack' }, [
        el('div', { class: 'card stack-s', style: 'text-align:center' }, [
          sportMark(),
          el('h2', { text: 'What are you here for?' }),
          el('p', { class: 'muted', text:
            'Tap one. You can change it whenever you like.' })
        ]),

        choice('watch', 'Watch the scores',
          many ? 'Every match as it is played. Nothing to set up.'
               : 'Nothing has started yet, but this is where it will appear.',
          function () {
            setWelcomed();
            if (only) openOnly(); else api.go('home');
          }),

        choice('score', 'I am scoring a match',
          'You will need the short code from whoever is organising.',
          function () {
            setWelcomed();
            if (only) { openOnly(); TS.extras.accessSheet(S, api); return; }
            api.go('home');
            U.toast(many ? 'Open the tournament you are scoring, then tap "I am scoring".'
                         : 'Nothing has been set up yet. Ask the organiser.');
          }),

        /* Opening the key sheet is not the same as holding the key, so
         * this screen does not move until the sheet says it worked. It
         * used to go to the list first and leave anybody who shut the
         * sheet again standing somewhere they had not asked to be. The
         * render is only so the way back appears, now that tapping any
         * of these counts as having been asked. */
        choice('run', 'I am running the tournament',
          'Create one, or take charge of one that is already here.',
          function () {
            setWelcomed();
            api.render();
            TS.extras.accessSheet(S, api, 'organiser', function () {
              api.go('home');
            });
          })
      ])
    ]);
  }

  function home(S, api) {
    if (needsWelcome(S)) return welcomeScreen(S, api);
    var list = S.tournaments.length
      ? el('div', { class: 'stack-s' }, S.tournaments.map(function (t) {
          return tournamentRow(t, S, api);
        }))
      /* A viewer looking at an empty list is not being invited to start
       * something - they cannot - so the screen says what it is waiting
       * for instead of offering a button that would be refused. */
      : TS.store.access().organiser
      ? el('div', { class: 'card stack welcome', style: 'text-align:center' }, [
          sportMark(),
          el('h2', { text: 'Start a tournament' }),
          el('p', { class: 'muted', text:
            'A name is all it needs. Teams, players and the games in a ' +
            'match can come later, or in the middle of one.' }),
          el('button', { class: 'btn btn-primary btn-lg', text: 'New tournament',
            onclick: function () { S.wizard = null; api.go('wizard'); } })
        ])
      : el('div', { class: 'card stack welcome', style: 'text-align:center' }, [
          sportMark(),
          el('h2', { text: 'Nothing on yet' }),
          el('p', { class: 'muted', text:
            'When the organiser starts a tournament it appears here, and ' +
            'the scores update as they are played.' })
        ]);

    return el('div', {}, [
      /* "Tournaments" rather than the app's name, because that is what
       * every other screen has always called this one - the hub's way
       * out says "< Tournaments" - and the app's name now belongs to the
       * screen in front of it.
       *
       * "Home" names the front door, which is exactly what that screen
       * is now - the first thing anybody lands on. It went out as "Menu"
       * first and that was wrong for this app, which refuses generic
       * chrome words the way it refused "Back": a menu is a thing an
       * interface has, home is a place somebody goes. "Start" was the
       * other candidate and it collides with the Start a tournament
       * button sitting on the very screen it points at. */
      api.topbar('Tournaments', modeLine(S), [
        S.tournaments.length ? U.organiserOnly(el('button', {
          class: 'btn btn-primary btn-sm', text: 'New',
          onclick: function () { S.wizard = null; api.go('wizard'); } })) : null
      ], { label: 'Home', onclick: function () { api.go('welcome'); } }),
      el('div', { class: 'wrap stack' }, [
        S.info.sharedFailed ? U.banner(
          'The shared backend is set up but did not answer, so scores are ' +
          'being saved on this device only and nobody else can see them. ' +
          'Check the Firebase config and that the rules are published.',
          'bad') :
        S.info.mode === 'local' ? U.banner(S.info.runtime
          ? 'Saved on this device only. Sign in to claude.ai on the shared link to score from several phones at once.'
          : 'Saved on this device only. Nothing leaves this phone, and anyone else opening this link starts an empty one of their own.',
          'warn') : null,
        S.pending ? U.banner(S.pending + ' change' + (S.pending > 1 ? 's' : '') +
          ' waiting for the connection. They are safe on this device.', 'warn') : null,
        S.loading ? el('p', { class: 'muted', text: 'Loading...' }) : list,
        watchingNote(S, api),
        el('div', { class: 'stack-s', style: 'margin-top:24px' }, [
          el('div', { class: 'eyebrow', text: 'Appearance' }),
          U.themePicker()
        ]),
        el('div', { class: 'row', style: 'margin-top:18px' }, [
          el('button', { class: 'btn btn-ghost btn-sm', text: 'Self test',
            onclick: function () { api.go('selftest'); } }),
          el('button', { class: 'btn btn-ghost btn-sm', text: 'Shared setup',
            onclick: function () { TS.extras.setupSheet(S, api); } })
        ])
      ])
    ]);
  }

  /* Somebody watching should be told so, once, where they will see it -
   * and told what to do if they are actually here to score. A viewer who
   * is not told simply finds that nothing they tap works. */
  function watchingNote(S, api) {
    if (TS.store.canEdit()) return null;
    var a = TS.store.access();
    return el('div', { class: 'card stack-s', style: 'margin-top:18px' }, [
      el('div', { class: 'eyebrow', text: 'You are watching' }),
      el('p', { class: 'small muted', text: a.codes
        ? 'Scores update live as they are played. If you are one of the ' +
          'scorers, the organiser has a code for you.'
        : 'Scores update live as they are played. Scoring is given out ' +
          'from the share menu of this page.' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-sm', text: 'I am scoring',
          onclick: function () { TS.extras.accessSheet(S, api); } })
      ])
    ]);
  }

  function modeLine(S) {
    return S.info.mode === 'cloud' ? 'Shared live' : 'This device only';
  }

  /* A tournament's own teams are the only identity it has, so the card
   * wears them: one stripe per team, in their colours, across the top.
   * Nothing is decorative about it - every stripe is a team that exists,
   * so a glance at the list says which tournament is the twelve-team one
   * without reading a word. */
  function teamBand(t) {
    var cols = (t.entrants || []).map(function (e) { return e.color; })
      .filter(function (c) { return !!c; });
    if (!cols.length) return null;
    return el('div', { class: 'tband' }, cols.map(function (c) {
      return el('i', { style: 'background:' + c });
    }));
  }

  /* The one screen with nothing on it is the first thing anybody sees, and
   * it was three lines of grey text. Playing surfaces in plan, drawn
   * rather than fetched: they weigh nothing, they are sharp at any size,
   * they recolour with the theme because every line is currentColor, and
   * they cannot go missing on hall wifi the way an image can.
   *
   * There are five because this app is not a pickleball app. It started
   * as one and a single court said so, which is the wrong promise to make
   * to somebody who has come to score a cricket match - the engines have
   * covered cricket and football since the day they were written. They
   * cross-fade in place rather than sliding, so it reads as one mark
   * changing its mind rather than a carousel demanding to be watched.
   *
   * All five share the 220x100 box, lying across rather than up the page:
   * a card has width to spare and no height to spare. */
  var GROUNDS = [
    /* The marking every racket sport shares - net down the middle, the
     * non-volley line either side, service boxes split behind those. */
    [['rect', { x: 2, y: 2, width: 216, height: 96, rx: 1 }],
     ['line', { x1: 110, y1: 2, x2: 110, y2: 98 }],
     ['line', { x1: 75,  y1: 2, x2: 75,  y2: 98 }],
     ['line', { x1: 145, y1: 2, x2: 145, y2: 98 }],
     ['line', { x1: 2,   y1: 50, x2: 75,  y2: 50 }],
     ['line', { x1: 145, y1: 50, x2: 218, y2: 50 }]],

    /* Cricket: boundary, the thirty-yard circle, and the square in the
     * middle with a crease at each end. */
    [['ellipse', { cx: 110, cy: 50, rx: 108, ry: 48 }],
     ['ellipse', { cx: 110, cy: 50, rx: 60,  ry: 28 }],
     ['rect', { x: 101, y: 22, width: 18, height: 56 }],
     ['line', { x1: 96, y1: 29, x2: 124, y2: 29 }],
     ['line', { x1: 96, y1: 71, x2: 124, y2: 71 }]],

    /* Football: halfway line, centre circle, penalty and six-yard boxes. */
    [['rect', { x: 2, y: 2, width: 216, height: 96 }],
     ['line', { x1: 110, y1: 2, x2: 110, y2: 98 }],
     ['circle', { cx: 110, cy: 50, r: 19 }],
     ['rect', { x: 2,   y: 22, width: 32, height: 56 }],
     ['rect', { x: 186, y: 22, width: 32, height: 56 }],
     ['rect', { x: 2,   y: 37, width: 12, height: 26 }],
     ['rect', { x: 206, y: 37, width: 12, height: 26 }]],

    /* Tennis: the doubles court outside, tramlines in, service boxes
     * split by the centre line. */
    [['rect', { x: 2, y: 2, width: 216, height: 96 }],
     ['line', { x1: 2,   y1: 13, x2: 218, y2: 13 }],
     ['line', { x1: 2,   y1: 87, x2: 218, y2: 87 }],
     ['line', { x1: 110, y1: 2,  x2: 110, y2: 98 }],
     ['line', { x1: 64,  y1: 13, x2: 64,  y2: 87 }],
     ['line', { x1: 156, y1: 13, x2: 156, y2: 87 }],
     ['line', { x1: 64,  y1: 50, x2: 156, y2: 50 }]],

    /* Basketball: the two keys, each closed by its free-throw semicircle.
     * Chord 38 against radius 19, so the arcs are true half circles. */
    [['rect', { x: 2, y: 2, width: 216, height: 96 }],
     ['line', { x1: 110, y1: 2, x2: 110, y2: 98 }],
     ['circle', { cx: 110, cy: 50, r: 17 }],
     ['rect', { x: 2,   y: 31, width: 42, height: 38 }],
     ['rect', { x: 176, y: 31, width: 42, height: 38 }],
     ['path', { d: 'M44 31 A 19 19 0 0 1 44 69' }],
     ['path', { d: 'M176 31 A 19 19 0 0 0 176 69' }]]
  ];

  function groundSvg(parts) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 220 100');
    svg.setAttribute('class', 'courtmark');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    parts.forEach(function (p) {
      var n = document.createElementNS(ns, p[0]);
      Object.keys(p[1]).forEach(function (k) { n.setAttribute(k, p[1][k]); });
      svg.appendChild(n);
    });
    return svg;
  }

  function stillPlease() {
    try {
      return !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  /* The timer dies with the screen it was drawn on. Nothing unmounts this
   * explicitly - the router simply replaces the body - so it checks each
   * time round whether it is still on the page and stops if it is not.
   * Without that, every visit to the chooser would leave another one
   * running for as long as the tab is open. */
  function sportMark() {
    var wrap = el('div', { class: 'marks' });
    var svgs = GROUNDS.map(function (parts, i) {
      var s = groundSvg(parts);
      if (i === 0) s.setAttribute('class', 'courtmark on');
      wrap.appendChild(s);
      return s;
    });
    if (svgs.length < 2 || stillPlease()) return wrap;
    var at = 0;
    var timer = window.setInterval(function () {
      if (!wrap.isConnected) { window.clearInterval(timer); return; }
      svgs[at].setAttribute('class', 'courtmark');
      at = (at + 1) % svgs.length;
      svgs[at].setAttribute('class', 'courtmark on');
    }, 3400);
    return wrap;
  }

  function tournamentRow(t, S, api) {
    var teams = (t.entrants || []).length;
    var meta = teams ? teams + (teams === 1 ? ' team' : ' teams')
                     : 'tap to set up';
    if (t.sport) meta = t.sport + '  ·  ' + meta;
    return el('button', {
      class: 'tcard', type: 'button',
      onclick: function () {
        S.stageId = null;
        api.go('hub', { tid: t.id, tab: teams ? 'matches' : 'teams' });
      }
    }, [
      teamBand(t),
      el('div', { class: 'tbody' }, [
        el('b', { class: 'tname', text: t.name }),
        el('span', { class: 'tmeta', text: meta })
      ])
    ]);
  }

  /* =============================================================== hub == */

  function hub(S, api) {
    if (!S.tournament) {
      return el('div', {}, [
        api.topbar('Tournament', null, null,
          { label: 'Tournaments', onclick: function () { api.go('home'); } }),
        el('div', { class: 'wrap' }, [
          S.tournamentLoaded
            ? U.empty('This tournament is no longer here', 'It has been deleted.',
                el('button', { class: 'btn btn-primary', text: 'Back to the list',
                               onclick: function () { api.go('home'); } }))
            : el('p', { class: 'muted', text: 'Opening...' })
        ])
      ]);
    }
    var t = S.tournament;
    var hasPlayers = S.players.length > 0;
    var hasResults = S.fixtures.some(function (f) {
      return Object.keys(f.rubberSummary || {}).length;
    });

    var tabs = [
      { id: 'matches', label: 'Matches' },
      { id: 'table', label: 'Table' },
      { id: 'teams', label: 'Teams' },
      hasPlayers && hasResults ? { id: 'players', label: 'Players' } : null,
      TS.analysis.levelOf(t) !== 'none' ? { id: 'analysis', label: 'Analysis' } : null,
      hasResults ? { id: 'feed', label: 'Feed' } : null
    ].filter(Boolean);

    if (!tabs.some(function (x) { return x.id === S.tab; })) S.tab = 'matches';

    var body;
    if (S.tab === 'table') body = tableTab(S, api);
    else if (S.tab === 'teams') body = TS.teams.panel(S, api);
    else if (S.tab === 'players') body = TS.extras.leaderboard(S, api);
    else if (S.tab === 'analysis') body = TS.uiAnalysis.panel(S, api);
    else if (S.tab === 'feed') body = TS.extras.timeline(S, api);
    else body = matchesTab(S, api);

    return el('div', {}, [
      api.topbar(t.name, subtitleFor(S), [
        el('button', { class: 'btn btn-ghost btn-sm', text: 'More',
          onclick: function () { moreMenu(S, api); } })
      ], { label: 'Tournaments', onclick: function () { api.go('home'); } }),
      el('div', { class: 'tabs' }, [
        el('div', { class: 'tabs-in' }, tabs.map(function (tb) {
          return el('button', {
            class: 'tab', role: 'tab', 'aria-selected': String(S.tab === tb.id),
            text: tb.label,
            onclick: function () { S.tab = tb.id; api.render(); }
          });
        }))
      ]),
      el('div', { class: 'wrap stack' }, [conflictBanner(S), body])
    ]);
  }

  function subtitleFor(S) {
    if (!S.fixtures.length) {
      var n = S.entrants.length;
      return n ? n + (n === 1 ? ' team' : ' teams') : 'no teams yet';
    }
    var done = S.fixtures.filter(function (f) {
      return M.countsForStandings(f.status);
    }).length;
    return done + ' of ' + S.fixtures.length + ' played · ' + modeLine(S);
  }

  function conflictBanner(S) {
    if (!S.resolved || !S.resolved.conflicts.length) return null;
    return U.banner(
      'A result changed after a later match had started, so that match kept the teams that actually played.',
      'warn');
  }

  function moreMenu(S, api) {
    U.sheet(S.tournament.name, function (close) {
      return [el('div', { class: 'stack-s' }, [
        U.managerOnly(el('button', { class: 'btn btn-block', text: 'Settings',
          onclick: function () { close(); TS.settings.sheet(S, api); } })),
        el('button', { class: 'btn btn-block', text: 'Big screen',
          onclick: function () { close(); TS.extras.bigScreen(S, api); } }),
        U.managerOnly(el('button', { class: 'btn btn-block', text: 'Backup',
          onclick: function () { close(); TS.extras.dataSheet(S, api); } })),
        el('button', { class: 'btn btn-block', text: 'Codes and access',
          onclick: function () { close(); TS.extras.accessSheet(S, api); } }),
        el('button', { class: 'btn btn-block', text: 'All tournaments',
          onclick: function () { close(); api.go('home'); } }),
        el('div', { class: 'stack-s', style: 'margin-top:10px' }, [
          el('div', { class: 'eyebrow', text: 'Appearance' }),
          U.themePicker(),
          el('p', { class: 'tiny muted', text:
            'Automatic follows this phone. Kept on this device, so two ' +
            'scorers at one match can choose differently.' })
        ]),
        el('p', { class: 'tiny muted', style: 'margin-top:8px', text:
          TS.store.mode() === 'cloud'
            ? 'Shared live. Anyone with the link at Contributor level can score; Viewers watch only.'
            : 'On this device only. Take a backup before the event.' })
      ])];
    });
  }

  /* ---------------------------------------------------------- matches -- */

  function matchesTab(S, api) {
    /* An empty screen invites whoever can fill it to do so, and tells
     * everybody else what it is waiting for. The same words cannot do
     * both jobs - and a scorer belongs with everybody else here, because
     * the teams are not theirs to enter. */
    if (S.entrants.length < 2) {
      if (!TS.store.canManage()) {
        return U.empty('The teams', 'They appear here once the organiser has entered them.');
      }
      return el('div', { class: 'card stack', style: 'text-align:center' }, [
        el('h2', { text: S.entrants.length ? 'One more team' : 'Add the teams' }),
        el('p', { class: 'muted', text:
          'Two teams is enough to start. Just the names will do.' }),
        el('button', { class: 'btn btn-primary btn-lg', text: 'Add teams',
          onclick: function () { S.tab = 'teams'; api.render(); } })
      ]);
    }

    if (!S.fixtures.length) {
      if (!TS.store.canManage()) {
        return U.empty('The matches', 'They appear here as soon as the draw is made.');
      }
      return el('div', { class: 'card stack', style: 'text-align:center' }, [
        el('h2', { text: 'Plan the rounds' }),
        el('p', { class: 'muted', text:
          'Draw the whole round robin now, or add matches one at a time as ' +
          'the day goes on.' }),
        el('div', { class: 'row', style: 'justify-content:center' }, [
          el('button', { class: 'btn btn-primary btn-lg', text: 'Plan the rounds',
            onclick: function () { TS.matches.addSheet(S, api); } })
        ])
      ]);
    }

    var stages = S.tournament.stages || [];
    var out = [];

    stages.forEach(function (stage) {
      var mine = S.fixtures.filter(function (f) { return f.stageId === stage.id; });
      if (!mine.length) return;
      var rounds = {};
      mine.forEach(function (f) { (rounds[f.round] = rounds[f.round] || []).push(f); });
      var keys = Object.keys(rounds).sort(function (a, b) { return a - b; });
      // Round headings only earn their place when a round holds more than
      // one match. Adding matches one at a time would otherwise give every
      // single match its own heading.
      var manyRounds = keys.length > 1 && keys.some(function (k) {
        return rounds[k].length > 1;
      });

      if (stage.type === 'knockout') {
        out.push(el('div', { class: 'stack-s' }, [
          el('div', { class: 'eyebrow', text: stage.name }),
          TS.stages.bracketView(S, api, stage, mine)
        ]));
        return;
      }

      out.push(el('div', { class: 'stack' }, [
        stages.length > 1 ? el('h2', { text: stage.name }) : null,
        groupsCard(S, api, stage)
      ].concat(keys.map(function (r) {
        var group = rounds[r];
        return el('div', { class: 'stack-s' }, [
          manyRounds || group[0].roundName
            ? el('div', { class: 'eyebrow',
                text: group[0].roundName || 'Round ' + r })
            : null,
          el('div', { class: 'stack-s' }, group.map(function (f) {
            return fixtureRow(f, S, api);
          }))
        ]);
      }))));
    });

    /* What a meeting actually consists of. Without this on the page there
     * is no obvious answer to "how do I make the matches inside a group". */
    var per = TS.matches.defaultMatchCount(S.tournament);
    var names = ((S.tournament.config.tieTemplate.rubbers) || [])
      .map(function (r) { return r.label; });
    out.push(el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        el('div', { style: 'min-width:0;flex:1' }, [
          el('div', { class: 'eyebrow', text: 'Every match is' }),
          el('div', { style: 'font-weight:700',
            text: per === 1 ? 'one game' : per + ' games' }),
          el('div', { class: 'tiny muted', style:
            'overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
            text: per > 1 ? names.join(', ')
                : (M.kindLabel((names.length && (S.tournament.config.tieTemplate.rubbers[0] || {}).kind) || 'team')
                   || 'Scored as one game') })
        ]),
        U.managerOnly(el('button', { class: 'btn btn-sm', text: 'Change',
          onclick: function () {
            TS.matches.setupMeeting(S, api, S.fixtures[0]);
          } }))
      ])
    ]));

    if (TS.store.canManage()) {
      out.push(el('div', { class: 'row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn',
          text: S.fixtures.length ? 'Edit the rounds' : 'Plan the rounds',
          onclick: function () { TS.matches.addSheet(S, api); } })
      ]));
    }

    /* Once a final exists there is nothing to come after it, so offering a
     * next stage would be nonsense. */
    var last = stages[stages.length - 1];
    var endsInFinal = last && S.fixtures.some(function (f) {
      return f.stageId === last.id && f.shortLabel === 'F';
    });

    /* The whole block is about changing the shape of the tournament, so
     * it is not shown at all to anybody who cannot - a viewer or a
     * scorer - rather than shown disabled. */
    if (TS.store.canManage()) out.push(endsInFinal
      ? el('div', { class: 'card stack' }, [
          el('div', { class: 'eyebrow', text: 'The end' }),
          el('p', { class: 'small muted', text:
            'This tournament finishes with the final. To change what comes ' +
            'before it, remove this stage and add a different one.' }),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn btn-sm btn-danger',
              text: 'Remove ' + last.name,
              onclick: function () { TS.stages.removeStage(S, api, last); } })
          ])
        ])
      : el('div', { class: 'card stack', style: 'margin-top:12px' }, [
          el('div', { class: 'eyebrow', text: 'After this round' }),
          el('h2', { text: 'Add the next stage' }),
          el('p', { class: 'small muted', text:
            'A Super 6, a Super 4, a knockout, or just a final. Add it now and ' +
            'the teams fill themselves in as soon as this round is done.' }),
          el('div', { class: 'row' }, [
            el('button', { class: 'btn btn-primary', text: 'Add the next stage',
              onclick: function () { TS.stages.nextStage(S, api); } }),
            stages.length > 1 ? el('button', {
              class: 'btn btn-ghost btn-sm', text: 'Remove ' + last.name,
              onclick: function () { TS.stages.removeStage(S, api, last); } }) : null
          ])
        ]));

    return el('div', { class: 'stack' }, out);
  }

  /* Who is in which group, in one place and above the rounds. The rounds
   * interleave the groups by design, so without this the only way to read
   * a group's line-up was to pick the chips off a dozen scattered rows,
   * or leave for the table. */
  function groupsCard(S, api, stage) {
    var groups = (stage.groups || []).filter(function (g) {
      return (g.entrantRefs || []).length;
    });
    if (groups.length < 2) return null;

    // refLabel resolves a placeholder like "Winner Group A" too, which a
    // later stage's groups are made of.
    var world = { stages: S.tournament.stages, entrantsById: S.entrantsById };

    return el('div', { class: 'card stack-s' }, [
      el('div', { class: 'row' }, [
        el('div', { class: 'eyebrow', text: 'The groups' }),
        el('div', { class: 'spacer' }),
        U.managerOnly(el('button', { class: 'btn btn-ghost btn-sm', text: 'Change',
          onclick: function () { TS.matches.everyone(S, api); } }))
      ])
    ].concat(groups.map(function (g) {
      var names = (g.entrantRefs || []).map(function (ref) {
        return M.refLabel(ref, world);
      });
      return el('div', { class: 'row', style: 'gap:10px;align-items:baseline' }, [
        el('div', { style: 'flex:none;min-width:62px;font-weight:700;font-size:13px',
          text: g.name }),
        el('div', { class: 'small', style: 'flex:1;min-width:0',
          text: names.join('  ·  ') })
      ]);
    })));
  }

  /* A side that has not resolved yet has no team and so no colour; the
   * CSS falls back to a plain rule for those. */
  function colourOf(S, eid) {
    var e = eid && S.entrantsById[eid];
    return e && e.color ? '--side:' + e.color : null;
  }

  function fixtureRow(f, S, api) {
    var sides = api.sidesOf(f.id);
    var count = f.matchCount == null
      ? TS.matches.defaultMatchCount(S.tournament) : f.matchCount;
    var res = S.resolved && S.resolved.resultsById[f.id];
    var hasScore = M.countsForStandings(f.status);

    /* With one match in the meeting, the meeting's score IS that match's
     * score, so show it. The matches-won tally reads "1 - 0" for every
     * result there has ever been, which says nothing the Played pill does
     * not already say. */
    var only = null;
    if (count <= 1) {
      var ks = Object.keys(f.rubberSummary || {});
      if (ks.length === 1) only = f.rubberSummary[ks[0]];
    }

    var scoreText, scoreClass = 'sc';
    if (f.status === M.STATUS.BYE) { scoreText = 'bye'; scoreClass += ' pending'; }
    else if (only && only.line && (only.complete || only.rallies)) {
      scoreText = only.line;
    }
    else if (hasScore && res) { scoreText = res.units.home + ' - ' + res.units.away; }
    else if (f.status === M.STATUS.LIVE) {
      var live = liveTally(f, count);
      scoreText = live.home + ' - ' + live.away;
    } else { scoreText = 'v'; scoreClass += ' pending'; }

    var meta = [];
    /* Rounds interleave the groups, so a list of two groups' meetings is
     * otherwise just a flat run of names with no way to read one group's
     * fixtures off it. */
    var stg = (S.tournament.stages || []).filter(function (s) {
      return s.id === f.stageId; })[0];
    if (stg && (stg.groups || []).length > 1 && f.groupId) {
      var grp = (stg.groups || []).filter(function (g) {
        return g.id === f.groupId; })[0];
      if (grp) meta.push(el('span', { class: 'tiny muted', text: grp.name }));
    }
    if (f.status === M.STATUS.LIVE) meta.push(U.pill('Live', 'live'));
    else if (hasScore) meta.push(U.pill('Played', 'done'));
    if (count > 1) {
      var n = Object.keys(f.rubberSummary || {}).length;
      meta.push(el('span', { class: 'tiny muted',
        text: n + ' of ' + count + ' games in' }));
    }

    return el('div', { style: 'display:flex;align-items:stretch;gap:6px' }, [
      el('button', {
        class: 'fx', type: 'button', style: 'flex:1',
        onclick: function () { api.go('fixture', { fid: f.id }); }
      }, [
        el('div', { class: 'side a' + (sides.home ? '' : ' tbd'),
                    style: colourOf(S, sides.home),
                    text: api.sideLabel(f, 'home') }),
        el('div', { class: scoreClass, text: scoreText }),
        el('div', { class: 'side' + (sides.away ? '' : ' tbd'),
                    style: colourOf(S, sides.away),
                    text: api.sideLabel(f, 'away') }),
        meta.length ? el('div', { class: 'fx-meta' }, meta) : null
      ]),
      U.adminOnly(el('button', {
        class: 'btn btn-ghost', style: 'padding:0 10px',
        'aria-label': 'Options', text: '⋮',
        onclick: function () { TS.matches.fixtureOptions(S, api, f); }
      }))
    ]);
  }

  function liveTally(f, count) {
    var h = 0, a = 0;
    var keys = Object.keys(f.rubberSummary || {});
    if (count <= 1) {
      var s = keys.length ? f.rubberSummary[keys[0]] : null;
      if (s && s.current) return { home: s.current.home, away: s.current.away };
      return { home: 0, away: 0 };
    }
    keys.forEach(function (rid) {
      var x = f.rubberSummary[rid];
      if (x && x.winner === 'home') h += 1;
      else if (x && x.winner === 'away') a += 1;
    });
    return { home: h, away: a };
  }

  /* ------------------------------------------------------------ table -- */

  function tableTab(S, api) {
    if (!S.resolved || !S.fixtures.length) {
      return U.empty('Standings', 'The table fills in as matches are played.');
    }
    var out = [];
    (S.tournament.stages || []).forEach(function (stage) {
      var byGroup = S.resolved.tables[stage.id] || {};
      Object.keys(byGroup).forEach(function (gid) {
        var g = (stage.groups || []).filter(function (x) { return x.id === gid; })[0];
        out.push(standingsTable(S, api, stage, g, byGroup[gid]));
      });
    });
    if (!out.length) return U.empty('Standings', 'The table fills in as matches are played.');
    return el('div', { class: 'stack' }, out);
  }

  function standingsTable(S, api, stage, group, tbl) {
    var anyMulti = S.fixtures.some(function (f) {
      return (f.matchCount == null ? 1 : f.matchCount) > 1;
    });
    var qualify = (stage.groups || []).length > 1 ? (stage.qualifyPerGroup || 0) : 0;

    /* With one match per meeting and one set in it, "sets won" is just the
     * W/L columns written again - every win is 1-0. The points are what a
     * local table is actually read for, so show those instead. Over
     * several sets, or several matches, the sets or matches won are the
     * meaningful measure and the points move to their own column. */
    var sc = (S.tournament.config && S.tournament.config.scoring) || {};
    var oneSet = !anyMulti && (sc.bestOf == null || sc.bestOf <= 1);

    /* Points difference earns its own column: it is what separates two
     * teams level on games, and winning 21-19 all day is a different
     * season from winning 21-3 all day. It sits before points scored
     * because it is the one that decides the table. */
    // Racket sports cannot draw, so that column is a row of zeroes
    // taking width the difference columns need.
    var anyDrawn = tbl.table.some(function (r) { return r.drawn > 0; });
    var head = anyDrawn ? ['', 'Team', 'P', 'W', 'D', 'L']
                        : ['', 'Team', 'P', 'W', 'L'];
    head = head.concat(anyMulti
      ? ['Won', 'Lost', '+/-', 'Pts diff', 'Pts scored']
      : ['F', 'A', '+/-']);
    head.push('Pts');

    // The last header has to be pinned with its column, or it scrolls
    // away and leaves the points sitting under somebody else's title.
    var thead = el('tr', {}, head.map(function (h, i) {
      return el('th', { class: i === 1 ? 'c-name' : i === 0 ? 'c-pos'
        : i === head.length - 1 ? 'c-pts' : '', text: h });
    }));

    var rows = tbl.table.map(function (r, i) {
      var e = S.entrantsById[r.entrantId];
      var cells = [
        el('td', { class: 'c-pos', text: String(r.rank) + (r.sharedRank ? '=' : '') }),
        el('td', { class: 'c-name' }, [
          el('span', { class: 'swatch', style: e && e.color ? 'background:' + e.color : '' }),
          el('span', { text: e ? e.name : r.entrantId })
        ]),
        el('td', { text: String(r.played) }),
        el('td', { text: String(r.won) }),
        anyDrawn ? el('td', { text: String(r.drawn) }) : null,
        el('td', { text: String(r.lost) }),
        el('td', { text: String(oneSet ? r.subFor : r.unitsFor) }),
        el('td', { text: String(oneSet ? r.subAgainst : r.unitsAgainst) }),
        el('td', { text: U.fmtSigned(oneSet ? r.subFor - r.subAgainst : r.unitsDiff) })
      ];
      if (anyMulti) {
        cells.push(el('td', { text: U.fmtSigned(r.subFor - r.subAgainst) }));
        cells.push(el('td', { text: String(r.subFor) }));
      }
      cells.push(el('td', { class: 'c-pts', text: String(round2(r.points)) }));

      var cls = [];
      if (qualify && i < qualify) cls.push('qualify');
      if (qualify && i === qualify - 1) cls.push('qline');
      return el('tr', { class: cls.join(' ') }, cells);
    });

    /* Only worth raising when it decides something. Teams level because
     * neither has played yet are not tied, they have simply not started,
     * and asking the organiser to toss a coin over them before a ball is
     * hit is noise. Where there is a qualification line, a block that sits
     * wholly above or wholly below it changes nothing either. */
    var byId = {};
    tbl.table.forEach(function (r) { byId[r.entrantId] = r; });

    var worthSettling = tbl.unresolved.filter(function (set) {
      var played = false, above = false, below = false;
      set.forEach(function (id) {
        var r = byId[id];
        if (!r) return;
        if (r.played > 0) played = true;
        var pos = tbl.table.indexOf(r);
        if (qualify && pos > -1) { if (pos < qualify) above = true; else below = true; }
      });
      if (!played) return false;
      return qualify ? (above && below) : true;
    });

    var notes = [];
    if (worthSettling.length) {
      notes.push(U.banner(
        'Level on everything: ' + worthSettling.map(function (set) {
          return set.map(function (id) { return api.entrantName(id); }).join(' and ');
        }).join('; ') + '.',
        'warn',
        el('button', { class: 'btn btn-sm', text: 'Settle',
          onclick: function () { adjudicate(S, api, worthSettling[0]); } })));
    }

    /* A stage with one group has no group worth naming - its group carries
     * the stage's own name, which read as "Super 4 · Super 4". */
    var manyStages = (S.tournament.stages || []).length > 1;
    var manyGroups = (stage.groups || []).length > 1;
    var heading = !manyStages && !manyGroups ? null
      : !manyGroups ? stage.name
      : !manyStages ? (group ? group.name : 'Table')
      : stage.name + (group && group.name !== stage.name ? ' · ' + group.name : '');

    return el('div', { class: 'stack-s' }, [
      heading ? el('div', { class: 'eyebrow', text: heading }) : null,
      el('div', { class: 'tablewrap' }, [
        el('table', { class: 't' }, [
          el('thead', {}, [thead]), el('tbody', {}, rows)
        ])
      ]),
      qualify ? el('p', { class: 'tiny muted', text: 'Top ' + qualify + ' go through.' }) : null
    ].concat(notes));
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function adjudicate(S, api, set) {
    U.sheet('Settle the order', function (close) {
      var order = set.slice();
      var list = el('div', { class: 'stack-s' });
      function paint() {
        U.mount(list, order.map(function (id, i) {
          return el('div', { class: 'row', style:
            'border:1px solid var(--rule);border-radius:8px;padding:8px 12px' }, [
            el('b', { text: String(i + 1) + '.' }),
            el('span', { class: 'spacer', text: api.entrantName(id) }),
            i > 0 ? el('button', { class: 'btn btn-sm', text: 'Up',
              onclick: function () {
                var x = order[i - 1]; order[i - 1] = order[i]; order[i] = x; paint();
              } }) : null
          ]);
        }));
      }
      paint();
      return [
        el('p', { class: 'small muted', style: 'margin-bottom:12px', text:
          'Nothing separates these teams. Put them in the order you agreed — it is saved, so everyone sees the same table.' }),
        list,
        el('div', { class: 'row', style: 'margin-top:20px' }, [
          el('button', { class: 'btn btn-primary', text: 'Save',
            onclick: function () {
              var t = JSON.parse(JSON.stringify(S.tournament));
              t.adjudications = t.adjudications || {};
              t.adjudications[set.slice().sort().join('|')] = order;
              api.saveTournament(t).then(function () {
                close(); api.recompute(); api.render();
              });
            } }),
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
        ])
      ];
    });
  }

  /* ============================================================ meeting == */

  function fixture(S, api) {
    var back = { label: 'Matches', onclick: function () {
      api.openFixture(null); api.go('hub', { tab: 'matches' });
    } };

    var f = S.fixturesById[S.fid];
    if (!f) {
      return el('div', {}, [
        api.topbar('Game', null, null, back),
        el('div', { class: 'wrap' }, [
          S.fixturesLoaded
            ? U.empty('This game is no longer here', 'It has been removed.',
                el('button', { class: 'btn btn-primary', text: 'Back to the matches',
                  onclick: function () {
                    api.openFixture(null); api.go('hub', { tab: 'matches' });
                  } }))
            : el('p', { class: 'muted', text: 'Opening...' })
        ])
      ]);
    }
    var sides = api.sidesOf(f.id);

    if (f.status === M.STATUS.BYE) {
      return el('div', {}, [
        api.topbar(api.sideLabel(f, 'home'), 'Bye', null, back),
        el('div', { class: 'wrap' }, [
          U.empty('Bye', 'Nobody to play. The team goes through.')
        ])
      ]);
    }

    if (!sides.home || !sides.away) {
      return el('div', {}, [
        api.topbar('Not decided yet', null, null, back),
        el('div', { class: 'wrap' }, [
          U.empty('Teams not known yet',
            api.sideLabel(f, 'home') + ' v ' + api.sideLabel(f, 'away') +
            '. This fills in once the earlier rounds finish.')
        ])
      ]);
    }

    TS.matches.ensure(S, api, f, sides);

    var count = f.matchCount == null
      ? TS.matches.defaultMatchCount(S.tournament) : f.matchCount;

    /* One match means there is nothing to choose: go to the scoreboard.
     * The meeting screen is still reachable from the list, for adding a
     * second match to it. */
    if (count <= 1 && !S.showMeeting) {
      if (S.rubbersLoaded && S.rubbers.length) {
        var rid = S.rubbers[0].id;
        setTimeout(function () {
          if (S.screen === 'fixture' && S.fid === f.id) {
            api.go('score', { rid: rid, fid: f.id });
          }
        }, 0);
      }
      return el('div', {}, [
        api.topbar(api.entrantName(sides.home) + '  v  ' + api.entrantName(sides.away),
          null, null, back),
        el('div', { class: 'wrap' }, [
          el('p', { class: 'muted', text: 'Opening the scoreboard...' })
        ])
      ]);
    }

    var tally = liveTally(f, count);

    var head = el('div', { class: 'card' }, [
      el('div', { class: 'row' }, [
        headSide(S, api, sides.home, true),
        el('div', { class: 'mh-score',
                    text: count > 1 ? tally.home + ' - ' + tally.away : 'v' }),
        headSide(S, api, sides.away, false)
      ]),
      count > 1 ? el('p', { class: 'mh-note', text: 'Games won' }) : null
    ]);

    var body = [head];

    if (!S.rubbersLoaded) {
      body.push(el('p', { class: 'muted', text: 'Loading...' }));
    } else if (TS.matches.settingUp(S, f)) {
      body.push(el('p', { class: 'muted', text: 'Setting the games up...' }));
    } else if (!S.rubbers.length) {
      body.push(el('div', { class: 'card stack', style: 'text-align:center' }, [
        el('p', { class: 'muted', text: 'No games in this match yet.' }),
        U.managerOnly(el('button', { class: 'btn btn-primary', text: 'Add a game',
          onclick: function () { TS.matches.addToMeeting(S, api, f); } }))
      ]));
    } else {
      body.push(el('div', { class: 'stack-s' }, S.rubbers.map(function (r) {
        return matchRow(S, api, f, r, count);
      })));
      if (TS.store.canEdit()) body.push(el('div', { class: 'row' }, [
        /* The names come first because they are what changes from one
         * match to the next: the format is set once, the line-up every
         * time somebody cannot make it. */
        el('button', { class: 'btn btn-primary', text: 'Who is playing',
          onclick: function () { TS.matches.whosPlaying(S, api, f, sides); } }),
        /* Who is on court changes every match and is a scorer's to fix;
         * what the games ARE is the tournament's shape and is not. */
        U.managerOnly(el('button', { class: 'btn', text: 'Set up the games',
          onclick: function () { TS.matches.setupMeeting(S, api, f); } })),
        el('button', { class: 'btn btn-ghost btn-sm', text: '+ Add one more',
          onclick: function () { TS.matches.addToMeeting(S, api, f); } }),
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn btn-ghost btn-sm', text: 'Remove this match',
          onclick: function () { TS.matches.removeFixture(S, api, f); } })
      ]));
    }

    return el('div', {}, [
      api.topbar(api.entrantName(sides.home) + '  v  ' + api.entrantName(sides.away),
        count > 1 ? Object.keys(f.rubberSummary || {}).length + ' of ' + count + ' scored'
                  : (f.court ? 'Court ' + f.court : null), null, back),
      el('div', { class: 'wrap stack' }, body)
    ]);
  }

  /* The same edge the feed and the board use, so one team looks like
   * itself everywhere it appears. */
  function headSide(S, api, eid, right) {
    var e = eid && S.entrantsById[eid];
    return el('div', {
      class: 'mh-side' + (right ? ' r' : ''),
      style: e && e.color ? '--side:' + e.color : null,
      text: api.entrantName(eid)
    });
  }

  function matchRow(S, api, f, r, count) {
    var sum = (f.rubberSummary || {})[r.id] || r.summary;
    var hn = U.playerNames(r.homePlayers, S.playersById, { short: true });
    var an = U.playerNames(r.awayPlayers, S.playersById, { short: true });
    var scoreText = sum && (sum.complete || sum.rallies) ? (sum.line || '') : '';

    var right = sum && sum.complete
      ? el('div', { class: 'tiny', style: 'text-align:right;color:var(--win)',
          text: sum.winner ? winnerName(S, api, f, sum.winner) + ' won' : 'Drawn' })
      : (sum && sum.rallies
          ? el('div', { class: 'tiny', style: 'text-align:right;color:var(--live)', text: 'Live' })
          : el('div', { class: 'tiny muted', style: 'text-align:right',
              text: count > 1 ? 'Tap to score' : 'Tap to start' }));

    /* Eleven of these in a column is the format this app is for, and they
     * were eleven identical rows. The edge is the colour of whoever won
     * that game, so the column itself says how the match is going. */
    var won = sum && sum.complete && sum.winner
      && S.entrantsById[api.sidesOf(f.id)[sum.winner]];
    /* A game in play is not the same as one nobody has started, and a
     * grey edge said it was. */
    var edge = (won && won.color) ||
      (sum && sum.rallies && !sum.complete ? 'var(--live)' : null);

    return el('div', { style: 'display:flex;align-items:stretch;gap:6px' }, [
      el('button', {
        class: 'rb', type: 'button',
        style: 'flex:1' + (edge ? ';--side:' + edge : ''),
        onclick: function () { api.go('score', { rid: r.id, fid: f.id }); }
      }, [
        el('div', { class: 'lbl', text: count > 1 ? r.label : 'Score' }),
        /* Nobody named yet falls back to the team, not to the match type:
         * "Ravi & Dev v Doubles" reads as though Doubles were the other
         * side. The team is who is playing either way - the individual
         * names simply have not been written down. */
        el('div', { class: 'names' }, [
          el('div', { text: hn || api.entrantName(api.sidesOf(f.id).home) ||
            M.kindLabel(r.kind) || 'no names' }),
          el('div', { class: 'vs', text: 'v  ' +
            (an || api.entrantName(api.sidesOf(f.id).away) ||
             M.kindLabel(r.kind) || 'no names') })
        ]),
        el('div', {}, [
          el('div', { class: 'rsc', text: scoreText }), right
        ])
      ]),
      count > 1 ? U.adminOnly(el('button', {
        class: 'btn btn-ghost', style: 'padding:0 10px',
        'aria-label': 'Match options', text: '⋮',
        onclick: function () { TS.matches.matchOptions(S, api, f, r); }
      })) : null
    ]);
  }

  function winnerName(S, api, f, side) {
    var e = S.entrantsById[api.sidesOf(f.id)[side]];
    return e ? (e.shortName || e.name) : (side === 'home' ? 'Home' : 'Away');
  }

  TS.views = { home: home, welcome: welcomeScreen, hub: hub, fixture: fixture,
               liveTally: liveTally };

})(window.TS = window.TS || {});
