// Adapter: bridges @lichess-org/stockfish-web's module API (uci()/listen/
// onError, NNUE loaded separately via setNnueBuffer) to the classic
// postMessage/onmessage UCI-line-over-Worker protocol every other build in
// this directory speaks, so StockfishEngineController.ts needs no changes
// beyond a new STOCKFISH_BUILDS entry pointing at this file.
//
// Plain classic worker (no `type: 'module'`, matching how the app always
// instantiates these via `new Worker(url)`) — sf_19.js is an ES module, so
// it's loaded with a dynamic import() instead of a static one, which works
// from any worker context in current browsers.
//
// Commands sent before the async engine + NNUE net are ready are queued and
// flushed in order, the same pattern DesktopStockfishPort uses for the
// Electron native-engine port.
//
// Reports NNUE fetch progress back to the main thread as a tagged object
// message ({__stockfishDownload: {...}}) on every chunk read AND on a
// heartbeat timer independent of chunk delivery. Per-chunk alone is not
// enough: fetch stream chunk boundaries and delivery cadence are
// browser/network-controlled, not ours, so a single slow chunk (e.g. one
// TCP read that takes 60s+ on a very slow connection) can go that whole
// stretch without a message, which is longer than the controller's 20s
// inactivity window even though the transfer is genuinely still alive. The
// heartbeat re-posts the last known progress every HEARTBEAT_MS regardless
// of whether a new chunk has arrived, so the controller always sees
// activity well inside its window as long as the fetch promise is still
// pending — including the response.body-unsupported fallback path below,
// which previously reported no progress at all.
//
// Does NOT enforce its own init deadline: StockfishEngineController's
// handshake watchdog (inactivity-reset, plus a non-resetting absolute cap)
// is the sole timeout authority. A second, independent, progress-blind
// deadline here previously killed a healthy multi-minute transfer on its
// own fixed schedule regardless of what the controller's mechanism decided.
(function () {
  var LABEL = 'sf_19_full_mt';
  var ENGINE_MODULE = 'sf_19_full_mt_module.js';
  var NNUE_FILE = 'sf_19_full.nnue';
  var ASSET_VERSION = 'chessceo-stockfish-wasm-2026.09.19';
  // Comfortably under the controller's 20s inactivity window (and its
  // preload counterpart's, same constant) - several heartbeats fit inside
  // it even if one is delayed by main-thread contention.
  var HEARTBEAT_MS = 5000;
  var MIN_MEMORY_PAGES = 2560;

  var base = self.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  var queue = [];
  var engine = null;
  var failed = false;
  var startedAt = nowMs();
  var firstEngineLineSeen = false;

  postTiming('script started', {
    module: ENGINE_MODULE,
    nnue: NNUE_FILE,
    sharedMemory: true,
  });

  self.onmessage = function (event) {
    if (engine) {
      engine.uci(event.data);
    } else {
      queue.push(event.data);
    }
  };

  function fail(error) {
    if (failed) return;
    failed = true;
    var err = error instanceof Error ? error : new Error(String(error));
    postTiming('failed', { message: err.message });
    // Re-throw async so it surfaces as a genuine `worker.onerror` event on
    // the main thread, matching what a real engine crash looks like.
    setTimeout(function () { throw err; });
  }

  function listen(line) {
    var text = String(line);
    if (!firstEngineLineSeen && text.trim()) {
      firstEngineLineSeen = true;
      postTiming('engine first line', { line: text.slice(0, 120) });
    }
    if (text.split(/\r?\n/).some(function (part) { return part.trim() === 'uciok'; })) {
      postTiming('engine uciok emitted');
    }
    postMessage(line);
  }

  function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }

  function postTiming(stage, extra) {
    var payload = {
      stage: stage,
      workerElapsedMs: Math.round(nowMs() - startedAt),
      label: LABEL,
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) payload[key] = extra[key];
      }
    }
    postMessage({ __stockfishTiming: payload });
  }

  function sharedWasmMemory(minPages, maxPages) {
    var high = maxPages || 32767;
    var shrink = 4;
    while (true) {
      try {
        var memory = new WebAssembly.Memory({ shared: true, initial: minPages, maximum: high });
        postTiming('shared memory created', { initialPages: minPages, maximumPages: high });
        return memory;
      } catch (error) {
        if (high <= minPages || !(error instanceof RangeError)) throw error;
        high = Math.max(minPages, Math.ceil(high - high / shrink));
        shrink = shrink === 4 ? 3 : 4;
      }
    }
  }

  function cachedAsset(url) {
    try {
      return fetch(url, {
        cache: 'only-if-cached',
        credentials: 'same-origin',
        mode: 'same-origin',
      }).then(function (response) {
        if (response.body && response.body.cancel) response.body.cancel().catch(function () {});
        return response.ok;
      }, function () {
        return false;
      });
    } catch (_) {
      return Promise.resolve(false);
    }
  }

  function assetUrl(file) {
    var url = base + file;
    if (!ASSET_VERSION || /[?&]v=/.test(url)) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(ASSET_VERSION);
  }

  function fetchWithProgress(url) {
    postTiming('nnue fetch start', { file: NNUE_FILE });
    return cachedAsset(url).then(function (cached) {
      postTiming('nnue cache summary', { file: NNUE_FILE, cached: cached, cachedFiles: cached ? 1 : 0 });
      return fetch(url, { cache: 'force-cache', credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Failed to fetch ' + url + ': HTTP ' + response.status);
      var totalStr = response.headers.get('content-length');
      var total = totalStr ? Number(totalStr) : 0;
      postTiming('nnue response', {
        file: NNUE_FILE,
        status: response.status,
        bytes: total,
        stream: Boolean(response.body),
      });
      var loaded = 0;
      var heartbeat = setInterval(function () {
        var percent = total > 0 ? Math.floor((loaded / total) * 100) : 0;
        postMessage({ __stockfishDownload: { loadedBytes: loaded, totalBytes: total, percent: percent, cached: cached } });
      }, HEARTBEAT_MS);
      function stopHeartbeat() { clearInterval(heartbeat); }

      if (!response.body) {
        return response.arrayBuffer().then(
          function (buffer) {
            stopHeartbeat();
            postMessage({ __stockfishDownload: { loadedBytes: buffer.byteLength, totalBytes: total || buffer.byteLength, percent: 100, cached: cached } });
            postTiming('nnue fetch complete', { file: NNUE_FILE, bytes: buffer.byteLength, stream: false });
            return buffer;
          },
          function (error) { stopHeartbeat(); throw error; },
        );
      }

      var reader = response.body.getReader();
      var chunks = [];
      var sawFirstChunk = false;
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            stopHeartbeat();
            var buffer = new Uint8Array(loaded);
            var offset = 0;
            for (var i = 0; i < chunks.length; i++) { buffer.set(chunks[i], offset); offset += chunks[i].length; }
            postTiming('nnue fetch complete', { file: NNUE_FILE, bytes: loaded, stream: true });
            return buffer.buffer;
          }
          chunks.push(result.value);
          loaded += result.value.length;
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            postTiming('nnue first chunk', { file: NNUE_FILE, bytes: result.value.length });
          }
          var percent = total > 0 ? Math.floor((loaded / total) * 100) : 0;
          // Every chunk, not gated by percent: on top of the heartbeat, a
          // real chunk arriving is real progress worth reporting immediately.
          postMessage({ __stockfishDownload: { loadedBytes: loaded, totalBytes: total, percent: percent, cached: cached } });
          return pump();
        }, function (error) { stopHeartbeat(); throw error; });
      }
      return pump();
      });
    });
  }

  postTiming('module import start', { module: ENGINE_MODULE });

  import(assetUrl(ENGINE_MODULE))
    .then(function (module) {
      postTiming('module import done', { module: ENGINE_MODULE });
      postTiming('engine instantiate start', { module: ENGINE_MODULE });
      return module.default({
        listen: listen,
        onError: fail,
        wasmMemory: sharedWasmMemory(MIN_MEMORY_PAGES),
        locateFile: function (file) { return assetUrl(file); },
        mainScriptUrlOrBlob: assetUrl(ENGINE_MODULE),
      });
    })
    .then(function (eng) {
      postTiming('engine instantiated', { module: ENGINE_MODULE });
      eng.listen = listen;
      eng.onError = fail;
      return fetchWithProgress(assetUrl(NNUE_FILE)).then(function (buffer) {
        eng.setNnueBuffer(new Uint8Array(buffer));
        postTiming('nnue applied', { file: NNUE_FILE, bytes: buffer.byteLength });
        engine = eng;
        postTiming('engine ready', { queuedCommands: queue.length });
        var flushed = queue.length;
        for (var i = 0; i < queue.length; i++) engine.uci(queue[i]);
        queue.length = 0;
        postTiming('queue flushed', { queuedCommands: flushed });
      });
    })
    .catch(fail);
})();
