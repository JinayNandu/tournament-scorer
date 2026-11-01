/* Tournament Scorer - teams
 *
 * A team needs a name. Everything else - a colour, a badge, who plays for
 * it - is there if you want it and ignored if you don't.
 */
(function (TS) {
  'use strict';

  var U = TS.ui, M = TS.model, el = U.el;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------------------------ panel -- */

  function panel(S, api) {
    if (!S.entrants.length) return emptyState(S, api);

    return el('div', { class: 'stack' }, [
      el('div', { class: 'stack-s' }, S.entrants.map(function (e) {
        var players = (e.members || []).length;
        return el('button', {
          class: 'fx', type: 'button',
          style: 'grid-template-columns:auto 1fr auto;text-align:left',
          onclick: function () { teamSheet(S, api, e.id); }
        }, [
          badge(e),
          el('div', { style: 'min-width:0' }, [
            el('div', { class: 'tr-name', text: e.name }),
            el('div', { class: 'tr-meta', text: players
              ? players + (players === 1 ? ' player' : ' players')
              : 'no players yet' })
          ]),
          el('span', { class: 'tr-go', text: 'Edit' })
        ]);
      })),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', text: 'Add teams',
          onclick: function () { addSheet(S, api); } })
      ]),
      nextStep(S, api)
    ]);
  }

  /* With teams in and no matches yet, the next move has to be obvious -
   * otherwise the screen is a dead end with two "add more teams" buttons. */
  function nextStep(S, api) {
    if (S.entrants.length < 2) {
      return el('p', { class: 'small muted', style: 'text-align:center',
        text: 'One more team and you can start adding matches.' });
    }
    if (S.fixtures.length) {
      return el('div', { class: 'row', style: 'justify-content:center' }, [
        el('button', { class: 'btn btn-ghost', text: 'Back to the matches',
          onclick: function () { S.tab = 'matches'; api.render(); } })
      ]);
    }
    return el('div', { class: 'card stack', style: 'text-align:center;margin-top:8px' }, [
      el('div', { class: 'eyebrow', text: 'Next' }),
      el('h2', { text: 'Plan the rounds' }),
      el('p', { class: 'small muted', text:
        S.entrants.length + ' teams are in. Draw the whole round robin now, ' +
        'or add matches one at a time as the day goes on.' }),
      el('div', { class: 'row', style: 'justify-content:center' }, [
        el('button', { class: 'btn btn-primary btn-lg', text: 'Plan the rounds',
          onclick: function () { TS.matches.addSheet(S, api); } })
      ])
    ]);
  }

  /* The same white-on-the-team's-colour the scoreboard puts behind a name,
   * at list size. Every colour in PALETTE clears 4.5:1 against white, which
   * is what lets this be one treatment rather than a light and a dark one. */
  function badge(e) {
    var label = e.logo || e.shortName || M.shortLabel(e.name);
    return el('span', {
      class: 'tbadge',
      style: e.color ? 'background:' + e.color : null,
      text: String(label).slice(0, 3)
    });
  }

  function emptyState(S, api) {
    var box = el('textarea', { class: 'textarea', rows: 6,
      placeholder: 'Thunder paddles\nMonaco\nNorth End\nHarbour' });
    return el('div', { class: 'card stack' }, [
      el('h2', { text: 'Who is playing?' }),
      el('p', { class: 'small muted', text:
        'Just the team names, one per line. Players, colours and badges are all optional and can come later.' }),
      box,
      el('div', { class: 'row' }, [
        el('button', { class: 'btn btn-primary btn-lg', text: 'Add these teams',
          onclick: function () { addFromText(S, api, box.value); } })
      ])
    ]);
  }


  function addFromText(S, api, text) {
    var names = U.parseLines(text || '').map(function (l) {
      return l.split(/\t|,|;/)[0].trim();
    }).filter(Boolean);
    if (!names.length) { U.toast('Nothing to add.', 'warn'); return; }

    var t = clone(S.tournament);
    t.entrants = t.entrants || [];
    names.forEach(function (name) {
      t.entrants.push(M.makeEntrant({
        name: name, color: U.colorFor(t.entrants.length),
        seed: t.entrants.length + 1, members: []
      }));
    });
    TS.matches.ensureLeague(t);
    api.saveTournament(t).then(function () {
      api.recompute(); api.render();
      U.toast(names.length + (names.length === 1 ? ' team added.' : ' teams added.'));
    });
  }

  /* One box for one team or twenty - two separate buttons for "add" and
   * "paste" was a distinction nobody needed to make. */
  function addSheet(S, api) {
    U.sheet('Add teams', function (close) {
      var box = el('textarea', { class: 'textarea', rows: 5,
        placeholder: 'Thunder paddles\nMonaco\nNorth End' });
      return [
        U.field('Team names, one per line', box),
        el('p', { class: 'tiny muted', text:
          'Add one or add the whole league at once. Names can be changed later.' }),
        el('div', { class: 'row', style: 'margin-top:16px' }, [
          el('button', { class: 'btn btn-primary', text: 'Add',
            onclick: function () {
              if (!U.requireText(box, 'Team names')) return;
              close(); addFromText(S, api, box.value);
            } }),
          el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close })
        ])
      ];
    });
  }

  /* ------------------------------------------------------- one team ---- */

  function teamSheet(S, api, entrantId) {
    var t = clone(S.tournament);
    var e = (t.entrants || []).filter(function (x) { return x.id === entrantId; })[0];
    if (!e) return;

    /* Read from the copy being edited, not the live tournament, so the
     * category boxes appear the moment the switch is flicked rather than
     * after a save-and-reopen. */
    function cats() { return !!(t.config || {}).useGrades; }

    U.sheet(e.name, function (close) {
      var host = el('div', { class: 'stack' });
      var nameBox = U.input({ value: e.name,
        oninput: function (ev) {
          e.name = ev.target.value;
          e.shortName = M.shortLabel(ev.target.value);
        } });
      var logoBox = U.input({ value: e.logo || '', maxlength: 3,
        placeholder: e.shortName || '',
        oninput: function (ev) { e.logo = ev.target.value.trim() || null; } });

      function colours() {
        return el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' },
          U.PALETTE.map(function (c) {
            return el('button', {
              type: 'button',
              'aria-label': 'colour',
              style: 'width:34px;height:34px;border-radius:9px;cursor:pointer;' +
                     'background:' + c + ';border:3px solid ' +
                     (e.color === c ? 'var(--ink)' : 'transparent'),
              onclick: function () { e.color = c; paint(); }
            });
          }));
      }

      var pendingBox = null;

      function playerOf(m) {
        return (t.players || []).filter(function (x) {
          return x.id === m.playerId; })[0];
      }

      function nameBoxFor(m) {
        var p = playerOf(m);
        return el('input', { class: 'input',
          style: 'border:0;background:none;padding:2px 0',
          value: p ? p.name : '', placeholder: 'Name',
          oninput: function (ev) { if (p) p.name = ev.target.value; } });
      }

      /* With categories on, every category gets a row whether or not
       * anyone is in it yet, so filling a squad is typing names down a
       * list the tournament already decided. Without them it is just the
       * players, numbered. */
      function playerRows() {
        var members = e.members || [];
        if (!cats()) {
          return members.map(function (m, i) {
            return el('div', { class: 'plrow' }, [
              el('span', { class: 'g', text: String(i + 1) }),
              nameBoxFor(m),
              el('button', { class: 'btn btn-ghost btn-sm', text: '×',
                onclick: function () { members.splice(i, 1); paint(); } })
            ]);
          });
        }

        var taken = {};
        var rows = M.gradesOf(t).map(function (slot) {
          var m = null, i;
          for (i = 0; i < members.length; i++) {
            if (members[i].slot === slot && !taken[i]) { m = members[i]; taken[i] = true; break; }
          }
          return el('div', { class: 'plrow' }, [
            el('span', { class: 'g', text: slot }),
            m ? nameBoxFor(m) : el('input', { class: 'input',
              style: 'border:0;background:none;padding:2px 0',
              value: '', placeholder: 'Name',
              onchange: function (ev) {
                var name = (ev.target.value || '').trim();
                if (!name) return;
                var pl = M.makePlayer({ name: name });
                t.players = t.players || [];
                t.players.push(pl);
                members.push({ playerId: pl.id, slot: slot });
                paint();
              } }),
            m ? el('button', { class: 'btn btn-ghost btn-sm', text: '×',
              onclick: function () {
                members.splice(members.indexOf(m), 1); paint();
              } }) : el('span')
          ]);
        });

        // Anyone who does not sit in a category still belongs to the team.
        members.forEach(function (m, i) {
          if (taken[i]) return;
          rows.push(el('div', { class: 'plrow' }, [
            el('span', { class: 'g muted', text: '--' }),
            nameBoxFor(m),
            el('button', { class: 'btn btn-ghost btn-sm', text: '×',
              onclick: function () { members.splice(i, 1); paint(); } })
          ]));
        });
        return rows;
      }

      /* One box for one player or the whole squad, the same bargain the
       * team box makes. Typing eleven names into eleven separate fields,
       * twelve times over, is where a 132-player tournament dies. */
      function addBoxRow() {
        /* Enter makes a new line and NOTHING else - the whole squad goes
         * in before anything is committed, the same bargain the team box
         * makes. Binding Enter to "add" meant the first name was taken
         * the moment it was typed and the box emptied under the next one,
         * which is no way to enter eleven players. */
        var box = el('textarea', { class: 'textarea', rows: 4,
          placeholder: 'Ravi\nDev\nPriya' });
        pendingBox = box;
        return el('div', { class: 'stack-s', style: 'margin-top:8px' }, [
          box,
          el('div', { class: 'row' }, [
            el('button', { class: 'btn', text: 'Add',
              onclick: function () {
                if (addPlayers(box.value)) { box.value = ''; paint(); }
              } }),
            el('div', { class: 'spacer' }),
            el('span', { class: 'tiny muted', text: cats()
              ? 'One per line. They drop into the empty categories in order.'
              : 'One per line, or paste the whole squad at once.' })
          ])
        ]);
      }

      /* "A1 Ravi", "Ravi A1", "A1, Ravi" or just "Ravi". A leading or
       * trailing token only counts as a grade if it is actually one, so a
       * player called Jo B is still called Jo B. */
      function parseLine(line) {
        var s = String(line).replace(/\s+/g, ' ').trim();
        if (!s) return null;
        if (!cats()) return { name: s, slot: null };
        var known = {};
        M.gradesOf(t).forEach(function (g) { known[String(g).toUpperCase()] = String(g); });
        var m = /^([A-Za-z][0-9]*)[,:\-]?\s+(.+)$/.exec(s);
        if (m && known[m[1].toUpperCase()]) {
          return { name: m[2].trim(), slot: known[m[1].toUpperCase()] };
        }
        m = /^(.+?)[,:\-]?\s+([A-Za-z][0-9]*)$/.exec(s);
        if (m && known[m[2].toUpperCase()]) {
          return { name: m[1].trim(), slot: known[m[2].toUpperCase()] };
        }
        return { name: s, slot: null };
      }

      /* The first category nobody is in yet. A pasted list of plain names
       * fills them top to bottom, which is the whole point of setting the
       * categories once for the tournament. */
      function nextFreeSlot() {
        var used = {};
        (e.members || []).forEach(function (m) { if (m.slot) used[m.slot] = true; });
        var all = M.gradesOf(t);
        for (var i = 0; i < all.length; i++) if (!used[all[i]]) return all[i];
        return null;
      }

      function addPlayers(text) {
        var lines = String(text || '').split(/[\r\n]+/);
        var added = 0;
        lines.forEach(function (line) {
          var p = parseLine(line);
          if (!p || !p.name) return;
          var pl = M.makePlayer({ name: p.name });
          t.players = t.players || [];
          t.players.push(pl);
          e.members = e.members || [];
          // A line that named its own category keeps it; a plain name
          // takes the next category nobody is in yet.
          e.members.push({ playerId: pl.id,
            slot: p.slot || (cats() ? nextFreeSlot() : null) });
          added += 1;
        });
        return added > 0;
      }

      /* Whatever is still in the box when Save is pressed goes in too. The
       * box deliberately does not commit on blur: that re-rendered the
       * sheet and destroyed the Save button under the thumb pressing it,
       * so the tap went nowhere and Save looked broken. */
      function commitPending() {
        if (pendingBox && addPlayers(pendingBox.value)) { pendingBox.value = ''; }
      }

      function paint() {
        U.mount(host, [
          U.field('Name', nameBox),
          el('div', { class: 'stack-s' }, [
            el('div', { class: 'eyebrow', text: 'Colour' }), colours()
          ]),
          el('div', { class: 'stack-s' }, [
            U.field('Badge (optional)', logoBox),
            el('p', { class: 'tiny muted', text:
              'Up to three letters, or an emoji. Left blank it uses the initials.' })
          ]),
          el('div', { class: 'stack-s' }, [
            el('div', { class: 'row' }, [
              el('div', { class: 'eyebrow', text: 'Players (optional)' }),
              el('div', { class: 'spacer' }),
              el('span', { class: 'tiny muted', text:
                'You can also add them when a match starts' })
            ]),
            el('div', { class: 'teamcard' }, playerRows()),
            addBoxRow(),

            /* The switch sits here, not only in Settings, because this is
             * where you are looking at a list of players and thinking
             * "these two are our A pair". Buried under Settings it was
             * never found, so the games named AA and C1D1 picked nobody
             * and every squad in the app went unused. */
            cats()
              ? el('div', { class: 'row' }, [
                  el('span', { class: 'tiny muted', style: 'flex:1;min-width:0',
                    text: 'Categories: ' + M.gradesOf(t).join(', ') }),
                  el('button', { class: 'btn btn-ghost btn-sm', text: 'Change',
                    onclick: function () {
                      // Saving the categories saves the tournament, so
                      // anything typed here would be lost behind it.
                      commitPending();
                      api.saveTournament(t).then(function () {
                        close();
                        TS.settings.categories(S, api);
                      });
                    } })
                ])
              : el('button', { class: 'btn btn-block', text: 'Use player categories',
                  onclick: function () {
                    commitPending();
                    api.saveTournament(t).then(function () {
                      close();
                      TS.settings.categories(S, api);
                    });
                  } }),
            el('p', { class: 'tiny muted', text: cats()
              ? 'A game called AA is played by A1 and A2, C1D1 by C1 and D1. ' +
                'Name the games that way and the right people are picked for you.'
              : 'Set the slots every team fills — A1, A2, B1 and so on — then ' +
                'a game named AA or C1D1 picks those players itself.' })
          ]),
          el('div', { class: 'row', style: 'margin-top:10px' }, [
            el('button', { class: 'btn btn-primary', text: 'Save',
              onclick: function () {
                commitPending();
                var used = {};
                (t.entrants || []).forEach(function (x) {
                  (x.members || []).forEach(function (m) { used[m.playerId] = true; });
                });
                t.players = (t.players || []).filter(function (p) { return used[p.id]; });
                TS.matches.ensureLeague(t);
                api.saveTournament(t).then(function () {
                  close(); api.recompute(); api.render();
                });
              } }),
            el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }),
            el('div', { class: 'spacer' }),
            el('button', { class: 'btn btn-sm btn-danger', text: 'Remove team',
              onclick: function () { close(); removeTeam(S, api, entrantId); } })
          ])
        ]);
      }

      paint();
      return host;
    });
  }

  function removeTeam(S, api, entrantId) {
    var playing = S.fixtures.filter(function (f) {
      var s = api.sidesOf(f.id);
      return s.home === entrantId || s.away === entrantId;
    });
    U.confirmSheet({
      title: 'Remove this team?', danger: true,
      message: playing.length
        ? 'It is in ' + playing.length + ' match' + (playing.length > 1 ? 'es' : '') +
          ', which will be removed too.'
        : 'It is not in any match yet.',
      confirmLabel: 'Remove'
    }).then(function (yes) {
      if (!yes) return;
      var t = clone(S.tournament);
      t.entrants = (t.entrants || []).filter(function (x) { return x.id !== entrantId; });
      var used = {};
      t.entrants.forEach(function (x) {
        (x.members || []).forEach(function (m) { used[m.playerId] = true; });
      });
      t.players = (t.players || []).filter(function (p) { return used[p.id]; });
      TS.matches.ensureLeague(t);
      api.saveTournament(t).then(function () {
        return TS.store.runLimited(playing.map(function (f) {
          return function () {
            return TS.store.del('tournaments/' + S.tid + '/fixtures/' + f.id);
          };
        }), 4);
      }).then(function () {
        api.recompute(); api.render(); U.toast('Team removed.');
      }).catch(api.writeFailed);
    });
  }

  TS.teams = { panel: panel, teamSheet: teamSheet, addSheet: addSheet,
               badge: badge, addFromText: addFromText };

})(window.TS = window.TS || {});
