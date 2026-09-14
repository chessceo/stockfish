(function () {
  var config = self.STOCKFISH_NNUE_WORKER;
  if (!config) throw new Error('Missing Stockfish worker config');

  var base = self.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  var assetVersion = config.assetVersion || '';
  var queue = [];
  var engine = null;
  var failed = false;
  var heartbeat = null;
  var lastProgress = null;
  var HEARTBEAT_MS = 5000;
  var STORAGE_DB = 'chessceo-stockfish-nnue';
  var STORAGE_STORE = 'files';
  var opfsRootPromise = null;
  var idbPromise = null;
  var startedAt = nowMs();
  var firstEngineLineSeen = false;

  postTiming('script started', {
    module: config.module,
    sharedMemory: config.sharedMemory !== false,
  });

  self.onmessage = function (event) {
    if (engine) engine.uci(event.data);
    else queue.push(event.data);
  };

  function fail(error) {
    if (failed) return;
    failed = true;
    clearHeartbeat();
    var err = error instanceof Error ? error : new Error(String(error));
    postTiming('failed', { message: err.message });
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
    while (true) {
      try {
        var memory = new WebAssembly.Memory({ shared: true, initial: minPages, maximum: high });
        postTiming('shared memory created', { initialPages: minPages, maximumPages: high });
        return memory;
      } catch (error) {
        if (high <= minPages || !(error instanceof RangeError)) throw error;
        high = Math.max(minPages, Math.ceil(high * 0.75));
      }
    }
  }

  function moduleOptions() {
    var options = {
      listen: listen,
      onError: fail,
      locateFile: function (file) { return assetUrl(file); },
      mainScriptUrlOrBlob: assetUrl(config.module),
    };
    if (config.sharedMemory !== false) {
      options.wasmMemory = sharedWasmMemory(config.memoryPages || 2560);
    }
    return options;
  }

  function postProgress(loadedBytes, totalBytes, done, cached) {
    var percent = totalBytes > 0 ? Math.floor((loadedBytes / totalBytes) * 100) : 0;
    lastProgress = {
      loadedBytes: totalBytes > 0 ? Math.min(loadedBytes, totalBytes) : loadedBytes,
      totalBytes: totalBytes,
      percent: done ? percent : Math.min(percent, 99),
      cached: Boolean(cached),
    };
    postMessage({ __stockfishDownload: lastProgress });
  }

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(function () {
      if (lastProgress) postMessage({ __stockfishDownload: lastProgress });
    }, HEARTBEAT_MS);
  }

  function clearHeartbeat() {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  }

  function assetUrl(file) {
    var url = base + file;
    if (!assetVersion || /[?&]v=/.test(url)) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(assetVersion);
  }

  function contentLength(file) {
    postTiming('nnue head start', { file: file });
    return fetch(assetUrl(file), { method: 'HEAD', cache: 'force-cache', credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) return 0;
        var value = Number(response.headers.get('content-length'));
        var bytes = Number.isFinite(value) && value > 0 ? value : 0;
        postTiming('nnue head done', { file: file, status: response.status, bytes: bytes });
        return bytes;
      }, function () {
        postTiming('nnue head failed', { file: file });
        return 0;
      });
  }

  function storageKey(file) {
    return base + file;
  }

  function storageName(key) {
    return 'stockfish-nnue-' + encodeURIComponent(key);
  }

  function errorMessage(error) {
    return error && error.message ? String(error.message) : String(error);
  }

  function opfsRoot() {
    if (opfsRootPromise) return opfsRootPromise;
    opfsRootPromise = Promise.resolve().then(function () {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) return null;
      return navigator.storage.getDirectory().then(function (root) {
        var testName = 'stockfish-nnue-test-' + Math.random().toString(36).slice(2);
        return root.getFileHandle(testName, { create: true })
          .then(function (handle) { return handle.createWritable(); })
          .then(function (writable) {
            return writable.write(new Uint8Array(1))
              .then(function () { return writable.close(); })
              .then(function () {
                root.removeEntry(testName).catch(function () {});
                return root;
              });
          }, function () {
            root.removeEntry(testName).catch(function () {});
            return null;
          })
          .catch(function () {
            root.removeEntry(testName).catch(function () {});
            return null;
          });
      }, function () {
        return null;
      });
    });
    return opfsRootPromise;
  }

  function openIdb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(function (resolve) {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        resolve(value);
      }
      var request = indexedDB.open(STORAGE_DB, 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORAGE_STORE)) db.createObjectStore(STORAGE_STORE);
      };
      request.onsuccess = function () { finish(request.result); };
      request.onerror = function () { finish(null); };
      request.onblocked = function () { finish(null); };
    });
    return idbPromise;
  }

  function readBlobBytes(blob) {
    if (!blob.stream) {
      return blob.arrayBuffer().then(function (buffer) { return new Uint8Array(buffer); });
    }
    var bytes = new Uint8Array(blob.size);
    var offset = 0;
    var reader = blob.stream().getReader();

    function pump() {
      return reader.read().then(function (result) {
        if (result.done) return bytes;
        bytes.set(result.value, offset);
        offset += result.value.length;
        return pump();
      });
    }

    return pump().then(function (result) {
      return offset === blob.size ? result : null;
    });
  }

  function readOpfsBytes(file, key, expectedBytes) {
    return opfsRoot().then(function (root) {
      if (!root) return null;
      postTiming('nnue storage read start', { file: file, store: 'opfs' });
      var name = storageName(key);
      return root.getFileHandle(name, { create: false })
        .then(function (handle) { return handle.getFile(); })
        .then(function (storedFile) {
          if (expectedBytes > 0 && storedFile.size !== expectedBytes) {
            root.removeEntry(name).catch(function () {});
            postTiming('nnue storage stale', {
              file: file,
              store: 'opfs',
              bytes: storedFile.size,
              expectedBytes: expectedBytes,
            });
            return null;
          }
          postTiming('nnue storage hit', { file: file, store: 'opfs', bytes: storedFile.size });
          return readBlobBytes(storedFile).then(function (bytes) {
            if (!bytes) return null;
            postTiming('nnue storage read complete', { file: file, store: 'opfs', bytes: bytes.byteLength });
            return bytes;
          });
        })
        .catch(function () { return null; });
    });
  }

  function idbGet(key) {
    return openIdb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        var transaction = db.transaction(STORAGE_STORE, 'readonly');
        var request = transaction.objectStore(STORAGE_STORE).get(key);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { resolve(null); };
        transaction.onabort = function () { resolve(null); };
      });
    });
  }

  function idbPut(key, bytes) {
    return openIdb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        var transaction = db.transaction(STORAGE_STORE, 'readwrite');
        transaction.objectStore(STORAGE_STORE).put(bytes, key);
        transaction.oncomplete = function () { resolve(true); };
        transaction.onerror = function () { resolve(false); };
        transaction.onabort = function () { resolve(false); };
      });
    });
  }

  function idbDelete(key) {
    return openIdb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        var transaction = db.transaction(STORAGE_STORE, 'readwrite');
        transaction.objectStore(STORAGE_STORE).delete(key);
        transaction.oncomplete = function () { resolve(); };
        transaction.onerror = function () { resolve(); };
        transaction.onabort = function () { resolve(); };
      });
    });
  }

  function storedBytes(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function readIdbBytes(file, key, expectedBytes) {
    postTiming('nnue storage read start', { file: file, store: 'idb' });
    return idbGet(key).then(function (value) {
      var bytes = storedBytes(value);
      if (!bytes) return null;
      if (expectedBytes > 0 && bytes.byteLength !== expectedBytes) {
        idbDelete(key);
        postTiming('nnue storage stale', {
          file: file,
          store: 'idb',
          bytes: bytes.byteLength,
          expectedBytes: expectedBytes,
        });
        return null;
      }
      postTiming('nnue storage hit', { file: file, store: 'idb', bytes: bytes.byteLength });
      postTiming('nnue storage read complete', { file: file, store: 'idb', bytes: bytes.byteLength });
      return bytes;
    });
  }

  function readStoredBytes(file, expectedBytes) {
    var key = storageKey(file);
    return readOpfsBytes(file, key, expectedBytes)
      .then(function (bytes) {
        if (bytes) return bytes;
        return readIdbBytes(file, key, expectedBytes);
      })
      .then(function (bytes) {
        if (!bytes) postTiming('nnue storage miss', { file: file });
        return bytes;
      })
      .catch(function (error) {
        postTiming('nnue storage failed', { file: file, operation: 'read', message: errorMessage(error) });
        return null;
      });
  }

  function writeOpfsBytes(file, key, bytes) {
    return opfsRoot().then(function (root) {
      if (!root) return false;
      postTiming('nnue storage write start', { file: file, store: 'opfs', bytes: bytes.byteLength });
      return root.getFileHandle(storageName(key), { create: true })
        .then(function (handle) { return handle.createWritable(); })
        .then(function (writable) {
          return writable.write(bytes)
            .then(function () { return writable.close(); })
            .then(function () {
              postTiming('nnue storage write complete', { file: file, store: 'opfs', bytes: bytes.byteLength });
              return true;
            });
        })
        .catch(function (error) {
          postTiming('nnue storage failed', {
            file: file,
            operation: 'write',
            store: 'opfs',
            message: errorMessage(error),
          });
          return false;
        });
    });
  }

  function writeIdbBytes(file, key, bytes) {
    postTiming('nnue storage write start', { file: file, store: 'idb', bytes: bytes.byteLength });
    return idbPut(key, bytes).then(function (stored) {
      if (stored) {
        postTiming('nnue storage write complete', { file: file, store: 'idb', bytes: bytes.byteLength });
      } else {
        postTiming('nnue storage failed', { file: file, operation: 'write', store: 'idb' });
      }
    });
  }

  function writeStoredBytes(file, bytes, expectedBytes) {
    if (expectedBytes > 0 && bytes.byteLength !== expectedBytes) {
      postTiming('nnue storage write skipped', {
        file: file,
        bytes: bytes.byteLength,
        expectedBytes: expectedBytes,
      });
      return Promise.resolve();
    }
    var key = storageKey(file);
    return writeOpfsBytes(file, key, bytes)
      .then(function (stored) {
        if (stored) return;
        return writeIdbBytes(file, key, bytes);
      })
      .catch(function (error) {
        postTiming('nnue storage failed', { file: file, operation: 'write', message: errorMessage(error) });
      });
  }

  function fetchBytes(file, completedBytes, totalBytes) {
    postTiming('nnue fetch start', { file: file, completedBytes: completedBytes, totalBytes: totalBytes });
    return fetch(assetUrl(file), { cache: 'force-cache', credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Failed to fetch ' + file + ': HTTP ' + response.status);
      postTiming('nnue response', {
        file: file,
        status: response.status,
        bytes: Number(response.headers.get('content-length')) || 0,
        stream: Boolean(response.body),
      });
      if (!response.body) {
        return response.arrayBuffer().then(function (buffer) {
          postTiming('nnue buffer ready', { file: file, bytes: buffer.byteLength, stream: false });
          postProgress(completedBytes + buffer.byteLength, totalBytes || completedBytes + buffer.byteLength, false, false);
          postTiming('nnue fetch complete', { file: file, bytes: buffer.byteLength, stream: false });
          return new Uint8Array(buffer);
        });
      }

      var reader = response.body.getReader();
      var chunks = [];
      var loaded = 0;
      var sawFirstChunk = false;

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            postTiming('nnue stream complete', { file: file, bytes: loaded, chunks: chunks.length });
            var bytes = new Uint8Array(loaded);
            var offset = 0;
            for (var i = 0; i < chunks.length; i += 1) {
              bytes.set(chunks[i], offset);
              offset += chunks[i].length;
            }
            postTiming('nnue buffer ready', { file: file, bytes: loaded, stream: true, chunks: chunks.length });
            postTiming('nnue fetch complete', { file: file, bytes: loaded, stream: true });
            return bytes;
          }
          chunks.push(result.value);
          loaded += result.value.length;
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            postTiming('nnue first chunk', { file: file, bytes: result.value.length });
          }
          postProgress(completedBytes + loaded, totalBytes || completedBytes + loaded, false, false);
          return pump();
        });
      }

      return pump();
    });
  }

  function loadBytes(file, completedBytes, totalBytes, expectedBytes) {
    return readStoredBytes(file, expectedBytes).then(function (stored) {
      if (stored) {
        postTiming('nnue buffer ready', { file: file, bytes: stored.byteLength, storage: true });
        return { bytes: stored, loadedFrom: 'storage' };
      }
      return fetchBytes(file, completedBytes, totalBytes).then(function (bytes) {
        return writeStoredBytes(file, bytes, expectedBytes).then(function () {
          return { bytes: bytes, loadedFrom: 'fetch' };
        });
      });
    });
  }

  function nnueFiles(stockfish) {
    var files = [];
    for (var i = 0; i < 4; i += 1) {
      var file = stockfish.getRecommendedNnue && stockfish.getRecommendedNnue(i);
      if (!file) break;
      files.push(file);
    }
    return files;
  }

  postTiming('module import start', { module: config.module });

  import(assetUrl(config.module))
    .then(function (module) {
      postTiming('module import done', { module: config.module });
      postTiming('engine instantiate start', { module: config.module });
      return module.default(moduleOptions());
    })
    .then(function (stockfish) {
      postTiming('engine instantiated', { module: config.module });
      var files = nnueFiles(stockfish);
      var totalBytes = 0;
      var completedBytes = 0;
      var storageHits = 0;

      stockfish.listen = listen;
      stockfish.onError = fail;
      startHeartbeat();
      postTiming('nnue files resolved', { files: files, fileCount: files.length });

      return Promise.all(files.map(contentLength))
        .then(function (sizes) {
          totalBytes = sizes.every(function (size) { return size > 0; })
            ? sizes.reduce(function (sum, size) { return sum + size; }, 0)
            : 0;
          postTiming('nnue head summary', { totalBytes: totalBytes });
          return files.reduce(function (previous, file, index) {
            return previous.then(function () {
              return loadBytes(file, completedBytes, totalBytes, sizes[index] || 0).then(function (result) {
                if (result.loadedFrom === 'storage') storageHits += 1;
                completedBytes += result.bytes.byteLength;
                postTiming('nnue apply start', { file: file, index: index, bytes: result.bytes.byteLength, completedBytes: completedBytes });
                stockfish.setNnueBuffer(result.bytes, index);
                postTiming('nnue applied', { file: file, index: index, completedBytes: completedBytes });
              });
            });
          }, Promise.resolve());
        })
        .then(function () {
          var allCached = files.length > 0 && storageHits === files.length;
          postTiming('nnue cache summary', { cached: allCached, cachedFiles: storageHits, cache: 'storage' });
          postProgress(completedBytes, totalBytes || completedBytes, true, allCached);
          clearHeartbeat();
          engine = stockfish;
          postTiming('engine ready', { queuedCommands: queue.length, completedBytes: completedBytes });
          var flushed = queue.length;
          for (var i = 0; i < queue.length; i += 1) engine.uci(queue[i]);
          queue.length = 0;
          postTiming('queue flushed', { queuedCommands: flushed });
        });
    })
    .catch(fail);
})();
