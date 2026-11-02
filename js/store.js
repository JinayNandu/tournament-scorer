/* Tournament Scorer - storage
 *
 * One interface, two backends.
 *
 *   cloud  the artifact `db` capability. Shared and live: several phones
 *          score different courts and everyone's table updates. Needs the
 *          viewer signed in.
 *   local  localStorage. A lone scorer with no account gets a fully working
 *          app; nothing leaves the device.
 *
 * Document layout (about 940 documents for a 12-team pickleball league,
 * against a 25,000 cap):
 *
 *   tournaments/{tid}                    meta, config, stages
 *   tournaments/{tid}/entrants/{eid}
 *   tournaments/{tid}/players/{pid}
 *   tournaments/{tid}/fixtures/{fid}     sides, lineup, rubberSummary map
 *   tournaments/{tid}/rubbers/{rid}      slots, court, lock, events, summary
 *
 * Events live INSIDE the rubber document, not one document each. The store
 * caps an artifact at 25,000 documents and says outright not to map a
 * growing stream to a document per item; a 21-point game is ~45 events of a
 * few bytes, so a rubber document stays far under the 256 KiB limit.
 *
 * Two scorers opening the same rubber is handled by acquire(), the store's
 * own single-writer lease, rather than by hoping.
 */
(function (TS) {
  'use strict';

  var LS_PREFIX = 'ts1:';
  var mode = 'local';
  /* Whether the Claude runtime is here at all, which is NOT the same as
   * being signed in. Both land in local mode, but only one of them has a
   * sign-in to offer - a copy served from anywhere else has none, and
   * telling its visitors to go and find one sends them nowhere. */
  var runtime = false;
  /* Which of the three is answering: the open shared backend, the
   * artifact's own db, or nothing but this device. */
  var backend = 'device';
  /* Configured, and still no answer. Falling back to the device is the
   * right thing to do; doing it SILENTLY is how an organiser discovers at
   * the tournament that none of the other phones can see the scores. */
  var sharedFailed = false;
  var db = null;
  var user = null;
  var userId = null;
  var readyPromise = null;

  /* ------------------------------------------------------------ roles -- */

  /* Two roles, and the whole difference is whether a write is allowed.
   *
   *   admin   may change anything: create, score, correct, delete.
   *   viewer  may read all of it, live, and write none of it.
   *
   * Each backend answers this differently, and NONE of the answers is the
   * user interface. Hiding a button is politeness; it is not access
   * control, and a hidden button is one forgotten `if` away from being
   * tapped.
   *
   *   device     always admin. It is your own phone, nobody else can see
   *              it, and there is nothing to protect it from.
   *   artifact   claude.ai has already decided. A Viewer or Commenter on
   *              the share cannot write the db whatever this app believes,
   *              so `user.can('data.write')` IS the answer, and the Share
   *              menu is where it gets changed.
   *   firestore  a scoring code per tournament, checked by the rules on
   *              the server. See firestore.js and tools/firestore.rules.
   *
   * ASSUME ADMIN UNTIL TOLD OTHERWISE. The answer arrives over a network,
   * and a scoreboard that swallows the first taps of a game is worse than
   * one that lets a viewer tap and then says the write was refused. Same
   * reasoning as the lease, and for the same reason. */
  var role = 'admin';
  var roleWatchers = [];

  function canEdit() { return role === 'admin'; }

  function setRole(next) {
    if (next !== 'admin' && next !== 'viewer') return role;
    if (next === role) return role;
    role = next;
    roleWatchers.forEach(function (cb) { try { cb(role); } catch (e) { report(e); } });
    return role;
  }

  function onRole(cb) { roleWatchers.push(cb); cb(role); }

  /* A VIEWER'S WRITE STOPS HERE, not in a screen. Every write mirrors to
   * localStorage before it goes anywhere, so that a dropped connection is
   * survivable - which for a viewer is exactly the wrong thing: their own
   * phone would accept the change, show it back to them, and they would
   * spend the afternoon looking at a tournament nobody else can see.
   * Refusing at the store also means a control some screen forgot to hide
   * costs a toast rather than a divergence. */
  function refuse() {
    return Promise.reject({
      code: 'permission_denied',
      message: 'You are watching this tournament. Ask the organiser for the scoring code if you need to change something.'
    });
  }

  /* ----------------------------------------------------- local emitter -- */

  var listeners = [];   // {path, isCollection, cb}

  function emit(path) {
    listeners.forEach(function (l) {
      if (l.isCollection) {
        if (path.indexOf(l.path + '/') === 0 &&
            path.slice(l.path.length + 1).indexOf('/') === -1) {
          try { l.cb(localList(l.path, l.opts)); } catch (e) { report(e); }
        }
      } else if (l.path === path) {
        try { l.cb(localGet(path)); } catch (e) { report(e); }
      }
    });
  }

  function report(e) {
    if (window.console && console.warn) console.warn('[store]', e);
  }

  /* ------------------------------------------------------ local backend -- */

  function lsKey(path) { return LS_PREFIX + path; }

  function localGet(path) {
    try {
      var raw = window.localStorage.getItem(lsKey(path));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { report(e); return null; }
  }

  function localSet(path, data) {
    try {
      window.localStorage.setItem(lsKey(path), JSON.stringify(data));
    } catch (e) {
      report(e);
      throw { code: 'quota_exceeded', message: 'This device is out of storage space for the app. Export a backup, then clear finished tournaments.' };
    }
  }

  function localDel(path) {
    try { window.localStorage.removeItem(lsKey(path)); } catch (e) { report(e); }
  }

  function localList(collPath, opts) {
    var out = [];
    var prefix = LS_PREFIX + collPath + '/';
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (!k || k.indexOf(prefix) !== 0) continue;
        var rest = k.slice(prefix.length);
        if (rest.indexOf('/') !== -1) continue;      // a deeper document
        var v = localGet(collPath + '/' + rest);
        if (v) out.push(v);
      }
    } catch (e) { report(e); }
    return filterSort(out, opts);
  }

  function filterSort(rows, opts) {
    opts = opts || {};
    var out = rows;
    (opts.where || []).forEach(function (w) {
      out = out.filter(function (r) { return testWhere(r[w[0]], w[1], w[2]); });
    });
    if (opts.orderBy) {
      var f = opts.orderBy, dir = opts.dir === 'desc' ? -1 : 1;
      out = out.slice().sort(function (a, b) {
        return a[f] === b[f] ? 0 : (a[f] < b[f] ? -1 : 1) * dir;
      });
    }
    if (opts.limit) out = out.slice(0, opts.limit);
    return out;
  }

  function testWhere(v, op, x) {
    switch (op) {
      case '==': return v === x;
      case '!=': return v !== x;
      case '<': return v < x;
      case '<=': return v <= x;
      case '>': return v > x;
      case '>=': return v >= x;
      case 'in': return (x || []).indexOf(v) !== -1;
      case 'not-in': return (x || []).indexOf(v) === -1;
      case 'array-contains': return (v || []).indexOf(x) !== -1;
      default: return true;
    }
  }

  /* ------------------------------------------------------------- init --- */

  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = openShared().then(function (shared) {
      if (!shared) return openArtifact();
      db = shared;
      mode = 'cloud';
      backend = 'firestore';
      setRole(TS.firestore.isOrganiser() ? 'admin' : 'viewer');
      return info();
    });
    return readyPromise;
  }

  /* The open backend is tried FIRST, ahead of the artifact's own db. The
   * whole point of configuring one is that everybody is looking at a
   * single tournament; leaving signed-in viewers on a different store
   * from everyone else would quietly make two, and the organiser would
   * be the one person who could not see what the scorers were doing. */
  function openShared() {
    if (!TS.firestore || !TS.firestore.configured()) return Promise.resolve(null);
    return TS.firestore.connect().then(function (shared) {
      if (!shared) sharedFailed = true;   // a wrong key, a blocked CDN
      return shared;
    });
  }

  function openArtifact() {
    return (function () {
      var claude = window.claude;
      if (!claude || typeof claude.use !== 'function') {
        mode = 'local';
        return Promise.resolve(info());
      }
      runtime = true;
      return Promise.all([
        claude.use('db').catch(function () { return null; }),
        claude.use('user').catch(function () { return null; })
      ]).then(function (res) {
        db = res[0];
        user = res[1];
        mode = db ? 'cloud' : 'local';
        backend = db ? 'artifact' : 'device';
        if (!user) return info();
        return Promise.resolve()
          .then(function () { return user.id ? user.id() : null; })
          .then(function (id) { userId = id; })
          .then(function () {
            // can("data.write") may answer null, meaning "not told" - keep
            // the controls enabled and let a rejected write decide.
            if (!user.can) return null;
            return user.can('data.write');
          })
          .then(function (w) { if (w === false) setRole('viewer'); })
          .catch(function () {})
          .then(info);
      }).catch(function () {
        mode = 'local';
        return info();
      });
    })();
  }

  function info() {
    return { mode: mode, backend: backend, runtime: runtime,
             sharedFailed: sharedFailed, role: role, canEdit: canEdit(),
             userId: userId, clientId: clientId() };
  }

  var _clientId = null;
  function clientId() {
    if (_clientId) return _clientId;
    try {
      _clientId = window.localStorage.getItem(LS_PREFIX + 'clientId');
    } catch (e) { /* private window */ }
    if (!_clientId) {
      _clientId = 'c' + Math.random().toString(36).slice(2, 10);
      try { window.localStorage.setItem(LS_PREFIX + 'clientId', _clientId); } catch (e) {}
    }
    return _clientId;
  }

  /* ------------------------------------------------------ the access -- */

  /* Being a scorer is PER TOURNAMENT on the open backend, so opening one
   * re-asks. Being an organiser is not, so it is settled once at connect.
   * The other two backends have one answer for everything and ignore the
   * tournament entirely. */
  function useTournament(tid) {
    if (backend !== 'firestore' || !TS.firestore) return Promise.resolve(role);
    return TS.firestore.refreshRole(tid || null)
      .then(function (r) { return setRole(r); }, function () { return role; });
  }

  /* What the screens may OFFER, which differs by backend. Asking this
   * once beats testing the backend's name in five places and getting the
   * fifth one wrong. */
  function access() {
    return {
      role: role,
      canEdit: canEdit(),
      backend: backend,
      /* Only the open backend has codes of its own. On the artifact,
       * claude.ai's Share menu already decides and this app must not
       * pretend otherwise; on a lone device there is nobody to share
       * with. */
      codes: backend === 'firestore',
      /* An organiser runs every tournament and mints the codes; a
       * scorer can only score the one they were given. On the other
       * two backends there is no such distinction to draw. */
      organiser: backend === 'firestore' && TS.firestore
        ? TS.firestore.isOrganiser() : canEdit(),
      shared: mode === 'cloud'
    };
  }

  function noCodes() {
    return Promise.reject({ code: 'unsupported',
      message: 'This copy has no scoring codes of its own.' });
  }

  function joinTournament(tid, code, name) {
    if (backend !== 'firestore') return noCodes();
    return TS.firestore.joinTournament(tid, code, name)
      .then(function (r) { return setRole(r); });
  }

  function joinOrganiser(code, name) {
    if (backend !== 'firestore') return noCodes();
    return TS.firestore.joinOrganiser(code, name)
      .then(function (r) { return setRole(r); });
  }

  function claimOrganiser(code, name) {
    if (backend !== 'firestore') return noCodes();
    return TS.firestore.claimOrganiser(code, name)
      .then(function (r) { return setRole(r); });
  }

  function organiserClaimable() {
    if (backend !== 'firestore') return Promise.resolve(false);
    return TS.firestore.organiserClaimable();
  }

  function scorerCode(tid) {
    if (backend !== 'firestore') return Promise.resolve(null);
    return TS.firestore.scorerCode(tid);
  }

  /* Minting one is a write, so it is an admin's act like any other. */
  function setScorerCode(tid, code) {
    if (!canEdit()) return refuse();
    if (backend !== 'firestore') return noCodes();
    return TS.firestore.setScorerCode(tid, code);
  }

  function newCode() {
    return TS.firestore ? TS.firestore.makeCode(6) : null;
  }

  /* ------------------------------------------------------ write queueing -- */

  /* The store wants one write at a time per document, awaited. Overlapping
   * writes to one document just make each one slower, and a burst of taps
   * on a scoreboard is exactly how that happens. */
  var chains = {};
  function queued(path, fn) {
    var prev = chains[path] || Promise.resolve();
    var next = prev.then(fn, fn).then(function (v) {
      if (chains[path] === next) delete chains[path];
      return v;
    }, function (e) {
      if (chains[path] === next) delete chains[path];
      throw e;
    });
    chains[path] = next;
    return next;
  }

  /* --------------------------------------------------- pending (offline) -- */

  /* Hall wifi drops. A cloud write that fails for a transient reason is kept
   * on the device and flushed on the next successful call or when the tab
   * becomes visible again, so a scorer does not lose a game. */
  function pendingKey() { return LS_PREFIX + 'pending'; }

  function readPending() {
    try { return JSON.parse(window.localStorage.getItem(pendingKey()) || '{}'); }
    catch (e) { return {}; }
  }

  function writePending(p) {
    try { window.localStorage.setItem(pendingKey(), JSON.stringify(p)); }
    catch (e) { report(e); }
  }

  function stash(path, data) {
    var p = readPending();
    p[path] = { data: data, at: Date.now() };
    writePending(p);
    notifyPending();
  }

  function unstash(path) {
    var p = readPending();
    if (p[path]) { delete p[path]; writePending(p); notifyPending(); }
  }

  var pendingWatchers = [];
  function notifyPending() {
    var n = Object.keys(readPending()).length;
    pendingWatchers.forEach(function (cb) { try { cb(n); } catch (e) { report(e); } });
  }
  function onPending(cb) { pendingWatchers.push(cb); cb(Object.keys(readPending()).length); }

  function flushPending() {
    if (mode !== 'cloud' || !db) return Promise.resolve(0);
    var p = readPending();
    var paths = Object.keys(p);
    if (!paths.length) return Promise.resolve(0);
    var done = 0;
    return paths.reduce(function (chain, path) {
      return chain.then(function () {
        return db.doc(path).set(p[path].data).then(function () {
          unstash(path); done += 1;
        }, function () { /* still offline; keep it */ });
      });
    }, Promise.resolve()).then(function () { return done; });
  }

  function isTransient(err) {
    var c = err && err.code;
    return c === 'unavailable' || c === 'resource_exhausted' || !c;
  }

  /* --------------------------------------------------------- operations -- */

  function get(path) {
    if (mode === 'cloud') {
      return db.doc(path).get().then(function (snap) {
        return snap.exists ? snap.data() : null;
      }).catch(function (e) {
        report(e);
        return localGet(path);
      });
    }
    return Promise.resolve(localGet(path));
  }

  function set(path, data) {
    if (!canEdit()) return refuse();
    return queued(path, function () {
      localSet(path, data);                 // always mirror, so a drop is survivable
      if (mode !== 'cloud') { emit(path); return Promise.resolve(); }
      return db.doc(path).set(data).then(function () {
        unstash(path);
        return flushPending();
      }, function (e) {
        if (isTransient(e)) { stash(path, data); return; }
        throw e;
      });
    });
  }

  /* Merge-write. Nested objects merge recursively, which is what lets eleven
   * scorers write {rubberSummary: {<their id>: ...}} into one fixture
   * document without clobbering each other. */
  function update(path, patch) {
    if (!canEdit()) return refuse();
    return queued(path, function () {
      var cur = localGet(path) || {};
      localSet(path, deepMerge(cur, patch));
      if (mode !== 'cloud') { emit(path); return Promise.resolve(); }
      return db.doc(path).update(patch).catch(function (e) {
        if (e && e.code === 'invalid_argument') {
          // update() requires the document to exist; create it instead.
          return db.doc(path).set(deepMerge(localGet(path) || {}, patch));
        }
        if (isTransient(e)) { stash(path, localGet(path)); return; }
        throw e;
      });
    });
  }

  function del(path) {
    if (!canEdit()) return refuse();
    return queued(path, function () {
      localDel(path);
      if (mode !== 'cloud') { emit(path); return Promise.resolve(); }
      return db.doc(path).delete().catch(report);
    });
  }

  function list(collPath, opts) {
    opts = opts || {};
    if (mode === 'cloud') {
      var q = db.collection(collPath);
      (opts.where || []).forEach(function (w) { q = q.where(w[0], w[1], w[2]); });
      if (opts.orderBy) q = q.orderBy(opts.orderBy, opts.dir || 'asc');
      if (opts.limit) q = q.limit(opts.limit);
      return q.get().then(function (snap) {
        return snap.docs.map(function (d) { return d.data(); });
      }).catch(function (e) {
        report(e);
        return localList(collPath, opts);
      });
    }
    return Promise.resolve(localList(collPath, opts));
  }

  function watchDoc(path, cb, onError) {
    if (mode === 'cloud') {
      return db.doc(path).onSnapshot(function (snap) {
        var d = snap.exists ? snap.data() : null;
        if (d) { try { localSet(path, d); } catch (e) {} }
        cb(d);
      }, onError || report);
    }
    var l = { path: path, isCollection: false, cb: cb };
    listeners.push(l);
    cb(localGet(path));
    return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
  }

  function watchCollection(collPath, opts, cb, onError) {
    opts = opts || {};
    if (mode === 'cloud') {
      var q = db.collection(collPath);
      (opts.where || []).forEach(function (w) { q = q.where(w[0], w[1], w[2]); });
      if (opts.orderBy) q = q.orderBy(opts.orderBy, opts.dir || 'asc');
      if (opts.limit) q = q.limit(opts.limit);
      return q.onSnapshot(function (snap) {
        cb(snap.docs.map(function (d) { return d.data(); }));
      }, onError || report);
    }
    var l = { path: collPath, isCollection: true, cb: cb, opts: opts };
    listeners.push(l);
    cb(localList(collPath, opts));
    return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
  }

  /* The store's own cooperative lease. Not a security boundary - it stops
   * two well-behaved scorers fighting over one rubber, which is the actual
   * problem. Local mode has one writer by definition. */
  /* A viewer never asks for the lease. Asking is a write, the rules
   * would refuse it, and the refusal would arrive looking exactly like
   * "another phone is scoring this" - which is the one thing it is not. */
  function acquire(path, opts) {
    if (!canEdit()) return Promise.resolve({ acquired: false, viewer: true });
    if (mode !== 'cloud') return Promise.resolve({ acquired: true, local: true });
    return db.doc(path).acquire({
      holder: opts.holder, ttlMs: opts.ttlMs || 45000
    }).catch(function () { return { acquired: true, degraded: true }; });
  }

  function deepMerge(base, patch) {
    var out = {};
    Object.keys(base || {}).forEach(function (k) { out[k] = base[k]; });
    Object.keys(patch || {}).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) &&
          out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  /* -------------------------------------------------------- backup I/O -- */

  /* Entrants and players travel inside the tournament document. */
  function exportTournament(tid) {
    return Promise.all([
      get('tournaments/' + tid),
      list('tournaments/' + tid + '/fixtures'),
      list('tournaments/' + tid + '/rubbers')
    ]).then(function (r) {
      return {
        format: 'tournament-scorer', version: 1,
        exportedAt: new Date().toISOString(),
        tournament: r[0], fixtures: r[1], rubbers: r[2]
      };
    });
  }

  function importTournament(bundle) {
    if (!bundle || bundle.format !== 'tournament-scorer' || !bundle.tournament) {
      return Promise.reject(new Error('That file is not a tournament export.'));
    }
    var t = bundle.tournament;
    var base = 'tournaments/' + t.id;
    return set(base, t).then(function () {
      return runLimited((bundle.fixtures || []).map(function (row) {
        return function () { return set(base + '/fixtures/' + row.id, row); };
      }), 4);
    }).then(function () {
      return runLimited((bundle.rubbers || []).map(function (row) {
        return function () { return set(base + '/rubbers/' + row.id, row); };
      }), 4);
    }).then(function () { return t.id; });
  }

  /* Writes to DIFFERENT documents may overlap, but firing 60 at once trips
   * the per-viewer call rate. Four at a time is quick and safe. */
  function runLimited(tasks, n) {
    n = n || 4;
    var i = 0, active = 0, failed = null;
    return new Promise(function (resolve, reject) {
      function pump() {
        if (failed) return;
        if (i >= tasks.length && active === 0) return resolve();
        while (active < n && i < tasks.length) {
          active += 1;
          tasks[i++]().then(function () {
            active -= 1; pump();
          }, function (e) {
            active -= 1;
            if (e && e.code === 'invalid_argument') { failed = e; reject(e); }
            else pump();
          });
        }
      }
      pump();
    });
  }

  /* Drop the event logs of finished rubbers, keeping their summaries. The
   * full pickleball season is about 2.6 MB against a 5 MB localStorage
   * quota, so this is the valve when a device gets tight. */
  function compact(tid) {
    return list('tournaments/' + tid + '/rubbers').then(function (rubbers) {
      var done = rubbers.filter(function (r) {
        return r.summary && r.summary.complete && (r.events || []).length;
      });
      return done.reduce(function (chain, r) {
        return chain.then(function () {
          r.events = [];
          r.compacted = true;
          return set('tournaments/' + tid + '/rubbers/' + r.id, r);
        });
      }, Promise.resolve()).then(function () { return done.length; });
    });
  }

  if (window.document) {
    window.document.addEventListener('visibilitychange', function () {
      if (!window.document.hidden) flushPending();
    });
  }

  TS.store = {
    init: init,
    info: info,
    clientId: clientId,
    mode: function () { return mode; },
    backend: function () { return backend; },
    canEdit: canEdit,
    role: function () { return role; },
    access: access,
    useTournament: useTournament,
    joinTournament: joinTournament, joinOrganiser: joinOrganiser,
    claimOrganiser: claimOrganiser, organiserClaimable: organiserClaimable,
    scorerCode: scorerCode, setScorerCode: setScorerCode, newCode: newCode,
    setRole: setRole,
    onRole: onRole,
    userId: function () { return userId; },
    get: get,
    set: set,
    update: update,
    del: del,
    list: list,
    watchDoc: watchDoc,
    watchCollection: watchCollection,
    acquire: acquire,
    deepMerge: deepMerge,
    exportTournament: exportTournament,
    importTournament: importTournament,
    runLimited: runLimited,
    compact: compact,
    onPending: onPending,
    flushPending: flushPending,
    // exposed for selftest
    _isTransient: isTransient,
    _filterSort: filterSort,
    _localList: localList
  };

})(window.TS = window.TS || {});
