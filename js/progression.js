/* Tournament Scorer - progression
 *
 * Resolves the symbolic sides of a fixture ("Runner-up Group B", "Winner of
 * SF1") into real entrants. Pure: no I/O, no writes.
 *
 * PULL, NEVER PUSH. A fixture declares where its teams come from and points
 * BACKWARDS. Nothing writes forward when a match ends, so a phone finishing a
 * semi-final never cascades writes into the final and a bracket can never be
 * left half-applied. The whole schedule therefore exists and prints on day
 * zero, with placeholders where the teams will be.
 *
 * Two refusals matter more than anything else here:
 *   - An ambiguous rank does not resolve. If the tiebreakers leave two teams
 *     level across a qualification line, this returns `pending` and asks for
 *     a coin toss, which is stored. It never guesses and never randomises at
 *     render time, which would make two phones disagree.
 *   - A late correction never silently re-points a fixture that has already
 *     been scored. It is reported as a conflict for a human to settle.
 */
(function (TS) {
  'use strict';

  var M = TS.model;
  var S = TS.standings;

  function adjudicationKey(ids) { return ids.slice().sort().join('|'); }

  /* --------------------------------------------------------- resolveRef -- */

  function resolveRef(ref, ctx) {
    if (!ref) return { pending: true, reason: 'no side set' };

    switch (ref.kind) {
      case 'entrant':
        return { entrantId: ref.entrantId };

      case 'bye':
        return { bye: true };

      case 'tbd':
        return { pending: true, reason: 'not drawn yet' };

      case 'groupPosition': {
        var t = ctx.tables[ref.stageId] && ctx.tables[ref.stageId][ref.groupId];
        if (!t) return { pending: true, reason: 'group not set up yet' };
        if (!t.complete) return { pending: true, reason: 'group still being played' };
        return pickRow(t, ref.position);
      }

      case 'stageRank': {
        var st = ctx.stageTables[ref.stageId];
        if (!st) return { pending: true, reason: 'stage not set up yet' };
        if (!st.complete) return { pending: true, reason: 'stage still being played' };
        return pickRow(st, ref.position);
      }

      case 'bestOfRank': {
        // "Best 3rd place across the groups" - rank every team that finished
        // `position` in its group against each other.
        var byStage = ctx.tables[ref.stageId];
        if (!byStage) return { pending: true, reason: 'stage not set up yet' };
        var pool = [], incomplete = false;
        Object.keys(byStage).forEach(function (gid) {
          var tt = byStage[gid];
          if (!tt.complete) { incomplete = true; return; }
          var row = tt.table[ref.position - 1];
          if (row) pool.push(row);
        });
        if (incomplete) return { pending: true, reason: 'groups still being played' };
        pool.sort(function (a, b) {
          return (b.points - a.points) ||
                 (b.unitsDiff - a.unitsDiff) ||
                 (b.unitsFor - a.unitsFor);
        });
        var want = pool[(ref.rank || 1) - 1];
        if (!want) return { pending: true, reason: 'not enough groups' };
        return { entrantId: want.entrantId };
      }

      case 'fixtureOutcome': {
        var fx = ctx.fixturesById[ref.fixtureId];
        if (!fx) return { pending: true, reason: 'match not created yet' };
        if (!M.isSettled(fx.status, ctx.autoConfirm)) {
          return { pending: true, reason: 'match not finished' };
        }
        var sides = ctx.sides[ref.fixtureId];
        if (!sides || (!sides.home && !sides.away)) {
          return { pending: true, reason: 'match has no teams yet' };
        }
        // A bye walks the present side through.
        if (fx.status === M.STATUS.BYE || sides.homeBye || sides.awayBye) {
          var through = sides.homeBye ? sides.away : sides.home;
          return ref.outcome === 'loser'
            ? { pending: true, reason: 'a bye has no loser' }
            : (through ? { entrantId: through } : { pending: true, reason: 'bye with no team' });
        }
        var res = ctx.resultsById[ref.fixtureId];
        if (!res || res.outcome === 'draw' || res.outcome === 'noResult') {
          return { pending: true, reason: 'match not decided' };
        }
        var winner = res.outcome === 'home' ? sides.home : sides.away;
        var loser = res.outcome === 'home' ? sides.away : sides.home;
        var want2 = ref.outcome === 'loser' ? loser : winner;
        return want2 ? { entrantId: want2 } : { pending: true, reason: 'team unknown' };
      }

      default:
        return { pending: true, reason: 'unknown reference' };
    }

    function pickRow(tbl, position) {
      var row = tbl.table[position - 1];
      if (!row) return { pending: true, reason: 'no team in that position' };
      if (row.sharedRank) {
        return { pending: true, reason: 'teams level on every tiebreaker',
                 needsAdjudication: tbl.unresolvedKeyFor(row.entrantId) };
      }
      return { entrantId: row.entrantId };
    }
  }

  /* --------------------------------------------------- resolveTournament -- */

  /* One topological pass in stage order: resolve a stage's entrants, resolve
   * its fixtures round by round, compute its tables, move on. Earlier stages
   * are always finished before a later one reads them, because refs only
   * point backwards. */
  /* Results and resolution depend on each other: a result needs to know who
   * played, and "winner of SF1" needs SF1's result. So they are produced
   * together, fixture by fixture in round order. Pass `makeResult` to build
   * them from live data; pass `results` instead to supply them ready-made. */
  function resolveTournament(world) {
    var tournament = world.tournament;
    var fixtures = world.fixtures || [];
    var building = !world.results && typeof world.makeResult === 'function';
    var results = (world.results || []).slice();
    var autoConfirm = !(tournament.config && tournament.config.autoConfirm === false);

    var fixturesById = {}, resultsById = {}, byStage = {};
    fixtures.forEach(function (f) {
      fixturesById[f.id] = f;
      (byStage[f.stageId] = byStage[f.stageId] || []).push(f);
    });
    results.forEach(function (r) { resultsById[r.fixtureId] = r; });

    var ctx = {
      world: world,
      fixturesById: fixturesById,
      resultsById: resultsById,
      sides: {},                 // fixtureId -> {home, away, homeBye, awayBye}
      tables: {},                // stageId -> groupId -> table
      stageTables: {},           // stageId -> merged table
      entrantsByStage: {},
      autoConfirm: autoConfirm
    };

    var pending = [];
    var conflicts = [];

    (tournament.stages || []).forEach(function (stage) {
      /* 1. Who is in this stage. */
      var stageEntrants = [];
      ctx.tables[stage.id] = {};
      var groupMembers = {};
      (stage.groups || []).forEach(function (g) {
        var ids = [];
        (g.entrantRefs || []).forEach(function (ref) {
          var r = resolveRef(ref, ctx);
          if (r.entrantId) { ids.push(r.entrantId); stageEntrants.push(r.entrantId); }
          else if (r.pending) {
            pending.push({ where: 'group', stageId: stage.id, groupId: g.id,
                           label: M.refLabel(ref, tournament), reason: r.reason,
                           needsAdjudication: r.needsAdjudication || null });
          }
        });
        groupMembers[g.id] = ids;
      });
      ctx.entrantsByStage[stage.id] = stageEntrants;

      /* 2. This stage's fixtures, round by round so a bracket can read its
       *    own earlier rounds. */
      var mine = (byStage[stage.id] || []).slice().sort(function (a, b) {
        return (a.round || 0) - (b.round || 0);
      });
      mine.forEach(function (f) {
        var h = resolveRef(f.home, ctx);
        var a = resolveRef(f.away, ctx);
        var entry = {
          home: h.entrantId || null, away: a.entrantId || null,
          homeBye: !!h.bye, awayBye: !!a.bye
        };
        ctx.sides[f.id] = entry;

        ['home', 'away'].forEach(function (side) {
          var r = side === 'home' ? h : a;
          if (r.pending) {
            pending.push({ where: 'fixture', fixtureId: f.id, side: side,
                           label: M.refLabel(f[side], tournament),
                           reason: r.reason,
                           needsAdjudication: r.needsAdjudication || null });
          }
        });

        /* A side already scored must not be swapped under a live
         * scoreboard - nor quietly forgotten. A ref that stops resolving
         * at all is the commoner case: adding one group match un-finishes
         * the group, and semi-finals already in the books went back to
         * reading "Winner Group A" while keeping their scores. Whatever
         * played, stays; only a real disagreement is a conflict. */
        if (f.resolved && (f.status === M.STATUS.LIVE ||
                           M.countsForStandings(f.status))) {
          ['home', 'away'].forEach(function (side) {
            if (!f.resolved[side] || f.resolved[side] === entry[side]) return;
            if (entry[side]) {
              conflicts.push({
                fixtureId: f.id, side: side,
                was: f.resolved[side], now: entry[side],
                reason: 'an earlier result changed after this match started'
              });
            }
            entry[side] = f.resolved[side];     // the team that played stays
          });
        }

        // Build this fixture's result now, so the next round of a bracket can
        // read it on this same pass.
        if (building && entry.home && entry.away && M.countsForStandings(f.status)) {
          var built = world.makeResult(f, entry.home, entry.away);
          if (built) { results.push(built); resultsById[f.id] = built; }
        }
      });

      /* 3. Tables for this stage, over its counting set. */
      var stageResults = results.filter(function (r) {
        return r.outcome !== 'void';
      });
      var cfg = mergeStandingsConfig(tournament, stage);
      (stage.groups || []).forEach(function (g) {
        var ids = groupMembers[g.id];
        var counting = S.countingResults(stage, stageResults, stageEntrants)
                        .filter(function (r) {
                          return ids.indexOf(r.home) !== -1 && ids.indexOf(r.away) !== -1;
                        });
        ctx.tables[stage.id][g.id] = buildTable(ids, counting, cfg, world, stage, g, ctx);
      });

      if (stageEntrants.length) {
        var all = S.countingResults(stage, stageResults, stageEntrants);
        ctx.stageTables[stage.id] = buildTable(stageEntrants, all, cfg, world, stage, null, ctx);
      }
    });

    return {
      sides: ctx.sides,
      tables: ctx.tables,
      stageTables: ctx.stageTables,
      entrantsByStage: ctx.entrantsByStage,
      results: results,
      resultsById: resultsById,
      pending: pending,
      conflicts: conflicts
    };
  }

  function mergeStandingsConfig(tournament, stage) {
    var base = (tournament.config && tournament.config.standings) || {};
    var own = (stage.standings && stage.standings.config) || null;
    return own ? S.assign({}, base, own) : base;
  }

  function buildTable(ids, results, cfg, world, stage, group, ctx) {
    var seeds = {};
    (world.entrants || []).forEach(function (e) {
      if (e.seed != null) seeds[e.id] = e.seed;
    });
    var out = S.computeStandings({
      entrantIds: ids,
      results: results,
      config: cfg,
      adjustments: (world.adjustments || []).filter(function (a) {
        return !a.stageId || a.stageId === stage.id;
      }),
      seedBonus: seedBonusFor(stage, ctx),
      seeds: seeds,
      adjudications: world.adjudications || {}
    });

    // A group is only "complete" when every fixture in it is settled; a ref
    // to "Winner Group A" must not resolve off a half-played group.
    var autoConfirm = ctx.autoConfirm;
    var relevant = (world.fixtures || []).filter(function (f) {
      if (f.stageId !== stage.id) return false;
      if (group && f.groupId !== group.id) return false;
      return true;
    });
    out.complete = relevant.length > 0 && relevant.every(function (f) {
      return M.isSettled(f.status, autoConfirm) || f.status === M.STATUS.VOID;
    });

    var sharedKey = {};
    out.unresolved.forEach(function (set) {
      var k = adjudicationKey(set);
      set.forEach(function (id) { sharedKey[id] = k; });
    });
    out.unresolvedKeyFor = function (id) { return sharedKey[id] || null; };
    out.stageId = stage.id;
    out.groupId = group ? group.id : null;
    return out;
  }

  /* Fixed points awarded for where a team finished an earlier stage - the
   * other way leagues carry form forward. */
  function seedBonusFor(stage, ctx) {
    var sb = stage.standings && stage.standings.seedBonus;
    if (!sb || !sb.fromStageId) return null;
    var byGroup = ctx.tables[sb.fromStageId];
    if (!byGroup) return null;
    var out = {};
    Object.keys(byGroup).forEach(function (gid) {
      var t = byGroup[gid];
      if (!t.complete) return;
      t.table.forEach(function (row, i) {
        var pts = sb.byRank && sb.byRank[i + 1];
        if (pts) out[row.entrantId] = pts;
      });
    });
    return out;
  }

  /* --------------------------------------------------------------------- */

  TS.progression = {
    resolveRef: resolveRef,
    resolveTournament: resolveTournament,
    adjudicationKey: adjudicationKey,
    mergeStandingsConfig: mergeStandingsConfig
  };

})(window.TS = window.TS || {});
