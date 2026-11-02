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
    /* Rules cannot tell two phones apart unless they have signed in, so
     * the auth SDK is not optional once there are roles. */
    { file: 'firebase-auth-compat.js',
      sri: 'sha512-3cqk/DPTFXaLj0gVaBHoRiepOCPMd0YBVYmoxzN6nWy2QH3v5hwqq4JC8LMInZd+MFQe60aF130v8x9sYE7czA==' },
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

  /* ---------------------------------------------------- who you are --- */

  /* Everybody signs in ANONYMOUSLY, viewers included - invisibly, with
   * nothing to type and no account to make. It costs a viewer nothing and
   * it is the only way the rules get a uid to hang membership on. It is
   * not an identity: it is a handle on this browser. Clearing site data
   * loses it, and that costs a scorer one re-entry of the code.
   *
   * Two kinds of membership, because a tournament has two kinds of staff:
   *
   *   organisers/{uid}                 may create tournaments and run all
   *                                    of them. One key, typed once, ever.
   *   tournaments/{tid}/scorers/{uid}  may score THAT tournament. A code
   *                                    per tournament, so handing one
   *                                    event over does not hand over the
   *                                    rest, and last month's scorers do
   *                                    not still have the keys. */
  var me = { uid: null, organiser: false, scorerOf: {} };

  /* Pure, so the one line that decides whether somebody may score can be
   * tested without a network, a project, or a code to type into it. */
  function roleOf(state, tid) {
    if (!state || !state.uid) return 'viewer';
    if (state.organiser) return 'admin';
    if (tid && state.scorerOf && state.scorerOf[tid]) return 'admin';
    return 'viewer';
  }

  /* A code is read off one phone and typed into another, standing beside
   * a court in a noisy hall. 0/O and 1/I/L are left out so nobody has to
   * ask which one it was, and the vowels with them so it cannot land on a
   * word. Anything outside this set in a typed code is a misreading of a
   * character that was never in it, so normCode does not try to rescue
   * it - it just strips the spaces and dashes people add. */
  var ALPHABET = 'BCDFGHJKMNPQRSTVWXZ23456789';

  function makeCode(n, rand) {
    var out = '', i;
    n = n || 6;
    for (i = 0; i < n; i++) {
      var r = rand ? rand() : Math.random();
      out += ALPHABET.charAt(Math.floor(r * ALPHABET.length) % ALPHABET.length);
    }
    return out;
  }

  function normCode(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  function organiserPath(uid) { return 'organisers/' + uid; }
  function scorerPath(tid, uid) { return 'tournaments/' + tid + '/scorers/' + uid; }
  function codePath(tid) { return 'tournaments/' + tid + '/access/code'; }
  var CONFIG_PATH = 'access/config';

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
      store = fs;
      return signIn(fb).then(function (uid) {
        me.uid = uid || null;
        return uid ? exists(fs, organiserPath(uid)) : false;
      }, function () {
        /* Anonymous sign-in off in the console, or no network for it.
         * Reads still work under rules that allow them, so the right
         * thing is to carry on as a viewer rather than show nothing. */
        return false;
      }).then(function (org) {
        me.organiser = !!org;
        return {
          doc: function (path) { return wrapDoc(fs, path); },
          collection: function (path) { return wrapQuery(fs.collection(path), path); }
        };
      });
    }, function (e) {
      if (window.console && console.warn) console.warn('[firestore]', e);
      return null;
    });
  }

  /* ------------------------------------------------------ the verbs --- */

  var store = null;

  function signIn(fb) {
    if (!fb.auth) return Promise.resolve(null);
    var auth = fb.auth();
    if (auth.currentUser) return Promise.resolve(auth.currentUser.uid);
    return withTimeout(auth.signInAnonymously(), READ_MS, 'sign-in')
      .then(function (cred) {
        return (cred && cred.user && cred.user.uid) ||
               (auth.currentUser && auth.currentUser.uid) || null;
      });
  }

  function exists(fs, path) {
    return withTimeout(fs.doc(path).get(), READ_MS, path)
      .then(function (s) { return !!(s && s.exists); }, function () { return false; });
  }

  /* Asked again whenever a tournament is opened, because being a scorer
   * is per tournament. Being an organiser is not, so it is only looked up
   * once, at connect, and after a join. */
  function refreshRole(tid) {
    if (!store || !me.uid) return Promise.resolve(roleOf(me, tid));
    if (!tid) return Promise.resolve(roleOf(me, null));
    if (me.organiser) return Promise.resolve('admin');
    return exists(store, scorerPath(tid, me.uid)).then(function (yes) {
      me.scorerOf[tid] = yes;
      return roleOf(me, tid);
    });
  }

  /* THE CODE IS NEVER CHECKED HERE. The client cannot read it - the rules
   * see to that - so joining is an ordinary write that the server accepts
   * or refuses, and a refusal IS a wrong code. Checking in the page would
   * mean shipping the code to everyone who opens it. */
  function claim(path, code, name) {
    if (!store) return Promise.reject({ code: 'unavailable', message: 'Not connected.' });
    if (!me.uid) {
      return Promise.reject({ code: 'unauthenticated',
        message: 'This phone could not sign in, so it cannot be given scoring access. Check that Anonymous sign-in is on in the Firebase console.' });
    }
    var c = normCode(code);
    if (!c) return Promise.reject({ code: 'invalid_argument', message: 'Type the code first.' });
    return withTimeout(store.doc(path).set({
      code: c, name: String(name || '').slice(0, 40), at: Date.now()
    }), WRITE_MS, path).then(function () { return true; }, function (e) {
      var n = normError(e);
      if (n.code === 'permission_denied') {
        throw { code: 'wrong_code',
                message: 'That code was not right. Check it with the organiser.' };
      }
      throw n;
    });
  }

  function joinTournament(tid, code, name) {
    return claim(scorerPath(tid, me.uid), code, name).then(function () {
      me.scorerOf[tid] = true;
      return 'admin';
    });
  }

  function joinOrganiser(code, name) {
    return claim(organiserPath(me.uid), code, name).then(function () {
      me.organiser = true;
      return 'admin';
    });
  }

  /* An organiser needs to SEE the code to read it out; the rules let a
   * member read it and nobody else. A tournament with no code document
   * yet has never been shared, which is not an error - it is the state
   * every tournament starts in. */
  function scorerCode(tid) {
    if (!store) return Promise.resolve(null);
    return withTimeout(store.doc(codePath(tid)).get(), READ_MS, codePath(tid))
      .then(function (s) {
        return (s && s.exists && s.data() && s.data().scorerCode) || null;
      }, function () { return null; });
  }

  function setScorerCode(tid, code) {
    if (!store) return Promise.reject({ code: 'unavailable', message: 'Not connected.' });
    var c = normCode(code) || makeCode(6);
    return withTimeout(store.doc(codePath(tid)).set({ scorerCode: c, at: Date.now() }),
      WRITE_MS, codePath(tid)).then(function () { return c; }, failed);
  }

  /* The first phone to open a brand new database sets the organiser key,
   * because the alternative is a console step done before the app has
   * ever run and a typo nobody can diagnose. The window in which somebody
   * else could claim it is the window before the link has been given to
   * anybody, so in practice it is shut. The rules refuse a second claim. */
  function organiserClaimable() {
    if (!store) return Promise.resolve(false);
    return exists(store, CONFIG_PATH).then(function (yes) { return !yes; });
  }

  function claimOrganiser(code, name) {
    if (!store || !me.uid) {
      return Promise.reject({ code: 'unavailable', message: 'Not connected.' });
    }
    var c = normCode(code);
    if (c.length < 4) {
      return Promise.reject({ code: 'invalid_argument',
        message: 'Make the organiser key at least four characters.' });
    }
    /* MEMBERSHIP FIRST, THEN THE KEY. The rules let any signed-in phone
     * become an organiser while no key exists, and shut that door the
     * moment one does. Done the other way round, a failure between the
     * two writes would leave a database holding a key that nobody holds
     * and no way left to set one - locked, permanently, with nothing on
     * screen to say why. This order's worst case is a database with an
     * organiser and no key yet, which is simply the state before the
     * second write and is fixed by trying again. */
    return joinOrganiser(c, name).then(function () {
      return withTimeout(store.doc(CONFIG_PATH).set({ organiserCode: c, at: Date.now() }),
        WRITE_MS, CONFIG_PATH).then(function () { return 'admin'; }, failed);
    });
  }

  TS.firestore = {
    version: VERSION,
    configured: configured,
    connect: connect,
    uid: function () { return me.uid; },
    isOrganiser: function () { return me.organiser; },
    refreshRole: refreshRole,
    joinTournament: joinTournament,
    joinOrganiser: joinOrganiser,
    organiserClaimable: organiserClaimable,
    claimOrganiser: claimOrganiser,
    scorerCode: scorerCode,
    setScorerCode: setScorerCode,
    makeCode: makeCode,
    normCode: normCode,
    // exposed for selftest
    _roleOf: roleOf,
    // exposed for selftest
    _normError: normError,
    _leasePath: leasePath,
    _leaseDecision: leaseDecision
  };

})(window.TS = window.TS || {});
