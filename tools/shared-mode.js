/* DEV ONLY - never published. Loaded by dev.html, after the app's own
 * scripts and before it boots.
 *
 * Local storage hands back fresh, mutable objects and resolves writes
 * instantly. The shared store does neither: every snapshot it delivers is
 * FROZEN, and every write is a round trip. That gap hid a bug that left
 * the published app on "Loading..." for good while every local test
 * passed, so this shim makes the local store behave like the shared one:
 *
 *   - everything read is deep-frozen, so writing to a snapshot throws here
 *     exactly as it would on the real thing;
 *   - writes resolve on a timer, so anything that assumes a write has
 *     already landed falls over here too;
 *   - snapshots are re-delivered after a write, as a live store would.
 *
 * Switch it off from the console with __shared.off(), or tune the delay
 * with __shared.latency = 0.
 */
(function (TS) {
  'use strict';
  if (!TS || !TS.store) { return; }

  var cfg = { freeze: true, latency: 90 };
  var S = TS.store;
  var real = {
    get: S.get, list: S.list, watchDoc: S.watchDoc,
    watchCollection: S.watchCollection,
    set: S.set, update: S.update, del: S.del
  };

  function deepFreeze(o) {
    if (!cfg.freeze || !o || typeof o !== 'object' || Object.isFrozen(o)) return o;
    Object.freeze(o);
    Object.getOwnPropertyNames(o).forEach(function (k) {
      var v;
      try { v = o[k]; } catch (e) { return; }
      deepFreeze(v);
    });
    return o;
  }

  function freezeRows(rows) {
    if (rows && rows.length) rows.forEach(deepFreeze);
    return rows;
  }

  function slow(run) {
    return new Promise(function (resolve, reject) {
      window.setTimeout(function () {
        try { Promise.resolve(run()).then(resolve, reject); }
        catch (e) { reject(e); }
      }, cfg.latency);
    });
  }

  S.get = function () {
    var a = arguments;
    return slow(function () { return real.get.apply(S, a); }).then(deepFreeze);
  };

  S.list = function () {
    var a = arguments;
    return slow(function () { return real.list.apply(S, a); }).then(freezeRows);
  };

  S.watchDoc = function (path, cb, onErr) {
    return real.watchDoc.call(S, path, function (doc) { cb(deepFreeze(doc)); }, onErr);
  };

  S.watchCollection = function (path, opts, cb, onErr) {
    return real.watchCollection.call(S, path, opts, function (rows) {
      return cb(freezeRows(rows));
    }, onErr);
  };

  ['set', 'update', 'del'].forEach(function (name) {
    S[name] = function () {
      var a = arguments;
      return slow(function () { return real[name].apply(S, a); });
    };
  });

  window.__shared = {
    cfg: cfg,
    get latency() { return cfg.latency; },
    set latency(ms) { cfg.latency = ms; },
    off: function () {
      Object.keys(real).forEach(function (k) { S[k] = real[k]; });
      cfg.freeze = false;
      return 'shared-mode off';
    }
  };

  if (window.console) {
    console.info('[shared-mode] frozen snapshots, ' + cfg.latency + 'ms writes');
  }
})(window.TS);
