/* Tournament Scorer - draws and scheduling
 *
 * Round-robin generation, knockout brackets, and the one genuinely awkward
 * problem in this app: fitting a tie's rubbers onto a few courts when the
 * same player appears in more than one of them.
 */
(function (TS) {
  'use strict';

  var M = TS.model;
  var Ref = M.Ref;

  /* ------------------------------------------------------- round robin -- */

  /* The circle method (Berger tables). Fix the first entrant, rotate the
   * rest one step per round, pair i-th from the front with i-th from the
   * back. An odd entry count gets a null, whose pairing is a bye.
   *
   * The property that makes multi-court scheduling a non-problem: each round
   * is a perfect matching, so NO ENTRANT APPEARS TWICE IN A ROUND by
   * construction. Court assignment within a round is therefore free.
   */
  function roundRobin(ids, opts) {
    opts = opts || {};
    var legs = opts.legs || 1;
    var list = ids.slice();
    if (list.length < 2) return [];
    if (list.length % 2) list.push(null);           // bye marker

    var n = list.length;
    var fixed = list[0];
    var rot = list.slice(1);
    var rounds = [];

    for (var r = 0; r < n - 1; r++) {
      var row = [fixed].concat(rot);
      var pairs = [];
      for (var i = 0; i < n / 2; i++) {
        var a = row[i], b = row[n - 1 - i];
        // Otherwise the fixed entrant is at home in every single match.
        if (i === 0 && r % 2 === 1) { var t = a; a = b; b = t; }
        pairs.push([a, b]);
      }
      rounds.push(pairs);
      rot = [rot[rot.length - 1]].concat(rot.slice(0, -1));
    }

    if (legs > 1) {
      var first = rounds.slice();
      for (var L = 1; L < legs; L++) {
        first.forEach(function (pairs) {
          rounds.push(pairs.map(function (p) { return [p[1], p[0]]; }));
        });
      }
    }
    return rounds;
  }

  /* Build fixtures for a round-robin group.
   *
   * Takes REFS, not ids, so a Super 6 group can be drawn before anyone has
   * qualified for it: "Winner Group A" v "Runner-up Group B" is a real
   * fixture from day zero and fills itself in when the groups finish. The
   * circle method runs over positions, so the refs stay opaque. */
  function roundRobinFixtures(opts) {
    var refs = opts.entrantRefs ||
      (opts.entrantIds || []).map(function (id) { return Ref.entrant(id); });
    var slots = refs.map(function (_, i) { return i; });
    var legs = opts.legs || 1;
    var rounds = roundRobin(slots, { legs: legs });
    var perLeg = rounds.length / legs;

    /* "Each team plays four of the other five." The circle method already
     * gives every team exactly one match per round, so the first k rounds
     * ARE a balanced k-match schedule - no random draw needed, and nobody
     * ends up playing twice while someone else sits out. With an odd
     * entry one team takes its bye inside those rounds and plays k-1. */
    if (opts.rounds && opts.rounds < perLeg) {
      var keep = [];
      for (var L = 0; L < legs; L++) {
        keep = keep.concat(rounds.slice(L * perLeg, L * perLeg + opts.rounds));
      }
      rounds = keep;
      perLeg = opts.rounds;
    }
    var out = [];
    rounds.forEach(function (pairs, ri) {
      pairs.forEach(function (p) {
        if (p[0] == null || p[1] == null) return;    // bye: no match played
        out.push(M.makeFixture({
          tournamentId: opts.tournamentId,
          stageId: opts.stageId,
          groupId: opts.groupId,
          round: ri + 1,
          leg: Math.floor(ri / Math.max(1, perLeg)) + 1,
          home: refs[p[0]],
          away: refs[p[1]]
        }));
      });
    });
    return out;
  }

  /* ------------------------------------------------- splitting a draw --- */

  /* A group with one team in it has nobody to play, so the draw comes out
   * empty and the tournament is stuck. This is the guard, and it lives here
   * rather than in a screen so it stays tested: never more groups than there
   * are pairs of teams. */
  function clampGroups(teamCount, wanted) {
    var max = Math.floor((teamCount || 0) / 2) || 1;
    return Math.max(1, Math.min(wanted || 1, max));
  }

  /* Deal the teams out one at a time rather than slicing, so 7 teams in 2
   * groups comes out 4 and 3 instead of 4 and 3 by luck of the slice. */
  /* Groups of exactly the sizes asked for - 4, 4 and 6 out of fourteen,
   * say, which no even deal can produce. Anything left over by a short
   * list of sizes goes into the last group rather than vanishing. */
  function splitIntoSizes(items, sizes) {
    var out = [], i = 0;
    (sizes || []).forEach(function (n) {
      out.push(items.slice(i, i + n));
      i += n;
    });
    if (!out.length) return [items.slice()];
    if (i < items.length) out[out.length - 1] =
      out[out.length - 1].concat(items.slice(i));
    return out.filter(function (g) { return g.length; });
  }

  function splitIntoGroups(items, groupCount) {
    var n = clampGroups(items.length, groupCount);
    var groups = [];
    for (var g = 0; g < n; g++) groups.push([]);
    items.forEach(function (it, i) { groups[i % n].push(it); });
    return groups;
  }

  /* --------------------------------------------- carrying a stage on --- */

  /* The teams going through from a stage, as refs, ordered so that feeding
   * them straight into a bracket gives the right cross-over: every group
   * winner first, then every runner-up, and so on. With two groups that is
   * [A1, B1, A2, B2], which seeds to A1 v B2 and B1 v A2. */
  function qualifierRefs(stage, perGroup) {
    var refs = [];
    for (var pos = 1; pos <= perGroup; pos++) {
      (stage.groups || []).forEach(function (g) {
        refs.push(Ref.groupPosition(stage.id, g.id, pos));
      });
    }
    return refs;
  }

  /* How a later stage counts an earlier one. "coQualifiers" is the classic
   * Super Six: you carry the result of the group match against the other
   * teams who came through with you. */
  function carryCounts(fromStageId, mode) {
    var self = { stageId: 'self', filter: 'all', weight: 1 };
    if (mode === 'none' || !fromStageId) return [self];
    if (mode === 'half') {
      return [{ stageId: fromStageId, filter: 'bothEntrantsInThisStage', weight: 0.5 }, self];
    }
    if (mode === 'all') {
      return [{ stageId: fromStageId, filter: 'all', weight: 1 }, self];
    }
    return [{ stageId: fromStageId, filter: 'bothEntrantsInThisStage', weight: 1 }, self];
  }

  /* ---------------------------------------------------------- brackets -- */

  /* Standard bracket seeding: 1 plays the lowest seed, and the bracket is
   * built so the top two seeds can only meet in the final.
   * n=8 gives [1,8,4,5,2,7,3,6]. */
  function seedOrder(size) {
    var order = [1];
    while (order.length < size) {
      var m = order.length * 2 + 1;
      var next = [];
      order.forEach(function (s) { next.push(s); next.push(m - s); });
      order = next;
    }
    return order;
  }

  function nextPowerOfTwo(n) {
    var p = 1;
    while (p < n) p *= 2;
    return p;
  }

  /* The seeded first round: top seed against the lowest, byes falling to
   * the teams seeded highest. Good for the common shapes; odd group counts
   * can still pit two teams from one group together, which is why the
   * bracket is editable by hand. */
  function defaultSlots(refs) {
    var size = nextPowerOfTwo(refs.length);
    return seedOrder(size).map(function (seed) {
      return refs[seed - 1] || Ref.bye();
    });
  }

  function roundName(teamsLeft) {
    if (teamsLeft === 2) return 'Final';
    if (teamsLeft === 4) return 'Semi-finals';
    if (teamsLeft === 8) return 'Quarter-finals';
    return 'Round of ' + teamsLeft;
  }

  function roundTag(teamsLeft, i) {
    if (teamsLeft === 2) return 'F';
    if (teamsLeft === 4) return 'SF' + (i + 1);
    if (teamsLeft === 8) return 'QF' + (i + 1);
    return 'R' + teamsLeft + '-' + (i + 1);
  }

  /* A knockout bracket over a list of entrant refs. Short of a power of two,
   * the top seeds get byes - a fixture whose away side is a bye completes
   * itself, and the next round's ref resolves through it. No pre-advancing,
   * no special case anywhere else. */
  function knockoutFixtures(opts) {
    var refs = opts.entrantRefs || [];
    // `slots` lets the organiser lay the first round out by hand; without
    // it the bracket is seeded in the usual way.
    var slots = opts.slots || defaultSlots(refs);
    var size = slots.length;

    var fixtures = [];
    var prev = [];
    var teamsLeft = size;
    var round = 1;

    while (teamsLeft >= 2) {
      var count = teamsLeft / 2;
      var cur = [];
      for (var i = 0; i < count; i++) {
        var home, away;
        if (round === 1) {
          home = slots[i * 2];
          away = slots[i * 2 + 1];
        } else {
          home = Ref.fixtureOutcome(prev[i * 2].id, 'winner', null);
          away = Ref.fixtureOutcome(prev[i * 2 + 1].id, 'winner', null);
          home.shortLabel = prev[i * 2].shortLabel;
          away.shortLabel = prev[i * 2 + 1].shortLabel;
        }
        var f = M.makeFixture({
          tournamentId: opts.tournamentId,
          stageId: opts.stageId,
          groupId: opts.groupId || null,
          round: round,
          shortLabel: roundTag(teamsLeft, i),
          home: home,
          away: away,
          status: (home.kind === 'bye' || away.kind === 'bye')
                    ? M.STATUS.BYE : M.STATUS.SCHEDULED
        });
        f.roundName = roundName(teamsLeft);
        cur.push(f);
        fixtures.push(f);
      }
      prev = cur;
      teamsLeft = count;
      round += 1;
    }

    if (opts.thirdPlace && fixtures.length >= 3) {
      var semis = fixtures.filter(function (f) { return f.shortLabel.indexOf('SF') === 0; });
      if (semis.length === 2) {
        var tp = M.makeFixture({
          tournamentId: opts.tournamentId,
          stageId: opts.stageId,
          round: round - 1,
          shortLabel: '3P',
          home: Ref.fixtureOutcome(semis[0].id, 'loser', null),
          away: Ref.fixtureOutcome(semis[1].id, 'loser', null)
        });
        tp.home.shortLabel = semis[0].shortLabel;
        tp.away.shortLabel = semis[1].shortLabel;
        tp.roundName = 'Third place';
        fixtures.push(tp);
      }
    }
    return fixtures;
  }

  /* ----------------------------------------------- rubbers within a tie -- */

  /* The hard case. A pickleball tie is eleven doubles matches over eleven
   * players, so most players appear in two of them, and the venue has maybe
   * three courts. Two rubbers conflict when they share a player.
   *
   * This is graph colouring with a capacity per colour: a node per rubber,
   * an edge between rubbers sharing a slot, greedy by descending degree
   * (DSATUR-ish). It is offered as a SUGGESTION - the organiser can drag
   * things around, and validate() flags anything that double-books someone.
   */
  function rubberConflicts(rubbers) {
    var edges = {};
    rubbers.forEach(function (r) { edges[r.id] = {}; });
    for (var i = 0; i < rubbers.length; i++) {
      for (var j = i + 1; j < rubbers.length; j++) {
        if (shareSlot(rubbers[i], rubbers[j])) {
          edges[rubbers[i].id][rubbers[j].id] = true;
          edges[rubbers[j].id][rubbers[i].id] = true;
        }
      }
    }
    return edges;
  }

  function shareSlot(a, b) {
    return intersects(a.homeSlots, b.homeSlots) || intersects(a.awaySlots, b.awaySlots);
  }

  function intersects(x, y) {
    x = x || []; y = y || [];
    for (var i = 0; i < x.length; i++) { if (y.indexOf(x[i]) !== -1) return true; }
    return false;
  }

  function assignRubberSlots(rubbers, courts) {
    courts = Math.max(1, courts || 1);
    var edges = rubberConflicts(rubbers);
    var degree = {};
    rubbers.forEach(function (r) { degree[r.id] = Object.keys(edges[r.id]).length; });

    var order = rubbers.slice().sort(function (a, b) {
      return (degree[b.id] - degree[a.id]) || (a.order - b.order);
    });

    var slotOf = {};
    var slotCount = [];
    order.forEach(function (r) {
      var s = 0;
      for (;;) {
        var used = slotCount[s] || 0;
        var clash = Object.keys(edges[r.id]).some(function (other) {
          return slotOf[other] === s;
        });
        if (!clash && used < courts) break;
        s += 1;
      }
      slotOf[r.id] = s;
      slotCount[s] = (slotCount[s] || 0) + 1;
    });

    // Courts within a slot are interchangeable, so number them in tie order.
    var perSlot = {};
    rubbers.slice().sort(function (a, b) { return a.order - b.order; })
      .forEach(function (r) {
        var s = slotOf[r.id];
        perSlot[s] = (perSlot[s] || 0) + 1;
        r.slot = s;
        r.court = perSlot[s];
      });
    return { slots: (slotCount.length || 0), rubbers: rubbers };
  }

  /* Flag anyone booked on two courts at the same time. Runs over whatever
   * the organiser ends up with, hand-arranged or not. */
  function validateRubberSlots(rubbers) {
    var issues = [];
    var bySlot = {};
    rubbers.forEach(function (r) {
      (bySlot[r.slot == null ? 'none' : r.slot] =
        bySlot[r.slot == null ? 'none' : r.slot] || []).push(r);
    });
    Object.keys(bySlot).forEach(function (s) {
      var group = bySlot[s];
      for (var i = 0; i < group.length; i++) {
        for (var j = i + 1; j < group.length; j++) {
          if (shareSlot(group[i], group[j])) {
            issues.push({
              level: 'error', slot: s,
              message: group[i].label + ' and ' + group[j].label +
                       ' share a player but are both in slot ' + (Number(s) + 1)
            });
          }
        }
      }
    });
    return issues;
  }

  /* --------------------------------------------------- courts per round -- */

  /* Each round of a circle-method draw is conflict-free, so this only has to
   * chunk the round into as many time slots as the court count needs. */
  function assignCourts(fixtures, courts) {
    courts = Math.max(1, courts || 1);
    fixtures.forEach(function (f, i) {
      f.slot = Math.floor(i / courts);
      f.court = (i % courts) + 1;
    });
    return fixtures;
  }

  /* ------------------------------------------------ rubbers for a fixture */

  /* Expand a tie template into real rubbers for one fixture. Each side is
   * filled from the squad's own grade assignments, with the fixture's own
   * lineup overriding where the organiser changed it - because people fall
   * ill, and a permanent player-to-grade binding breaks on the first one. */
  function rubbersForFixture(opts) {
    var template = opts.template;
    var fixture = opts.fixture;
    var lineup = {
      home: lineupOf(opts.homeEntrant, fixture, 'home'),
      away: lineupOf(opts.awayEntrant, fixture, 'away')
    };
    return (template.rubbers || []).map(function (tr, i) {
      return M.makeRubber({
        tournamentId: opts.tournamentId,
        fixtureId: fixture.id,
        templateRubberId: tr.id,
        label: tr.label,
        kind: tr.kind,
        order: i,
        homeSlots: (tr.homeSlots || []).slice(),
        awaySlots: (tr.awaySlots || []).slice(),
        homePlayers: (tr.homeSlots || []).map(function (s) {
          return (lineup.home && lineup.home[s]) || null;
        }).filter(Boolean),
        awayPlayers: (tr.awaySlots || []).map(function (s) {
          return (lineup.away && lineup.away[s]) || null;
        }).filter(Boolean)
      });
    });
  }

  /* Default lineup for an entrant: whatever slot each member was given. */
  function lineupFor(entrant) {
    var out = {};
    ((entrant && entrant.members) || []).forEach(function (m) {
      if (m.slot) out[m.slot] = m.playerId;
    });
    return out;
  }

  /* Who holds each category for one side of ONE match: the squad's own
   * assignment, with whatever the organiser changed for this match on
   * top. The override lives on the fixture, never on the player, so a
   * stand-in for one match never rewrites the squad.
   *
   * A slot the override MENTIONS wins even when it names nobody - that
   * is how "D1 is not playing today" is said, and falling back to the
   * squad there would put the dropped player straight back on court. */
  function lineupOf(entrant, fixture, side) {
    var out = lineupFor(entrant || {});
    var own = ((fixture && fixture.lineup) || {})[side] || {};
    Object.keys(own).forEach(function (k) { out[k] = own[k] || null; });
    return out;
  }

  TS.schedule = {
    roundRobin: roundRobin,
    roundRobinFixtures: roundRobinFixtures,
    qualifierRefs: qualifierRefs,
    carryCounts: carryCounts,
    clampGroups: clampGroups,
    splitIntoGroups: splitIntoGroups,
    splitIntoSizes: splitIntoSizes,
    seedOrder: seedOrder,
    nextPowerOfTwo: nextPowerOfTwo,
    defaultSlots: defaultSlots,
    roundName: roundName,
    knockoutFixtures: knockoutFixtures,
    rubberConflicts: rubberConflicts,
    assignRubberSlots: assignRubberSlots,
    validateRubberSlots: validateRubberSlots,
    assignCourts: assignCourts,
    rubbersForFixture: rubbersForFixture,
    lineupFor: lineupFor,
    lineupOf: lineupOf,
    shareSlot: shareSlot
  };

})(window.TS = window.TS || {});
