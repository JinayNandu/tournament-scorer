/* Tournament Scorer - shared UI helpers
 *
 * Small DOM utilities plus the pieces every screen needs. The artifact frame
 * never shows alert(), confirm() or prompt(), so confirmation is built here
 * as a real part of the page.
 */
(function (TS) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style') n.setAttribute('style', v);
      else if (k.indexOf('on') === 0 && typeof v === 'function') {
        n.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    });
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function mount(node, children) {
    clear(node);
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  /* --------------------------------------------------------- overlays -- */

  function overlay() { return document.getElementById('overlay'); }

  function closeSheet() { clear(overlay()); }

  /* A bottom sheet. `build(close)` returns the body. */
  function sheet(title, build, opts) {
    opts = opts || {};
    var bg = el('div', { class: 'sheet-bg', role: 'dialog', 'aria-modal': 'true' });
    var body = el('div', { class: 'sheet' });

    /* Tapping the dark area closes the sheet - but only when the press
     * STARTED there. Selecting text in a field and releasing a few pixels
     * outside otherwise counted as a backdrop click and threw the whole
     * sheet away mid-edit. */
    var startedOutside = false;
    function down(e) { startedOutside = (e.target === bg); }
    bg.addEventListener('pointerdown', down);
    bg.addEventListener('mousedown', down);
    bg.addEventListener('touchstart', down, { passive: true });
    bg.addEventListener('click', function (e) {
      if (e.target === bg && startedOutside && opts.dismissable !== false) {
        closeSheet();
      }
      startedOutside = false;
    });
    var head = el('div', { class: 'row', style: 'margin-bottom:16px' }, [
      el('h2', { text: title }),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Close',
                     onclick: closeSheet })
    ]);
    body.appendChild(head);
    var content = build(closeSheet);
    (Array.isArray(content) ? content : [content]).forEach(function (c) {
      if (c) body.appendChild(c);
    });
    bg.appendChild(body);
    mount(overlay(), bg);
    return closeSheet;
  }

  /* confirm() returns false immediately inside the artifact frame, so this
   * is the real thing: a sheet with two buttons. */
  function confirmSheet(opts) {
    return new Promise(function (resolve) {
      sheet(opts.title || 'Are you sure?', function (close) {
        return [
          el('p', { class: 'muted', style: 'margin-bottom:20px',
                    text: opts.message || '' }),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
              text: opts.confirmLabel || 'Yes',
              onclick: function () { close(); resolve(true); }
            }),
            el('button', { class: 'btn btn-ghost', text: opts.cancelLabel || 'Cancel',
                           onclick: function () { close(); resolve(false); } })
          ])
        ];
      }, { dismissable: false });
    });
  }

  var toastTimer = null;
  function toast(message, kind) {
    var host = document.getElementById('toast-host');
    if (!host) {
      host = el('div', { id: 'toast-host', style:
        'position:fixed;left:50%;transform:translateX(-50%);z-index:200;' +
        'bottom:calc(20px + env(safe-area-inset-bottom,0px));' +
        'display:flex;flex-direction:column;gap:8px;align-items:center;' +
        'pointer-events:none;max-width:calc(100% - 32px)' });
      document.body.appendChild(host);
    }
    var t = el('div', {
      class: 'banner' + (kind === 'bad' ? ' banner-bad' : kind === 'warn' ? ' banner-warn' : ''),
      style: 'box-shadow:var(--shadow);background:var(--surface)', text: message
    });
    mount(host, t);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { clear(host); }, kind === 'bad' ? 6000 : 3200);
  }

  /* ----------------------------------------------------------- pieces -- */

  function pill(text, kind) {
    return el('span', { class: 'pill' + (kind ? ' pill-' + kind : '') }, [
      kind === 'live' ? el('span', { class: 'dot' }) : null,
      el('span', { text: text })
    ]);
  }

  /* `kind` is 'required' or 'optional', and every field should say which.
   * The label is also stashed on the control so a validation message can
   * name the field the person is actually looking at. */
  function field(label, control, kind) {
    // A label that already says "(optional)" means it; everything else has
    // to hold a value, so required is the default rather than the exception.
    if (!kind && /\(optional\)/i.test(label)) {
      kind = 'optional';
      label = label.replace(/\s*\(optional\)\s*/i, '');
    }
    kind = kind || 'required';
    var lab = el('label', {}, [el('span', { text: label })]);
    if (kind === 'required') lab.appendChild(el('b', { class: 'req', text: '*' }));
    else if (kind === 'optional') {
      lab.appendChild(el('span', { class: 'opt', text: '(optional)' }));
    }
    if (control && control.setAttribute) {
      control.setAttribute('data-field-label', label);
      if (kind === 'required') control.setAttribute('aria-required', 'true');
    }
    return el('div', { class: 'field' }, [lab, control]);
  }

  /* Say what was wrong, rather than silently correcting it. */
  function complain(control, message) {
    if (control && control.classList) {
      control.classList.add('bad');
      setTimeout(function () { control.classList.remove('bad'); }, 2000);
    }
    toast(message, 'warn');
  }

  function labelOf(control) {
    return (control && control.getAttribute &&
            control.getAttribute('data-field-label')) || 'That';
  }

  function input(attrs) {
    return el('input', Object.assign({ class: 'input', type: 'text' }, attrs || {}));
  }

  function select(options, value, onchange, attrs) {
    var s = el('select', Object.assign({ class: 'select' }, attrs || {}));
    options.forEach(function (o) {
      var opt = el('option', { value: o.value, text: o.label });
      if (String(o.value) === String(value)) opt.selected = true;
      s.appendChild(opt);
    });
    if (onchange) s.addEventListener('change', function () { onchange(s.value); });
    return s;
  }

  /* Clamps to min/max AND writes the clamped value back into the box. A
   * field that silently keeps 1 while showing 0 is worse than no limit. */
  function numberInput(value, onchange, attrs) {
    attrs = attrs || {};
    var i = el('input', Object.assign({
      class: 'input', type: 'number', value: value, inputmode: 'numeric'
    }, attrs));
    var min = attrs.min != null ? Number(attrs.min) : null;
    var max = attrs.max != null ? Number(attrs.max) : null;
    i.addEventListener('change', function () {
      var raw = i.value;
      var n = Number(raw);
      var wrong = null;
      if (raw === '' || isNaN(n)) {
        n = min == null ? 0 : min;
        wrong = labelOf(i) + ' needs a number.';
      } else if (min != null && n < min) {
        n = min;
        wrong = labelOf(i) + ' cannot be less than ' + min + '.';
      } else if (max != null && n > max) {
        n = max;
        wrong = labelOf(i) + ' cannot be more than ' + max + '.';
      } else if (n !== Math.round(n)) {
        n = Math.round(n);
        wrong = labelOf(i) + ' has to be a whole number.';
      }
      if (String(n) !== raw) i.value = String(n);
      if (wrong) complain(i, wrong + ' Set to ' + n + '.');
      if (onchange) onchange(n);
    });
    return i;
  }

  /* Which categories play one game, as a dropdown each. The label IS the
   * truth the app parses ("C1D1" means C1 and D1), so picking rewrites
   * the label rather than storing something alongside it that could
   * disagree with it. */
  function catPickers(cats, g, need, repaint) {
    var M = TS.model;
    cats = (cats || []).slice();
    var slots = M.parseRubberLabel(g.label, cats) || [];
    var picked = [];
    for (var i = 0; i < need; i++) picked.push(slots[i] || cats[i] || '');
    var clash = need > 1 && picked[0] && picked[0] === picked[1];

    return el('div', { class: 'stack-s' }, [
      el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
        picked.map(function (cur, k) {
          return select(cats.map(function (c) { return { value: c, label: c }; }),
            cur, function (v) {
              picked[k] = v;
              g.label = picked.join('');
              if (repaint) repaint();
            }, { style: 'width:auto' });
        })),
      clash ? el('p', { class: 'tiny', style: 'color:var(--loss)',
        text: 'The same player cannot partner themselves — pick two different categories.' }) : null
    ]);
  }

  /* Points and sets for ONE game, started from whatever the tournament
   * settled on. Three singles to 15 inside a match otherwise played to 21
   * is a real format, and before this the only way to it was to change
   * every game. Only a real difference is kept (`points` / `sets` stay
   * null otherwise), so a game left alone follows the tournament when the
   * tournament changes. `base` is the resolved scoring it inherits. */
  function gameScoring(base, g, onchange) {
    base = base || {};
    var dPts = base.pointsToWin || 21, dSets = base.bestOf || 1;

    function box(now, dflt, max, set) {
      return numberInput(now, function (v) {
        set(v === dflt ? null : v);
        if (onchange) onchange();
      }, { min: 1, max: max, style: 'width:76px;flex:none' });
    }

    return el('div', { class: 'row', style: 'gap:10px;align-items:flex-end;flex-wrap:wrap' }, [
      el('label', { class: 'minifield' }, [
        el('span', { class: 'tiny muted', text: 'Points' }),
        box(g.points == null ? dPts : g.points, dPts, 999,
            function (v) { g.points = v; })
      ]),
      el('label', { class: 'minifield' }, [
        el('span', { class: 'tiny muted', text: 'Sets' }),
        box(g.sets == null ? dSets : g.sets, dSets, 9,
            function (v) { g.sets = v; })
      ]),
      (g.points != null || g.sets != null)
        ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button',
            text: 'Back to ' + dPts + (dSets > 1 ? ' · ' + dSets + ' sets' : ''),
            onclick: function () {
              g.points = null; g.sets = null;
              if (onchange) onchange();
            } })
        : el('span', { class: 'tiny muted', text: 'same as the tournament' })
    ]);
  }

  /* The full scoring object for a game that differs - the resolve chain
   * REPLACES rather than merges, so an override has to carry the lot. */
  function scoringOverrideFor(base, g) {
    if (g.points == null && g.sets == null) return null;
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    if (g.points != null) out.pointsToWin = g.points;
    if (g.sets != null) out.bestOf = g.sets;
    return out;
  }

  /* The other way round: what a stored override says, for a sheet that
   * has to show it again. */
  function gameScoringOf(base, override) {
    base = base || {};
    if (!override) return { points: null, sets: null };
    return {
      points: override.pointsToWin === base.pointsToWin ? null : override.pointsToWin,
      sets: (override.bestOf || 1) === (base.bestOf || 1) ? null : (override.bestOf || 1)
    };
  }

  /* For the handful of text boxes that genuinely cannot be left blank. */
  function requireText(control, what) {
    var v = (control && control.value || '').trim();
    if (v) return v;
    complain(control, (what || labelOf(control)) + ' cannot be empty.');
    if (control && control.focus) control.focus();
    return null;
  }

  function empty(title, message, action) {
    return el('div', { class: 'empty' }, [
      el('h2', { text: title }),
      el('p', { class: 'muted', style: 'margin-bottom:20px', text: message }),
      action || null
    ]);
  }

  function banner(message, kind, action) {
    return el('div', {
      class: 'banner' + (kind ? ' banner-' + kind : '')
    }, [
      el('div', { class: 'spacer', text: message }),
      action || null
    ]);
  }

  /* --------------------------------------------------------- formatting -- */

  // "A Smith" from "Arjun Smith" - keeps 11 names legible on a phone.
  function shortName(full) {
    if (!full) return '';
    var p = String(full).trim().split(/\s+/);
    if (p.length === 1) return p[0];
    return p[0][0].toUpperCase() + ' ' + p[p.length - 1];
  }

  function playerNames(ids, playersById, opts) {
    var sep = (opts && opts.sep) || ' & ';
    return (ids || []).map(function (id) {
      var p = playersById[id];
      if (!p) return '?';
      return (opts && opts.short) ? shortName(p.name) : p.name;
    }).join(sep);
  }

  function fmtSigned(n) {
    if (n > 0) return '+' + n;
    return String(n);
  }

  function fmtRate(n) {
    if (!isFinite(n)) return '-';
    return (n >= 0 ? '+' : '') + n.toFixed(3);
  }

  /* Parse a pasted block of names. Accepts one per line, tab or comma
   * separated columns (so a paste straight out of Excel works), and an
   * optional leading grade: "A1  Ravi Kumar" or "Ravi Kumar, A1". */
  function parseRoster(text, grades) {
    var gradeSet = {};
    (grades || []).forEach(function (g) { gradeSet[g.toUpperCase()] = g; });
    return String(text).split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean).map(function (line) {
      var cells = line.split(/\t|,|;/).map(function (c) { return c.trim(); })
                      .filter(Boolean);
      var grade = null, name = null;
      if (cells.length >= 2) {
        if (gradeSet[cells[0].toUpperCase()]) { grade = gradeSet[cells[0].toUpperCase()]; name = cells.slice(1).join(' '); }
        else if (gradeSet[cells[cells.length - 1].toUpperCase()]) {
          grade = gradeSet[cells[cells.length - 1].toUpperCase()];
          name = cells.slice(0, -1).join(' ');
        } else { name = cells.join(' '); }
      } else {
        var m = /^([A-Za-z]\d*)\s+(.{2,})$/.exec(cells[0] || '');
        if (m && gradeSet[m[1].toUpperCase()]) { grade = gradeSet[m[1].toUpperCase()]; name = m[2]; }
        else name = cells[0];
      }
      return { name: (name || '').trim(), grade: grade };
    }).filter(function (r) { return r.name; });
  }

  // A paste of team names, one per line.
  function parseLines(text) {
    return String(text).split(/\r?\n/).map(function (l) { return l.trim(); })
      .filter(Boolean);
  }

  // "AA, BB, C1D1" or one per line.
  /* "Make the games from the categories". The categories already say who
   * is in a team, so the game list follows from them and nobody types
   * AA, BB, C1D1 by hand - nor has to remember which labels the parser
   * understands. `apply(list)` receives the new list of {label, kind}. */
  function categoryBuilder(tournament, apply) {
    var M = TS.model;
    if (!tournament || !(tournament.config || {}).useGrades) return null;
    var sets = M.categoryGames(M.gradesOf(tournament));

    var options = [
      { key: 'together', label: 'Each pair together',
        note: 'A1 and A2 play as a pair, B1 and B2, and so on',
        games: sets.together },
      { key: 'across', label: 'Pairs split across',
        note: 'A1 with B1, A2 with B2, C1 with D1', games: sets.across },
      { key: 'singles', label: 'Everyone in singles',
        note: 'One game per category, each against their opposite number',
        games: sets.singles }
    ].filter(function (o) { return o.games.length; });

    if (!options.length) return null;

    var chosen = {};
    function current() {
      var out = [];
      options.forEach(function (o) {
        if (!chosen[o.key]) return;
        o.games.forEach(function (g) {
          out.push({ label: g.label, kind: g.kind });
        });
      });
      return out;
    }

    var countLine = el('p', { class: 'tiny muted', text: '' });
    function refresh() {
      var n = current().length;
      countLine.textContent = n
        ? n + (n === 1 ? ' game' : ' games') + ', taken from the categories.'
        : 'Pick one or more and they become the games below.';
    }

    var rows = options.map(function (o) {
      return el('button', {
        class: 'preset', type: 'button', 'aria-pressed': 'false',
        onclick: function () {
          chosen[o.key] = !chosen[o.key];
          this.setAttribute('aria-pressed', String(!!chosen[o.key]));
          refresh();
          var list = current();
          if (list.length) apply(list);
        }
      }, [
        el('b', { text: o.label }),
        el('span', { text: o.note + '  ·  ' +
          o.games.map(function (g) { return g.label; }).join(', ') })
      ]);
    });
    refresh();

    return el('div', { class: 'stack-s', style: 'margin-bottom:16px' }, [
      el('div', { class: 'eyebrow', text: 'Make them from the categories' })
    ].concat(rows).concat([countLine]));
  }

  function parseLabels(text) {
    return String(text).split(/[\n,;]/).map(function (l) { return l.trim(); })
      .filter(Boolean);
  }

  /* Distinct, legible team colours. Chroma is scarce in this design, so the
   * only place it appears is identifying a team. */
  var PALETTE = ['#0E6E66', '#B4531C', '#2F5E9E', '#7A3E86', '#9A7510',
                 '#357A3C', '#A33A4E', '#1F6C86', '#6A5D2E', '#8A3F2A',
                 '#44608C', '#785338'];
  function colorFor(i) { return PALETTE[i % PALETTE.length]; }

  function download(filename, text) {
    // The artifact frame blocks page-initiated downloads, so offer the text
    // for copying instead of pretending a file was saved.
    return { filename: filename, text: text };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
        function () { return false; });
    }
    return Promise.resolve(false);
  }

  TS.ui = {
    esc: esc, el: el, clear: clear, mount: mount,
    sheet: sheet, closeSheet: closeSheet, confirmSheet: confirmSheet, toast: toast,
    pill: pill, field: field, input: input, select: select,
    numberInput: numberInput, empty: empty, banner: banner,
    complain: complain, requireText: requireText, labelOf: labelOf,
    shortName: shortName, playerNames: playerNames,
    fmtSigned: fmtSigned, fmtRate: fmtRate,
    parseRoster: parseRoster, parseLines: parseLines, parseLabels: parseLabels,
    categoryBuilder: categoryBuilder, catPickers: catPickers,
    gameScoring: gameScoring, scoringOverrideFor: scoringOverrideFor,
    gameScoringOf: gameScoringOf,
    colorFor: colorFor, PALETTE: PALETTE,
    download: download, copyText: copyText
  };

})(window.TS = window.TS || {});
