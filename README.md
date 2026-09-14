# chess.ceo Stockfish builds

This is the source for the modified Stockfish builds chess.ceo ships in its
browser engine and mobile app (referenced from the app's credits page). It is
a [GPL-3.0](LICENSE) derivative of
[official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish).

Contents:

- `patches/` — our changes as diffs against upstream Stockfish 17.1 and 18
  source (browser/Emscripten adaptation: external NNUE loading, disabling
  native filesystem/network-verification assumptions that don't hold in a
  browser, a single-threaded/Asyncify variant, and the small-net "lite"
  build). Stockfish 19 is built from
  [lichess-org/stockfish-web](https://github.com/lichess-org/stockfish-web)
  (also GPL-3.0) rather than our own patch set.
- `glue/` — the Emscripten C++ glue and JS runtime loader that bridges the
  compiled module to the classic postMessage/UCI worker protocol our app
  speaks. Derived from lichess-org/stockfish-web's GPL-3.0 browser glue.
- `build-wasm.mjs` / `test-wasm.mjs` — the build and smoke-test scripts.
- `android/` — the native ARM64 build for the Flutter mobile app: a universal
  `libstockfish.so` (armv8 + armv8-dotprod, runtime CPU dispatch, one shared
  NNUE net) built from a patched Stockfish source tree (PIE→PIC for shared-lib
  linking, `#embed`→incbin for NDK Clang compatibility) plus a small Dart-FFI
  glue layer.

**Reproducing the exact build:** the patches apply to Stockfish 17.1 and 18
source checked out locally as `~/Stockfish-17` / `~/Stockfish-18` when this
was built; the exact commit isn't recorded here yet. Filenames elsewhere in
chess.ceo's app (e.g. `stockfish-17.1-single-a496a04.js`,
`stockfish-17.1-lite-single-03e3232.js`) embed what look like the intended
upstream commit hashes (`a496a04`, `03e3232`) — treat those as a starting
point, not a verified pin, until confirmed against upstream history.

## Build

```bash
node build-wasm.mjs all
```

Defaults:

- SF17 source: `~/Stockfish-17`
- SF18 source: `~/Stockfish-18`
- build folder: `/tmp/chessceo-stockfish-wasm-build`
- output folder: `/tmp/chessceo-stockfish-wasm-output`
- threading: `mt`
- weight: `full`

Use local Emscripten. If it is not in `~/emsdk`, set:

```bash
EMSDK_ROOT=/path/to/emsdk node build-wasm.mjs sf18
```

Use `--threading st` to build the no-pthread variant, or `--threading both` to
build both variants.

Use `--weight lite` to build the small-network variant, or `--weight both` to
build both full and lite variants. The lite build uses
`nn-9067e33176e8.nnue` as the only NNUE and disables the small-net fallback in
Stockfish itself. For SF17/SF18 this is a real lite build: the patch also
changes the big network architecture to the 256-dimension layout expected by
that NNUE. Only changing the default NNUE filename will compile, but Stockfish
will reject the net when analysis starts.

The ST build follows the nmrugg `stockfish.js` browser flags: pthreads are
disabled, `__EMSCRIPTEN_SINGLE_THREADED__` is defined, Asyncify is enabled, and
the UCI bridge functions are exported explicitly. Those flags are necessary but
not sufficient by themselves; the Stockfish source patch must also avoid the
normal native-thread search lifecycle.

Each build writes:

- the wasm module, for example
  `sf_18_full_mt_module.js`/`sf_18_full_mt_module.wasm` for full MT and
  `sf_18_lite_st_module.js`/`sf_18_lite_st_module.wasm` for lite ST;
- a browser worker wrapper, for example `sf_18_full_mt.js` or
  `sf_18_lite_st.js`;
- `sf_nnue_loader.js`, used by the wrappers to load the external NNUE files.

The compiled module does not include an NNUE. Full and lite still use separate
compiled modules because the lite build changes Stockfish's default NNUE list
and disables the second small-net path.

The SF17/SF18 browser patches skip Stockfish's native startup `load_networks()`
call. The worker applies the external NNUE buffers before flushing queued UCI
commands, so loading from the browser's empty native path only adds `uciok`
latency.

Runtime `verify_networks()` is still kept for normal commands so failed NNUE
loads remain visible during smoke tests and analysis.

## Worker Naming

Normal selectable local-analysis workers use:

```text
sf_<version>_<full|lite>_<mt|st>.js
sf_<version>_<full|lite>_<mt|st>_module.js
sf_<version>_<full|lite>_<mt|st>_module.wasm
```

Use explicit `full`/`lite` names for SF17, SF18, and SF19. That keeps the file
names aligned with the engine selector and avoids guessing which NNUE profile a
worker loads.

`stockfish.wasm.js` and `stockfish.wasm` are intentionally separate. They are a
small fallback for SmartMove, not normal local-analysis engine-selector builds.

## Smoke Test

```bash
node test-wasm.mjs /tmp/chessceo-stockfish-wasm-output/sf_18_full_mt_module.js \
  --nnue-root ~/Stockfish-18 \
  --nnue-root ~/Stockfish-17
```

For the single-threaded browser build, also verify that infinite analysis can
be stopped:

```bash
node test-wasm.mjs /tmp/chessceo-stockfish-wasm-output/sf_18_lite_st_module.js \
  --nnue-root ~/Stockfish-18 \
  --nnue-root ~/Stockfish-17 \
  --nnue-root public/workers \
  --stop-test
```

The test imports the ES module in Node, asks it which NNUE files it expects,
loads those files from the provided roots, runs `uci`, `isready`, and
`go depth 1`, then waits for `bestmove`. It also prints a compact timing
summary for import, instantiate, NNUE load, `uciok`, `readyok`, and depth-1
search latency.

The glue files are based on the GPL-3.0 `lichess-org/stockfish-web` browser
glue. The compiled Stockfish artifacts are GPL-3.0 Stockfish derivatives.
