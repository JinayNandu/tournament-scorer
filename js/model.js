/* Tournament Scorer - model
 *
 * Shapes, ids, the status lifecycle, scoring-config resolution, sport presets
 * and schema migration. Pure: no DOM, no storage. Everything here is callable
 * from selftest.js.
 *
 * The one idea the whole app rests on: EVERY fixture is a tie holding 1..N
 * rubbers. Football and cricket are a tie with exactly one rubber. The
 * pickleball league is a tie with eleven. Nothing downstream special-cases
 * either shape.
 */
(function (TS) {
  'use strict';

  var SCHEMA_VERSION = 3;

  /* ---------------------------------------------------------------- ids -- */

  var _seq = 0;
  function uid(prefix) {
    _seq = (_seq + 1) % 100000;
    return (prefix || 'x') + '_' +
      Date.now().toString(36) +
      _seq.toString(36) +
      Math.random().toString(36).slice(2, 6);
  }

  /* ------------------------------------------------------------- status -- */

  var STATUS = {
    SCHEDULED:  'scheduled',
    LIVE:       'live',
    COMPLETED:  'completed',
    CONFIRMED:  'confirmed',   // organiser locked it; progression reads these
    WALKOVER:   'walkover',    // a side did not field players
    AWARDED:    'awarded',     // decided off the court
    NO_RESULT:  'noResult',    // rain, light, abandoned mid-match
    BYE:        'bye',         // odd draw; no match was played
    NOT_PLAYED: 'notPlayed',   // dead rubber, tie already clinched
    VOID:       'void'         // struck from the record entirely
  };

  // Statuses whose result is real enough to move a league table.
  var STANDINGS_STATUSES = [
    STATUS.COMPLETED, STATUS.CONFIRMED, STATUS.WALKOVER,
    STATUS.AWARDED, STATUS.NO_RESULT
  ];
  function countsForStandings(status) {
    return STANDINGS_STATUSES.indexOf(status) !== -1;
  }

  // Statuses settled enough to resolve "Winner of Group A" against. Strictly
  // that is CONFIRMED only, but nobody running a social league wants to
  // confirm 66 ties by hand, so autoConfirm (default on) accepts COMPLETED.
  function isSettled(status, autoConfirm) {
    if (status === STATUS.CONFIRMED || status === STATUS.WALKOVER ||
        status === STATUS.AWARDED || status === STATUS.BYE) return true;
    return autoConfirm !== false && status === STATUS.COMPLETED;
  }

  /* -------------------------------------------------------- entrant refs -- */

  /* A fixture side is a reference, not an id. That way the whole schedule
   * exists and prints on day zero, with "Runner-up Group B" where the team
   * will be. Refs always point BACKWARDS; nothing writes forward when a match
   * ends, so a phone finishing a semi-final never cascades writes. */

  var Ref = {
    entrant: function (entrantId) {
      return { kind: 'entrant', entrantId: entrantId };
    },
    groupPosition: function (stageId, groupId, position, label) {
      return { kind: 'groupPosition', stageId: stageId, groupId: groupId,
               position: position, label: label || null };
    },
    bestOfRank: function (stageId, position, rank, label) {
      return { kind: 'bestOfRank', stageId: stageId, position: position,
               rank: rank, label: label || null };
    },
    stageRank: function (stageId, position, label) {
      return { kind: 'stageRank', stageId: stageId, position: position,
               label: label || null };
    },
    fixtureOutcome: function (fixtureId, outcome, label) {
      return { kind: 'fixtureOutcome', fixtureId: fixtureId,
               outcome: outcome, label: label || null };   // winner | loser
    },
    bye: function () { return { kind: 'bye' }; },
    tbd: function (label) { return { kind: 'tbd', label: label || 'TBD' }; }
  };

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // Human-readable name for a side. `world` is optional; with it the label
  // names real groups and entrants instead of ids.
  function refLabel(ref, world) {
    if (!ref) return 'TBD';
    if (ref.label) return ref.label;
    var groupName = function (sid, gid) {
      if (!world || !world.stages) return gid;
      var st = world.stages.filter(function (s) { return s.id === sid; })[0];
      if (!st) return gid;
      var g = (st.groups || []).filter(function (x) { return x.id === gid; })[0];
      return g ? g.name : gid;
    };
    switch (ref.kind) {
      case 'entrant':
        if (world && world.entrantsById && world.entrantsById[ref.entrantId]) {
          return world.entrantsById[ref.entrantId].name;
        }
        return ref.entrantId;
      case 'groupPosition':
        return (ref.position === 1 ? 'Winner ' :
                ref.position === 2 ? 'Runner-up ' :
                ordinal(ref.position) + ' ')
               + groupName(ref.stageId, ref.groupId);
      case 'bestOfRank':
        return 'Best ' + ordinal(ref.position) + ' place';
      case 'stageRank':
        return ordinal(ref.position) + ' overall';
      case 'fixtureOutcome':
        return (ref.outcome === 'loser' ? 'Loser of ' : 'Winner of ') +
               (ref.shortLabel || ref.fixtureId);
      case 'bye':
        return 'Bye';
      default:
        return ref.label || 'TBD';
    }
  }

  /* ------------------------------------------------------ scoring config -- */

  /* Resolution chain, most specific first. The final is best-of-5 while the
   * groups are best-of-3, so this cannot be one tournament-wide value. */
  function resolveScoring(tournament, stage, templateRubber, rubber) {
    return (rubber && rubber.scoringOverride) ||
           (templateRubber && templateRubber.scoringOverride) ||
           (stage && stage.scoring) ||
           (tournament && tournament.config && tournament.config.scoring) ||
           null;
  }

  function resolveEngine(tournament, stage, templateRubber, rubber) {
    var sc = resolveScoring(tournament, stage, templateRubber, rubber);
    if (sc && sc.engine) return sc.engine;
    return (tournament && tournament.config && tournament.config.engine) || 'manual';
  }

  /* ------------------------------------------------------- rubber labels -- */

  /* Labels like "AA", "C1D1", "A1B1" are how the organiser thinks, but
   * homeSlots/awaySlots are the truth the app uses. This guesses slots from
   * the label so defining eleven rubbers is typing eleven short strings
   * instead of filling 22 dropdowns. Always overridable.
   *
   *   "C1D1" -> ["C1","D1"]   explicit, two graded slots
   *   "AA"   -> ["A1","A2"]   doubled letter: both players of that grade
   *   "AB"   -> ["A1","B1"]   two letters: the firsts of each grade
   *   "A1"   -> ["A1"]        singles
   *   "MD"   -> null          not a grade pattern; pick manually
   */
  function parseRubberLabel(label, grades) {
    if (!label) return null;
    var has = {};
    (grades || []).forEach(function (g) { has[String(g).toUpperCase()] = true; });
    var s = String(label).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s) return null;

    function ok(arr) {
      if (!arr.length) return null;
      for (var i = 0; i < arr.length; i++) { if (!has[arr[i]]) return null; }
      return arr;
    }

    // The label IS a category. Needed for the one-each style, where the
    // categories are A, B, C and "A" meant A1, which nobody holds.
    if (has[s]) return [s];

    var tokens = s.match(/[A-Z][0-9]+/g);
    if (tokens && tokens.join('') === s && tokens.length <= 2) {
      var r1 = ok(tokens);
      if (r1) return r1;
    }
    var dbl = /^([A-Z])\1$/.exec(s);
    if (dbl) {
      var r2 = ok([dbl[1] + '1', dbl[1] + '2']);
      if (r2) return r2;
    }
    var two = /^([A-Z])([A-Z])$/.exec(s);
    if (two && two[1] !== two[2]) {
      // Two whole categories first (A and B), then the numbered pair.
      var r3 = ok([two[1], two[2]]) || ok([two[1] + '1', two[2] + '1']);
      if (r3) return r3;
    }
    if (/^[A-Z]$/.test(s)) {
      var r4 = ok([s + '1']);
      if (r4) return r4;
    }
    return null;
  }

  /* Count slot usage across a tie template. An 11-rubber doubles template
   * over 11 players uses 22 slot appearances per side; anything else is
   * usually a typo the organiser wants to see before the draw is made. */
  function auditTemplate(template, grades) {
    var counts = { home: {}, away: {} };
    var issues = [];
    (template.rubbers || []).forEach(function (rb) {
      ['home', 'away'].forEach(function (side) {
        var slots = rb[side + 'Slots'] || [];
        if (!slots.length && rb.kind !== 'team') {
          issues.push({ level: 'warn', rubberId: rb.id,
                        message: rb.label + ': no ' + side + ' players set' });
        }
        slots.forEach(function (sl) {
          counts[side][sl] = (counts[side][sl] || 0) + 1;
        });
      });
    });
    (grades || []).forEach(function (g) {
      if (!counts.home[g] && !counts.away[g]) {
        issues.push({ level: 'info', message: g + ' never plays' });
      }
    });
    return { counts: counts, issues: issues };
  }

  /* -------------------------------------------------------- points rules -- */

  /* A rule list, not {win,draw,loss}: "2 for the tie plus 1 per rubber won"
   * and cricket's point for a no-result are both ordinary entries here. */
  function pointsRules(win, draw, loss, extra) {
    var rules = [{ per: 'outcome', map: {
      win: win, draw: draw, loss: loss, noResult: draw
    } }];
    return extra ? rules.concat(extra) : rules;
  }

  /* Point difference and points scored sit in the chain because the unit
   * measures above them say nothing in a one-set tournament: a side that
   * wins takes the only set, so unitsDiff and unitsFor are the win count
   * written again. Three teams level on points with a head-to-head cycle
   * between them were being declared level on everything while their point
   * differences were fifteen apart. Where the unit IS the point - football
   * goals, cricket runs - these two repeat the earlier criteria and so
   * change nothing. */
  /* The order the organiser asked for, and it always resolves:
   *   1. table points - who won the most matches
   *   2. games difference - 6-5 is +1
   *   3. points difference - every 21-19 is +2, every 9-21 is -12, summed
   *   4. points scored
   * Head-to-head is deliberately NOT in it. It is a defensible rule, but
   * it overrides the differences above rather than breaking a tie between
   * them, and a three-way cycle leaves it saying nothing at all. */
  var DEFAULT_TIEBREAKS = ['unitsDiff', 'pointDiff', 'pointsFor', 'won'];

  /* ------------------------------------------------------------ presets -- */

  var SPORTS = {
    pickleball: {
      name: 'Pickleball', engine: 'rally',
      scoring: { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null,
                 sideOut: false, switchAt: null, decidingGameTo: null },
      variants: [
        { name: 'One game to 21, rally scoring',
          scoring: { bestOf: 1, pointsToWin: 21, winBy: 2, cap: null, sideOut: false } },
        { name: 'One game to 15, rally scoring',
          scoring: { bestOf: 1, pointsToWin: 15, winBy: 2, cap: null, sideOut: false } },
        { name: 'Best of 3 to 11, side-out scoring',
          scoring: { bestOf: 3, pointsToWin: 11, winBy: 2, cap: null, sideOut: true } }
      ]
    },
    badminton: {
      name: 'Badminton', engine: 'rally',
      scoring: { bestOf: 3, pointsToWin: 21, winBy: 2, cap: 30,
                 sideOut: false, switchAt: 11, decidingGameTo: null },
      variants: [
        { name: 'Best of 3 to 21, cap 30',
          scoring: { bestOf: 3, pointsToWin: 21, winBy: 2, cap: 30, sideOut: false, switchAt: 11 } },
        { name: 'One game to 21, cap 30',
          scoring: { bestOf: 1, pointsToWin: 21, winBy: 2, cap: 30, sideOut: false, switchAt: 11 } },
        { name: 'Best of 3 to 15, cap 21',
          scoring: { bestOf: 3, pointsToWin: 15, winBy: 2, cap: 21, sideOut: false } }
      ]
    },
    tableTennis: {
      name: 'Table tennis', engine: 'rally',
      scoring: { bestOf: 5, pointsToWin: 11, winBy: 2, cap: null,
                 sideOut: false, switchAt: null, decidingGameTo: null }
    },
    squash: {
      name: 'Squash', engine: 'rally',
      scoring: { bestOf: 5, pointsToWin: 11, winBy: 2, cap: null,
                 sideOut: false, switchAt: null, decidingGameTo: null }
    },
    volleyball: {
      name: 'Volleyball', engine: 'rally',
      scoring: { bestOf: 5, pointsToWin: 25, winBy: 2, cap: null,
                 sideOut: false, switchAt: null, decidingGameTo: 15 }
    },
    football: {
      name: 'Football', engine: 'tally',
      scoring: { increments: [1], periods: 2, periodName: 'Half',
                 periodMinutes: 45, allowDraw: true, unitName: 'Goals' },
      points: pointsRules(3, 1, 0),
      tiebreaks: ['unitsDiff', 'unitsFor', 'headToHead', 'won']
    },
    basketball: {
      name: 'Basketball', engine: 'tally',
      scoring: { increments: [1, 2, 3], periods: 4, periodName: 'Quarter',
                 periodMinutes: 10, allowDraw: false, unitName: 'Points' }
    },
    hockey: {
      name: 'Hockey', engine: 'tally',
      scoring: { increments: [1], periods: 4, periodName: 'Quarter',
                 periodMinutes: 15, allowDraw: true, unitName: 'Goals' },
      points: pointsRules(3, 1, 0)
    },
    cricket: {
      name: 'Cricket', engine: 'cricket',
      scoring: { overs: 20, ballsPerOver: 6, wickets: 10, innings: 2,
                 trackPlayers: false },
      points: pointsRules(2, 1, 0),
      tiebreaks: ['won', 'netRunRate', 'headToHead']
    },
    tennis: {
      name: 'Tennis', engine: 'tennis',
      scoring: { sets: 3, gamesPerSet: 6, tiebreakAt: 6, adScoring: true,
                 finalSetTiebreak: true }
    },
    other: {
      name: 'Something else', engine: 'manual',
      scoring: { unitName: 'Score', allowDraw: true }
    }
  };

  /* Six categories of two, so every doubled label - AA through FF -
   * means something. It stopped at F1, which left FF naming nobody. */
  var DEFAULT_GRADES = ['A1','A2','B1','B2','C1','C2',
                        'D1','D2','E1','E2','F1','F2'];

  /* The grade list a label is read against: the organiser's own if they
   * have set one, otherwise the standard A1..F1, which is what "AA" and
   * "C1D1" mean to everybody anyway. config.grades starts empty and no
   * screen fills it, so without this fallback every label parsed to
   * nothing and the auto-fill the whole graded format exists for never
   * ran once. */
  function gradesOf(tournament) {
    var g = (tournament && tournament.config && tournament.config.grades) || [];
    return g.length ? g : DEFAULT_GRADES;
  }

  /* The player slots a match label names, or none when grades are off. */
  function slotsForLabel(tournament, label) {
    if (!tournament || !tournament.config || !tournament.config.useGrades) return [];
    return parseRubberLabel(label, gradesOf(tournament)) || [];
  }

  /* Re-read every match label in the tie template. Called when grades are
   * switched on or off, because a list set up beforehand would otherwise
   * keep the slots it was parsed with - which is to say none. */
  function reparseTemplate(tournament) {
    var rs = (tournament.config.tieTemplate && tournament.config.tieTemplate.rubbers) || [];
    rs.forEach(function (r) {
      var slots = slotsForLabel(tournament, r.label);
      r.homeSlots = slots.slice();
      r.awaySlots = slots.slice();
      r.kind = slots.length > 1 ? 'doubles' : slots.length === 1 ? 'singles' : 'team';
    });
    return rs;
  }

  /* The games a set of categories naturally makes, so nobody types a
   * label twice. With A1..F2 that is AA, BB, CC… (each pair playing
   * together), A1B1, A2B2, C1D1… (the pairs split across each other)
   * and A1, A2, B1… as singles. With one-each categories A, B, C it is
   * AB, CD… and the singles. */
  function categoryGames(grades) {
    var letters = [], byLetter = {};
    (grades || []).forEach(function (g) {
      var m = /^([A-Za-z])([0-9]*)$/.exec(String(g));
      if (!m) return;
      var L = m[1].toUpperCase();
      if (!byLetter[L]) { byLetter[L] = []; letters.push(L); }
      byLetter[L].push(String(g));
    });

    var together = [], across = [], singles = [];

    letters.forEach(function (L) {
      if (byLetter[L].length > 1) together.push({ label: L + L, kind: 'doubles' });
      byLetter[L].forEach(function (g) {
        singles.push({ label: g, kind: 'singles' });
      });
    });

    for (var i = 0; i + 1 < letters.length; i += 2) {
      var a = byLetter[letters[i]], b = byLetter[letters[i + 1]];
      var n = Math.min(a.length, b.length);
      for (var k = 0; k < n; k++) {
        across.push({ label: a[k] + b[k], kind: 'doubles' });
      }
    }
    return { together: together, across: across, singles: singles };
  }

  /* Tie templates: how a team-vs-team fixture breaks into rubbers. */
  var TIE_TEMPLATES = {
    single: function () {
      return {
        rubbers: [{ id: uid('tr'), label: 'Game', kind: 'team',
                    homeSlots: [], awaySlots: [] }],
        result: { primary: 'rubbersWon', tiebreak: [], allowDraw: true },
        clinchEnds: false, playAllRubbers: true
      };
    },
    // The user's own format: 11 doubles rubbers over a graded roster of 11.
    pickleball11: function () {
      var labels = ['AA', 'BB', 'CC', 'DD', 'EE', 'A1B1', 'A2B2',
                    'C1D1', 'C2D2', 'A1C1', 'B1D1'];
      return {
        rubbers: labels.map(function (l) {
          var slots = parseRubberLabel(l, DEFAULT_GRADES) || [];
          return { id: uid('tr'), label: l, kind: 'doubles',
                   homeSlots: slots.slice(), awaySlots: slots.slice() };
        }),
        result: { primary: 'rubbersWon', tiebreak: ['pointDiff'], allowDraw: false },
        clinchEnds: false, playAllRubbers: true
      };
    },
    badminton5: function () {
      var spec = [
        ['MS1', 'singles', ['MS1'], ['MS1']],
        ['MD',  'doubles', ['MD1', 'MD2'], ['MD1', 'MD2']],
        ['MS2', 'singles', ['MS2'], ['MS2']],
        ['XD',  'doubles', ['XD1', 'XD2'], ['XD1', 'XD2']],
        ['MS3', 'singles', ['MS3'], ['MS3']]
      ];
      return {
        rubbers: spec.map(function (s) {
          return { id: uid('tr'), label: s[0], kind: s[1],
                   homeSlots: s[2], awaySlots: s[3] };
        }),
        result: { primary: 'rubbersWon', tiebreak: ['gamesDiff', 'pointDiff'],
                  allowDraw: false },
        clinchEnds: true, playAllRubbers: false
      };
    }
  };

  var BADMINTON5_GRADES = ['MS1', 'MS2', 'MS3', 'MD1', 'MD2', 'XD1', 'XD2'];

  /* ----------------------------------------------------------- factories -- */

  /* What a single match within a meeting is. Drives how many names get
   * asked for, and nothing else - scoring is identical either way. */
  var MATCH_KINDS = [
    { id: 'singles', label: 'Singles', players: 1 },
    { id: 'doubles', label: 'Doubles', players: 2 },
    { id: 'mixed',   label: 'Mixed doubles', players: 2 },
    { id: 'team',    label: 'Whole team', players: 0 }
  ];

  function playersNeeded(kind) {
    for (var i = 0; i < MATCH_KINDS.length; i++) {
      if (MATCH_KINDS[i].id === kind) return MATCH_KINDS[i].players;
    }
    return 0;
  }

  function kindLabel(kind) {
    for (var i = 0; i < MATCH_KINDS.length; i++) {
      if (MATCH_KINDS[i].id === kind) return MATCH_KINDS[i].label;
    }
    return '';
  }

  function shortLabel(name) {
    var words = String(name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '???';
    if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
    return words.map(function (w) { return w[0]; }).join('').slice(0, 3).toUpperCase();
  }

  function makeTournament(opts) {
    opts = opts || {};
    var sportKey = opts.sport || 'pickleball';
    var sport = SPORTS[sportKey] || SPORTS.other;
    return {
      id: opts.id || uid('t'),
      schemaVersion: SCHEMA_VERSION,
      name: opts.name || 'New tournament',
      sport: sportKey,
      createdAt: new Date().toISOString(),
      config: {
        engine: opts.engine || sport.engine,
        scoring: JSON.parse(JSON.stringify(opts.scoring || sport.scoring)),
        tieTemplate: opts.tieTemplate || TIE_TEMPLATES.single(),
        grades: opts.grades || [],
        courts: opts.courts || 1,
        autoConfirm: true,
        // Off unless asked for. Most local tournaments never name a player,
        // let alone grade one.
        useGrades: !!opts.useGrades,
        // How much is recorded about each point: 'none', 'shots', 'players'.
        detail: opts.detail || 'none',
        entrantKind: opts.entrantKind || 'team',
        standings: {
          points: opts.points || sport.points || pointsRules(2, 1, 0),
          tiebreaks: (opts.tiebreaks || sport.tiebreaks || DEFAULT_TIEBREAKS).slice(),
          onPartition: 'restart',          // UEFA: restart criteria after a split
          countRubbersAsUnits: false
        }
      },
      stages: []
    };
  }

  function makeEntrant(opts) {
    opts = opts || {};
    var name = opts.name || 'Entrant';
    return {
      id: opts.id || uid('e'),
      kind: opts.kind || 'team',          // individual | pair | team
      name: name,
      shortName: opts.shortName || shortLabel(name),
      color: opts.color || null,
      logo: opts.logo || null,            // an emoji or a couple of letters

      seed: opts.seed == null ? null : opts.seed,
      members: opts.members || []          // [{playerId, slot}]
    };
  }

  function makePlayer(opts) {
    opts = opts || {};
    return { id: opts.id || uid('p'), name: opts.name || 'Player',
             category: opts.category || null };
  }

  /* The player on a team called `name`, adding them to the squad if this
   * is the first anyone has heard of them. Names are usually typed at the
   * match, because that is when they are known; adding them on the way
   * past means nobody is ever entered twice and the leaderboard adds up.
   * Matching is within the one team, so both sides may field a Jinay. */
  function findOrAddPlayer(t, entrant, name, slot) {
    var lower = String(name).toLowerCase();
    var members = (entrant && entrant.members) || [];
    for (var i = 0; i < members.length; i++) {
      var p = (t.players || []).filter(function (x) {
        return x.id === members[i].playerId;
      })[0];
      if (p && String(p.name).toLowerCase() === lower) return { id: p.id, created: false };
    }
    /* The category is a suggestion, taken only when it is going spare.
     * A stand-in typed into D1 while somebody already holds it is a
     * change to ONE match; handing them the category outright would
     * quietly re-point every other match the squad plays. */
    var taken = false;
    if (slot) {
      members.forEach(function (m) { if (m.slot === slot) taken = true; });
    }
    var pl = makePlayer({ name: name });
    t.players = t.players || [];
    t.players.push(pl);
    if (entrant) {
      entrant.members = entrant.members || [];
      entrant.members.push({ playerId: pl.id, slot: taken ? null : (slot || null) });
    }
    return { id: pl.id, created: true };
  }

  function makeStage(opts) {
    opts = opts || {};
    return {
      id: opts.id || uid('s'),
      name: opts.name || 'Stage',
      type: opts.type || 'roundrobin',     // roundrobin | knockout | manual
      groups: opts.groups || [],           // [{id, name, entrantRefs:[Ref]}]
      rounds: opts.rounds || { legs: 1 },
      scoring: opts.scoring || null,
      standings: opts.standings || {
        counts: [{ stageId: 'self', filter: 'all', weight: 1 }],
        config: null, seedBonus: null, frozen: null
      },
      qualifyPerGroup: opts.qualifyPerGroup == null ? 2 : opts.qualifyPerGroup,
      thirdPlace: !!opts.thirdPlace
    };
  }

  function makeFixture(opts) {
    opts = opts || {};
    return {
      id: opts.id || uid('f'),
      tournamentId: opts.tournamentId || null,
      stageId: opts.stageId || null,
      groupId: opts.groupId || null,
      round: opts.round || 1,
      leg: opts.leg || 1,
      shortLabel: opts.shortLabel || null,   // "SF1", "QF3" - for bracket refs
      home: opts.home,
      away: opts.away,
      lineup: opts.lineup || { home: {}, away: {} },
      status: opts.status || STATUS.SCHEDULED,
      // Who actually took the court, written the first time this meeting
      // is scored. Progression will not re-point a fixture that has this.
      resolved: opts.resolved || null,
      rubberSummary: {},                      // {rubberId: compact summary}
      // How many matches this meeting actually holds. Set when its matches
      // are created and changed when one is added or removed, so a meeting
      // can differ from the tournament's default without anything breaking.
      matchCount: opts.matchCount == null ? null : opts.matchCount,
      venue: opts.venue || null,
      scheduledAt: opts.scheduledAt || null
    };
  }

  function makeRubber(opts) {
    opts = opts || {};
    return {
      id: opts.id || uid('r'),
      tournamentId: opts.tournamentId || null,
      fixtureId: opts.fixtureId || null,
      templateRubberId: opts.templateRubberId || null,
      label: opts.label || 'Game',
      kind: opts.kind || 'team',
      order: opts.order || 0,
      homeSlots: opts.homeSlots || [],
      awaySlots: opts.awaySlots || [],
      homePlayers: opts.homePlayers || [],
      awayPlayers: opts.awayPlayers || [],
      court: opts.court || null,
      slot: opts.slot == null ? null : opts.slot,
      status: opts.status || STATUS.SCHEDULED,
      lock: null,
      events: [],        // append-only; the fold in engines.js derives state
      summary: null      // derived cache; re-folded, never incremented
    };
  }

  /* ---------------------------------------------------------- migration -- */

  /* The artifact gets republished as phases land, so saved tournaments must
   * survive. Every read goes through here. */
  /* The old default tiebreak list could not separate teams in a one-set
   * tournament, because every criterion after head-to-head restated the
   * win count. A stage still carrying that exact list has never been
   * touched by anyone, so it is safe to move it on; a list the organiser
   * has edited is left exactly as they set it. */
  var TIEBREAKS_V1 = ['headToHead', 'unitsDiff', 'unitsFor', 'won'];
  var TIEBREAKS_V2 = ['headToHead', 'unitsDiff', 'unitsFor',
                      'pointDiff', 'pointsFor', 'won'];

  function sameList(a, b) {
    if (!a || a.length !== b.length) return false;
    for (var i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* NEVER writes to the document it is given. Everything the store hands
   * back in shared mode is FROZEN - the same object goes to every
   * subscriber and assigning to it throws. Editing in place threw on the
   * very first snapshot, so the tournament list never arrived and the app
   * sat on "Loading..." for good. Local storage hands back plain mutable
   * objects from JSON.parse, which is why this only ever showed up on the
   * shared link. */
  function migrate(doc) {
    if (!doc) return doc;
    var v = doc.schemaVersion || 0;
    if (v >= SCHEMA_VERSION) return doc;

    var out = JSON.parse(JSON.stringify(doc));
    if (v < 2) {
      var lists = [out.config && out.config.standings];
      (out.stages || []).forEach(function (s) {
        lists.push(s.standings);
        lists.push(s.standings && s.standings.config);
      });
      lists.forEach(function (st) {
        if (st && sameList(st.tiebreaks, TIEBREAKS_V1)) {
          st.tiebreaks = DEFAULT_TIEBREAKS.slice();
        }
      });
    }
    if (v < 3) {
      /* Head-to-head came out of the default chain. A list still carrying
       * an old default has never been touched by anyone, so it moves on;
       * one the organiser has edited stays exactly as they set it. */
      var lists3 = [out.config && out.config.standings];
      (out.stages || []).forEach(function (s) {
        lists3.push(s.standings);
        lists3.push(s.standings && s.standings.config);
      });
      lists3.forEach(function (st) {
        if (st && (sameList(st.tiebreaks, TIEBREAKS_V1) ||
                   sameList(st.tiebreaks, TIEBREAKS_V2))) {
          st.tiebreaks = DEFAULT_TIEBREAKS.slice();
        }
      });
    }
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }

  /* ------------------------------------------------------------- export -- */

  TS.model = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    uid: uid,
    STATUS: STATUS,
    countsForStandings: countsForStandings,
    isSettled: isSettled,
    Ref: Ref,
    refLabel: refLabel,
    ordinal: ordinal,
    resolveScoring: resolveScoring,
    resolveEngine: resolveEngine,
    parseRubberLabel: parseRubberLabel,
    gradesOf: gradesOf,
    slotsForLabel: slotsForLabel,
    categoryGames: categoryGames,
    reparseTemplate: reparseTemplate,
    auditTemplate: auditTemplate,
    pointsRules: pointsRules,
    DEFAULT_TIEBREAKS: DEFAULT_TIEBREAKS,
    DEFAULT_GRADES: DEFAULT_GRADES,
    BADMINTON5_GRADES: BADMINTON5_GRADES,
    SPORTS: SPORTS,
    TIE_TEMPLATES: TIE_TEMPLATES,
    makeTournament: makeTournament,
    makeEntrant: makeEntrant,
    makePlayer: makePlayer,
    findOrAddPlayer: findOrAddPlayer,
    makeStage: makeStage,
    makeFixture: makeFixture,
    makeRubber: makeRubber,
    shortLabel: shortLabel,
    MATCH_KINDS: MATCH_KINDS,
    playersNeeded: playersNeeded,
    kindLabel: kindLabel,
    migrate: migrate
  };

})(window.TS = window.TS || {});
