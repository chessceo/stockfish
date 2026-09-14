if (!Module['listen']) Module['listen'] = data => console.log(data);
if (!Module['onError']) Module['onError'] = data => console.error(data);

function refreshHeapView() {
  const memory = Module['wasmMemory'];
  if (memory && Module['HEAPU8'] && Module['HEAPU8'].buffer !== memory.buffer) {
    Module['HEAPU8'] = new Uint8Array(memory.buffer);
  }
}

Module['getRecommendedNnue'] = (index = 0) => UTF8ToString(_getRecommendedNnue(index)) || undefined;

Module['setNnueBuffer'] = function (buf, index = 0) {
  if (!buf) throw new Error('buf is null');
  if (buf.byteLength <= 0) throw new Error(`${buf.byteLength} bytes?`);
  const heapBuf = _malloc(buf.byteLength);
  if (!heapBuf) throw new Error(`could not allocate ${buf.byteLength} bytes`);
  refreshHeapView();
  Module['HEAPU8'].set(buf, heapBuf);
  _setNnueBuffer(heapBuf, buf.byteLength, index);
};

Module['uci'] = function (command) {
  if (typeof _command === 'function' && /^go\b/.test(command)) {
    return Module['ccall']('command', null, ['string'], [command], { async: true });
  }
  const sz = lengthBytesUTF8(command) + 1;
  const utf8 = _malloc(sz);
  if (!utf8) throw new Error(`could not allocate ${sz} bytes`);
  stringToUTF8(command, utf8, sz);
  _uci(utf8);
};

Module['isSearching'] = function () {
  return typeof _isSearching === 'function' && _isSearching();
};

Module['print'] = data => Module['listen']?.(data);
Module['printErr'] = data => Module['onError']?.(data);
