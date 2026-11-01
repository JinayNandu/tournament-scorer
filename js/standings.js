/* Tournament Scorer - standings
 *
 * Turns results into a league table. Knows nothing about any sport: it reads
 * only the MatchResult shape below, and anything sport-specific (net run
 * rate) arrives as a registered comparator over the metrics bag.
 *
 *   MatchResult {
 *     fixtureId, stageId, groupId, status,
 *     home, away,                     entrant ids
 *     outcome,                        'home' | 'away' | 'draw' | 'noResult' | 'void'
 *     units:    {home, away},         rubbers won / goals / runs - the difference metric
 *     subUnits: {home, away},         points scored inside those rubbers
 *     metrics:  {home:{}, away:{}},   engine extras, e.g. {runs, overs, allOut}
 *     weight                          1, or 0.5 for a half-weight carry
 *   }
 *
 * CARRY-OVER IS A COUNTING SET, NOT A NUMBER. A Super 6 stage counts its own
 * fixtures plus the group fixtures between teams that both qualified. Because
 * those matches are genuinely in the set, head-to-head, difference and NRR
 * all come out right with no special case, and a group scoreline corrected on
 * day three propagates on its own. Copying carried points into a field would
 * make head-to-head silently wrong.
 */
(function (TS) {
  'use strict';

  var M = TS.model;

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k]; }
    }
    return target;
  }

  /* ----------------------------------------------- fixture -> MatchResult -- */

  /* Combine a tie's rubber summaries into one result. A single-rubber tie
   * (football, cricket) passes the engine's own numbers straight through; a
   * multi-rubber tie counts rubbers won and totals the points inside them. */
  function tieResult(opts) {
    var fixture = opts.fixture;
    var template = opts.template || { rubbers: [], result: {} };
    var summaries = opts.summaries || {};   // {rubberId: summary}
    var homeId = opts.homeId, awayId = opts.awayId;
    var rule = template.result || {};
    // The meeting's own match count wins over the tournament default, so a
    // meeting that had a match added or removed still adds up.
    var count = opts.matchCount != null ? opts.matchCount
              : (fixture.matchCount != null ? fixture.matchCount
                                            : (template.rubbers || []).length);
    var single = count <= 1;

    var units = { home: 0, away: 0 };
    var sub = { home: 0, away: 0 };
    var metrics = { home: {}, away: {} };
    var played = 0, decided = 0;

    Object.keys(summaries).forEach(function (rid) {
      var s = summaries[rid];
      if (!s || s.status === M.STATUS.NOT_PLAYED || s.status === M.STATUS.VOID) return;
      played++;
      if (single) {
        units.home += (s.primary && s.primary.home) || 0;
        units.away += (s.primary && s.primary.away) || 0;
        if (s.metrics) { metrics.home = s.metrics.home || s.metrics; metrics.away = s.metrics.away || s.metrics; }
      } else if (s.winner) {
        units[s.winner] += 1;
        decided++;
      }
      sub.home += (s.secondary && s.secondary.home) || 0;
      sub.away += (s.secondary && s.secondary.away) || 0;
    });

    var outcome;
    if (fixture.status === M.STATUS.NO_RESULT) {
      outcome = 'noResult';
    } else if (fixture.status === M.STATUS.VOID) {
      outcome = 'void';
    } else if (single) {
      // One rubber: the engine already said who won (which may differ from
      // the scoreline after a shootout).
      var only = Object.keys(summaries)[0];
      var s0 = only ? summaries[only] : null;
      outcome = s0 && s0.winner ? s0.winner
              : (units.home > units.away ? 'home'
                : units.away > units.home ? 'away' : 'draw');
    } else if (rule.primary === 'aggregatePoints') {
      outcome = sub.home > sub.away ? 'home' : sub.away > sub.home ? 'away' : 'draw';
    } else {
      outcome = units.home > units.away ? 'home'
              : units.away > units.home ? 'away' : 'draw';
    }
    if (outcome === 'draw' && rule.allowDraw === false) {
      // Fall through the tie's own tiebreak list before calling it a draw.
      var tb = rule.tiebreak || [];
      for (var i = 0; i < tb.length && outcome === 'draw'; i++) {
        if (tb[i] === 'pointDiff') {
          outcome = sub.home > sub.away ? 'home' : sub.away > sub.home ? 'away' : 'draw';
        }
      }
    }

    return {
      fixtureId: fixture.id,
      stageId: fixture.stageId,
      groupId: fixture.groupId,
      status: fixture.status,
      home: homeId, away: awayId,
      outcome: outcome,
      units: units,
      subUnits: sub,
      metrics: metrics,
      weight: 1,
      rubbersPlayed: played,
      rubbersDecided: decided
    };
  }

  /* --------------------------------------------------------- counting set -- */

  /* The fixture set a stage's table is computed over. `self` means this
   * stage's own fixtures; an earlier stageId with
   * filter "bothEntrantsInThisStage" is the classic Super Six carry. */
  function countingResults(stage, allResults, stageEntrantIds) {
    var spec = (stage.standings && stage.standings.counts) ||
               [{ stageId: 'self', filter: 'all', weight: 1 }];
    var inStage = {};
    (stageEntrantIds || []).forEach(function (id) { inStage[id] = true; });
    var out = [];
    spec.forEach(function (c) {
      if (c.filter === 'none') return;
      var sid = (c.stageId === 'self' || c.stageId == null) ? stage.id : c.stageId;
      allResults.forEach(function (r) {
        if (r.stageId !== sid) return;
        if (c.filter === 'bothEntrantsInThisStage' &&
            !(inStage[r.home] && inStage[r.away])) return;
        out.push(assign({}, r, {
          weight: (r.weight == null ? 1 : r.weight) * (c.weight == null ? 1 : c.weight)
        }));
      });
    });
    return out;
  }

  /* ------------------------------------------------------------- rows ----- */

  function emptyRow(id) {
    return {
      entrantId: id,
      played: 0, won: 0, drawn: 0, lost: 0, noResult: 0,
      unitsFor: 0, unitsAgainst: 0,
      subFor: 0, subAgainst: 0,
      points: 0,
      runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0,
      rank: 0, sharedRank: false
    };
  }

  function outcomeKey(result, side) {
    if (result.outcome === 'noResult') return 'noResult';
    if (result.outcome === 'draw') return 'draw';
    return result.outcome === side ? 'win' : 'loss';
  }

  function pointsFromRules(rules, result, side) {
    var p = 0;
    (rules || []).forEach(function (rule) {
      if (rule.per === 'outcome') {
        var k = outcomeKey(result, side);
        p += (rule.map && rule.map[k]) || 0;
      } else if (rule.per === 'rubberWon' || rule.per === 'unitFor') {
        p += (rule.points || 0) * (result.units[side] || 0);
      } else if (rule.per === 'played') {
        p += (rule.points || 0);
      }
    });
    return p;
  }

  /* Accumulate a set of results into rows. `weight` scales POINTS only -
   * a half-weight carry halves the points, it does not halve goal
   * difference or the number of games played. */
  function accumulate(entrantIds, results, cfg) {
    var rows = {};
    (entrantIds || []).forEach(function (id) { rows[id] = emptyRow(id); });
    var rules = (cfg && cfg.points) || M.pointsRules(2, 1, 0);

    results.forEach(function (r) {
      if (r.outcome === 'void') return;
      ['home', 'away'].forEach(function (side) {
        var id = r[side];
        var row = rows[id];
        if (!row) return;
        var opp = side === 'home' ? 'away' : 'home';
        row.played += 1;
        var k = outcomeKey(r, side);
        if (k === 'win') row.won += 1;
        else if (k === 'loss') row.lost += 1;
        else if (k === 'draw') row.drawn += 1;
        else row.noResult += 1;

        row.unitsFor += r.units[side] || 0;
        row.unitsAgainst += r.units[opp] || 0;
        row.subFor += (r.subUnits && r.subUnits[side]) || 0;
        row.subAgainst += (r.subUnits && r.subUnits[opp]) || 0;
        row.points += pointsFromRules(rules, r, side) * (r.weight == null ? 1 : r.weight);

        var mSide = (r.metrics && r.metrics[side]) || null;
        var mOpp = (r.metrics && r.metrics[opp]) || null;
        if (mSide && mSide.runs != null) {
          row.runsFor += mSide.runs;
          row.oversFor += effectiveOvers(mSide);
        }
        if (mOpp && mOpp.runs != null) {
          row.runsAgainst += mOpp.runs;
          row.oversAgainst += effectiveOvers(mOpp);
        }
      });
    });
    return rows;
  }

  /* A side bowled out counts its FULL quota of overs for net run rate, not
   * the overs it actually faced. Getting this wrong is the single most
   * common NRR bug. */
  function effectiveOvers(m) {
    if (m.allOut && m.quotaOvers) return m.quotaOvers;
    return m.overs || 0;
  }

  function netRunRate(row) {
    var f = row.oversFor > 0 ? row.runsFor / row.oversFor : 0;
    var a = row.oversAgainst > 0 ? row.runsAgainst / row.oversAgainst : 0;
    return f - a;
  }

  /* -------------------------------------------------------- comparators --- */

  /* Each comparator turns a row into a key, higher is better. headToHead is
   * the exception: it is scoped, so it recomputes rows over only the matches
   * among the tied set. */
  var COMPARATORS = {
    points:      { label: 'Points',        get: function (r) { return r.points; } },
    won:         { label: 'Wins',          get: function (r) { return r.won; } },
    unitsDiff:   { label: 'Difference',    get: function (r) { return r.unitsFor - r.unitsAgainst; } },
    unitsFor:    { label: 'For',           get: function (r) { return r.unitsFor; } },
    rubberDiff:  { label: 'Rubber diff',   get: function (r) { return r.unitsFor - r.unitsAgainst; } },
    rubbersFor:  { label: 'Rubbers won',   get: function (r) { return r.unitsFor; } },
    gamesDiff:   { label: 'Game diff',     get: function (r) { return r.unitsFor - r.unitsAgainst; } },
    pointDiff:   { label: 'Point diff',    get: function (r) { return r.subFor - r.subAgainst; } },
    pointsFor:   { label: 'Points scored', get: function (r) { return r.subFor; } },
    goalsFor:    { label: 'Goals for',     get: function (r) { return r.unitsFor; } },
    pointsRatio: { label: 'Points / game', get: function (r) { return r.played ? r.points / r.played : 0; } },
    netRunRate:  { label: 'NRR',           get: netRunRate },
    headToHead:  { label: 'Head to head',  scope: 'headToHead',
                   composite: ['points', 'unitsDiff', 'unitsFor'] }
  };

  function registerComparator(name, spec) { COMPARATORS[name] = spec; }

  /* ----------------------------------------------------------- ranking ---- */

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /* A head-to-head mini-league only means something when every pair in the
   * tied set has met the same number of times. Mid-stage, and always in a
   * Super 6 drawn from uneven groups, that is false - and then falling
   * through to the next criterion is the correct answer, not a bug. */
  function isBalanced(ids, scoped) {
    if (ids.length < 2) return true;
    var counts = {};
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) counts[pairKey(ids[i], ids[j])] = 0;
    }
    scoped.forEach(function (r) {
      var k = pairKey(r.home, r.away);
      if (k in counts) counts[k] += 1;
    });
    var vals = Object.keys(counts).map(function (k) { return counts[k]; });
    if (!vals.length) return false;
    var first = vals[0];
    if (first === 0) return false;
    for (var v = 0; v < vals.length; v++) { if (vals[v] !== first) return false; }
    return true;
  }

  function restrict(results, ids) {
    var inSet = {};
    ids.forEach(function (id) { inSet[id] = true; });
    return results.filter(function (r) { return inSet[r.home] && inSet[r.away]; });
  }

  // Keys are arrays compared lexicographically, so a composite criterion
  // (head-to-head) and a plain one work through the same code path.
  function criterionKeys(name, ids, results, ctx) {
    var comp = COMPARATORS[name];
    if (!comp) return null;
    var keys = {};
    if (comp.scope === 'headToHead') {
      var scoped = restrict(results, ids);
      if (!isBalanced(ids, scoped)) return null;       // skip: meaningless
      var rows = accumulate(ids, scoped, ctx.cfg);
      ids.forEach(function (id) {
        keys[id] = (comp.composite || ['points']).map(function (c) {
          return COMPARATORS[c].get(rows[id], ctx);
        });
      });
      return keys;
    }
    ids.forEach(function (id) { keys[id] = [comp.get(ctx.rows[id], ctx)]; });
    return keys;
  }

  function cmpKey(a, b) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x !== y) return y - x;                        // higher is better
    }
    return 0;
  }

  // Ordered blocks of entrants sharing the same key.
  function partitionByKey(ids, keys) {
    var sorted = ids.slice().sort(function (a, b) { return cmpKey(keys[a], keys[b]); });
    var blocks = [], cur = [];
    sorted.forEach(function (id) {
      if (!cur.length || cmpKey(keys[cur[0]], keys[id]) === 0) { cur.push(id); }
      else { blocks.push(cur); cur = [id]; }
    });
    if (cur.length) blocks.push(cur);
    return blocks;
  }

  /* Deterministic and stored, never random at render time - otherwise the
   * table flickers between two phones looking at the same group. */
  function finalTiebreak(ids, ctx) {
    var k = ids.slice().sort().join('|');
    var stored = ctx.adjudications && ctx.adjudications[k];
    if (stored) {
      return ids.slice().sort(function (a, b) {
        return stored.indexOf(a) - stored.indexOf(b);
      });
    }
    if (ids.length > 1) ctx.unresolved.push(ids.slice());
    return ids.slice().sort(function (a, b) {
      var sa = ctx.seeds[a], sb = ctx.seeds[b];
      if (sa != null && sb != null && sa !== sb) return sa - sb;
      if (sa != null && sb == null) return -1;
      if (sb != null && sa == null) return 1;
      return a < b ? -1 : 1;
    });
  }

  /* The recursive part. Two real-world behaviours after a partial split:
   * UEFA restarts the whole criteria list on the remaining teams (so
   * head-to-head is recomputed over just those two), FIFA continues down the
   * list. Both are used, hence the flag. */
  function rankWithin(ids, criteria, results, ctx) {
    if (ids.length <= 1) return ids.slice();
    for (var i = 0; i < criteria.length; i++) {
      var keys = criterionKeys(criteria[i], ids, results, ctx);
      if (!keys) continue;
      var blocks = partitionByKey(ids, keys);
      if (blocks.length > 1) {
        var next = ctx.onPartition === 'restart' ? criteria : criteria.slice(i + 1);
        var out = [];
        blocks.forEach(function (b) {
          out = out.concat(rankWithin(b, next, results, ctx));
        });
        return out;
      }
    }
    return finalTiebreak(ids, ctx);
  }

  /* --------------------------------------------------------- the table ---- */

  function computeStandings(opts) {
    var entrantIds = (opts.entrantIds || []).slice();
    var results = (opts.results || []).filter(function (r) {
      return r.outcome !== 'void';
    });
    var cfg = opts.config || {};
    var rows = accumulate(entrantIds, results, cfg);

    // Points deductions and seeding bonuses sit outside match results.
    (opts.adjustments || []).forEach(function (a) {
      if (rows[a.entrantId]) rows[a.entrantId].points += (a.points || 0);
    });
    if (opts.seedBonus) {
      Object.keys(opts.seedBonus).forEach(function (id) {
        if (rows[id]) rows[id].points += opts.seedBonus[id];
      });
    }

    Object.keys(rows).forEach(function (id) {
      var r = rows[id];
      r.unitsDiff = r.unitsFor - r.unitsAgainst;
      r.subDiff = r.subFor - r.subAgainst;
      r.nrr = netRunRate(r);
    });

    var ctx = {
      rows: rows,
      cfg: cfg,
      seeds: opts.seeds || {},
      adjudications: opts.adjudications || {},
      onPartition: cfg.onPartition || 'restart',
      unresolved: []
    };

    var criteria = ['points'].concat(cfg.tiebreaks || M.DEFAULT_TIEBREAKS);
    var order = rankWithin(entrantIds, criteria, results, ctx);

    // Entrants nothing could separate share a rank, shown as "2=".
    var sharedWith = {};
    ctx.unresolved.forEach(function (set) {
      set.forEach(function (id) { sharedWith[id] = set; });
    });

    var table = order.map(function (id, i) {
      var r = rows[id];
      r.rank = i + 1;
      r.sharedRank = !!sharedWith[id];
      return r;
    });
    // A shared block all shows the block's best rank.
    ctx.unresolved.forEach(function (set) {
      var best = Math.min.apply(null, set.map(function (id) { return rows[id].rank; }));
      set.forEach(function (id) { rows[id].rank = best; });
    });

    return { table: table, rows: rows, unresolved: ctx.unresolved };
  }

  TS.standings = {
    tieResult: tieResult,
    countingResults: countingResults,
    accumulate: accumulate,
    computeStandings: computeStandings,
    COMPARATORS: COMPARATORS,
    registerComparator: registerComparator,
    netRunRate: netRunRate,
    effectiveOvers: effectiveOvers,
    isBalanced: isBalanced,
    rankWithin: rankWithin,
    assign: assign
  };

})(window.TS = window.TS || {});
