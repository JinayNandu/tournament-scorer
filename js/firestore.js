/* Tournament Scorer - the open shared backend
 *
 * store.js already speaks to a document database: the Artifact `db`
 * capability. That one only answers for viewers signed in to claude.ai, so
 * a copy of this app served from anywhere else has nobody to talk to and
 * falls back to the device. Twelve teams on their own phones are not going
 * to sign in to anything, and eleven courts cannot score into one table
 * through localStorage.
 *
 * So: Firestore, wrapped to look exactly like the capability store.js was
 * written against. It is a close fit because the Artifact db is itself
 * Firestore-shaped - same paths, same queries, same snapshots - and the
 * storage layout was already designed around its limits. Four things do
 * not line up, and each is handled below:
 *
 *   update()     means a RECURSIVE merge here; Firestore's own update()
 *                replaces a nested map wholesale.
 *   acquire()    has no equivalent at all, so it is built out of a
 *                transaction, in a document of its own.
 *   error codes  are hyphenated here and underscored there.
 *   a dead link  leaves a Firestore write pending rather than failing it.
 *
 * The SDK is fetched only when a config is present, so the published
 * artifact - which has a db of its own - never pays for any of this. It
 * comes from cdnjs because that is an origin the Artifact runtime allows,
 * which keeps one code path working in both places.
 */
(function (TS) {
  'use strict';

  var VERSION = '11.3.1';
  var BASE = 'https://cdnjs.cloudflare.com/ajax/libs/firebase/' + VERSION + '/';
  var PARTS = [
    { file: 'firebase-app-compat.js',
      sri: 'sha512-VPHBBOy7CWRw8PTmCpGrYD0nddvWyiBeEADlgzVem9eLZPVO/e96nYujVf9NVLYLsFlPSjkRyoOep+NNLu8BXg==' },
    { file: 'firebase-firestore-compat.js',
      sri: 'sha512-NMmOM0hMoueUujkZfP+wQcGwP11rg9cSEDgwh/Dz1wbgG2qhQEcecO6zLzM1Kfk212xuJ0XdLsSsIM2kboiqXg==' }
  ];

  var READ_MS = 10000;
  var WRITE_MS = 8000;
  var LEASE_MS = 45000;

  function config() { return window.TS_FIREBASE || null; }

  function configured() {
    var c = config();
    return !!(c && c.apiKey && c.projectId);
  }

  /* ------------------------------------------------------ pure helpers -- */

  /* Firestore spells its codes with hyphens, sometimes behind a service
   * prefix; store.js tests for the underscored names the Artifact db uses.
   * isTransient() deciding wrongly is the difference between a point
   * stashed for later and a point lost, so this is not cosmetic. */
  function normError(e) {
    var code = (e && e.code) ? String(e.code) : '';
    var slash = code.lastIndexOf('/');
    if (slash !== -1) code = code.slice(slash + 1);
    return { code: code.replace(/-/g, '_'),
             message: (e && e.message) || String(e || 'failed') };
  }

  /* Where one court's lease lives. NOT on the rubber document: scoring a
   * point writes that whole document back, which would drop the lease on
   * the floor every few seconds, and a heartbeat on it would wake every
   * watcher of that match. A sibling collection has neither problem. */
  function leasePath(path) {
    var p = String(path || '').split('/');
    if (p.length < 2) return null;
    p[p.length - 2] = 'leases';
    return p.join('/');
  }

  /* An expired lease is free, and so is one nobody holds, one already in
   * this holder's name, and one whose record makes no sense - a lock with
   * no expiry would otherwise hold a court for the rest of the tournament.
   * Only a live lease in somebody else's name refuses, and store.js treats
   * even that as advice: a scoreboard that swallows the first taps is
   * worse than the rare double-scored rally. */
  function leaseDecision(cur, holder, now, ttlMs) {
    if (cur && cur.holder && cur.holder !== holder &&
        typeof cur.expiresAt === 'number' && cur.expiresAt > now) {
      return { acquired: false, holder: cur.holder };
    }
    return { acquired: true,
             lock: { holder: holder, heartbeatAt: now,
                     expiresAt: now + (ttlMs || LEASE_MS) } };
  }

  /* ---------------------------------------------------------- the SDK -- */

  var sdk = null;

  function loadScript(src, sri) {
    return new Promise(function (resolve, reject) {
      var s = window.document.createElement('script');
      s.src = src;
      s.integrity = sri;
      s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      window.document.head.appendChild(s);
    });
  }

  function loadSdk() {
    if (sdk) return sdk;
    sdk = PARTS.reduce(function (chain, p) {
      return chain.then(function () { return loadScript(BASE + p.file, p.sri); });
    }, Promise.resolve());
    return sdk;
  }

  /* -------------------------------------------------------- wrapping --- */

  /* Firestore does not reject a write it cannot deliver. It queues the
   * write and leaves the promise pending until the network returns, which
   * in a sports hall can be minutes. store.js chains writes per document,
   * so a single pending one would block every later write to that court
   * for good - the scoreboard would simply stop saving. A timeout turns it
   * into the transient failure store.js already knows how to handle: stash
   * it on the device, flush it on the next success. Firestore's own queue
   * may land it as well, which costs nothing, because every write here
   * sets a whole document rather than editing one. */
  function withTimeout(p, ms, what) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject({ code: 'unavailable', message: what + ' did not reach the server.' });
      }, ms);
      p.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function failed(e) { throw normError(e); }

  function snapOf(s) {
    return { exists: !!s.exists, data: function () { return s.data(); } };
  }

  function listOf(snap) {
    return { docs: snap.docs.map(function (d) {
      return { data: function () { return d.data(); } };
    }) };
  }

  function wrapQuery(q, label) {
    return {
      where: function (f, op, v) { return wrapQuery(q.where(f, op, v), label); },
      orderBy: function (f, dir) { return wrapQuery(q.orderBy(f, dir || 'asc'), label); },
      limit: function (n) { return wrapQuery(q.limit(n), label); },
      get: function () {
        return withTimeout(q.get(), READ_MS, label).then(listOf, failed);
      },
      onSnapshot: function (cb, onError) {
        return q.onSnapshot(function (snap) { cb(listOf(snap)); },
          function (e) { if (onError) onError(normError(e)); });
      }
    };
  }

  function acquire(fs, path, opts) {
    var lp = leasePath(path);
    if (!lp) return Promise.resolve({ acquired: true, degraded: true });
    var ref = fs.doc(lp);
    return fs.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var d = leaseDecision(snap.exists ? snap.data() : null,
                              opts.holder, Date.now(), opts.ttlMs);
        if (d.acquired) tx.set(ref, d.lock);
        return d.acquired ? { acquired: true }
                          : { acquired: false, holder: d.holder };
      });
    });
  }

  function wrapDoc(fs, path) {
    var ref = fs.doc(path);
    return {
      get: function () {
        return withTimeout(ref.get(), READ_MS, path).then(snapOf, failed);
      },
      set: function (data) {
        return withTimeout(ref.set(data), WRITE_MS, path).then(null, failed);
      },
      /* store.js means a RECURSIVE merge by update(): eleven scorers each
       * write their own key of one fixture's rubberSummary and must not
       * clobber one another. Firestore's update() replaces a nested map
       * whole, so it is the wrong verb here; set with merge is the one
       * that descends. It also creates a missing document, which update()
       * refuses to do - the case store.js currently rescues by hand. */
      update: function (patch) {
        return withTimeout(ref.set(patch, { merge: true }), WRITE_MS, path)
          .then(null, failed);
      },
      'delete': function () {
        return withTimeout(ref['delete'](), WRITE_MS, path).then(null, failed);
      },
      onSnapshot: function (cb, onError) {
        return ref.onSnapshot(function (s) { cb(snapOf(s)); },
          function (e) { if (onError) onError(normError(e)); });
      },
      acquire: function (opts) { return acquire(fs, path, opts || {}); }
    };
  }

  /* --------------------------------------------------------- connect --- */

  function connect() {
    if (!configured()) return Promise.resolve(null);
    return loadSdk().then(function () {
      var fb = window.firebase;
      if (!fb || !fb.firestore) return null;
      if (!fb.apps.length) fb.initializeApp(config());
      var fs = fb.firestore();
      /* Documents here are built by cloning and editing, so a key left
       * undefined is routine; Firestore rejects the entire write for one
       * unless told to drop it. settings() throws if anything has already
       * touched the database, which on a second call is exactly right. */
      try { fs.settings({ ignoreUndefinedProperties: true }); } catch (e) {}
      return {
        doc: function (path) { return wrapDoc(fs, path); },
        collection: function (path) { return wrapQuery(fs.collection(path), path); }
      };
    }, function (e) {
      if (window.console && console.warn) console.warn('[firestore]', e);
      return null;
    });
  }

  TS.firestore = {
    version: VERSION,
    configured: configured,
    connect: connect,
    // exposed for selftest
    _normError: normError,
    _leasePath: leasePath,
    _leaseDecision: leaseDecision
  };

})(window.TS = window.TS || {});
