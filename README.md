# chess.ceo Stockfish builds

Source for the modified Stockfish that chess.ceo ships in the browser and in
the mobile app. A [GPL-3.0](LICENSE) derivative of
[official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish).

| Path | Contents |
|---|---|
| `patches/` | Diffs against Stockfish 17.1 and 18 for the browser: external NNUE loading, no native filesystem or network verification at startup, a single-threaded Asyncify variant, and a small-net "lite" build. |
| `glue/` | Emscripten C++ glue and JS loader that expose the module as a postMessage/UCI worker. Derived from [lichess-org/stockfish-web](https://github.com/lichess-org/stockfish-web) (GPL-3.0). |
| `build-wasm.mjs`, `test-wasm.mjs` | Build and smoke test. |
| `android/` | ARM64 `libstockfish.so` for the mobile app: armv8 and armv8-dotprod in one library, runtime CPU dispatch, one shared NNUE. See [`android/README.md`](android/README.md). |

Stockfish 19 is built from lichess-org/stockfish-web, not from these patches.

**Upstream commits are not pinned.** The patches were made against local
checkouts of 17.1 and 18. The worker file names in the app
(`stockfish-17.1-single-a496a04.js`, `stockfish-17.1-lite-single-03e3232.js`)
point to `a496a04` and `03e3232`, but that has not been verified.

## Build

```bash
node build-wasm.mjs all
```

| Setting | Default |
|---|---|
| SF17 source | `~/Stockfish-17` |
| SF18 source | `~/Stockfish-18` |
| Build folder | `/tmp/chessceo-stockfish-wasm-build` |
| Output folder | `/tmp/chessceo-stockfish-wasm-output` |
| Emscripten | `~/emsdk`, or set `EMSDK_ROOT` |
| `--threading mt\|st\|both` | `mt` |
| `--weight full\|lite\|both` | `full` |

```bash
EMSDK_ROOT=/path/to/emsdk node build-wasm.mjs sf18
```

**Lite** uses `nn-9067e33176e8.nnue` as the only net and disables Stockfish's
small-net fallback. For SF17 and SF18 the patch also changes the big-network
architecture to the 256-dimension layout that net expects. Changing only the
default NNUE file name compiles, but Stockfish rejects the net when analysis
starts.

**Single-threaded (`st`)** follows the nmrugg `stockfish.js` flags: no
pthreads, `__EMSCRIPTEN_SINGLE_THREADED__` defined, Asyncify on, UCI bridge
functions exported explicitly. The flags are not enough alone: the source
patch also keeps Stockfish off its native-thread search lifecycle.

Each build writes:

- `sf_<version>_<full|lite>_<mt|st>_module.js` and `.wasm`: the module
- `sf_<version>_<full|lite>_<mt|st>.js`: the browser worker
- `sf_nnue_loader.js`: loads the external NNUE files for the workers

No NNUE is compiled in. Full and lite are still separate modules, because lite
changes the default NNUE list and disables the second small-net path.

The SF17 and SF18 patches skip the startup `load_networks()` call, which in a
browser would only delay `uciok`. The worker applies the NNUE buffers before
it flushes queued UCI commands. `verify_networks()` still runs, so a failed
NNUE load shows up in the smoke test and in analysis.

`stockfish.wasm.js` and `stockfish.wasm` are a separate small fallback for
SmartMove, not one of the selectable engines.

## Smoke test

```bash
node test-wasm.mjs /tmp/chessceo-stockfish-wasm-output/sf_18_full_mt_module.js \
  --nnue-root ~/Stockfish-18 \
  --nnue-root ~/Stockfish-17
```

For the single-threaded build, `--stop-test` also checks that infinite
analysis can be stopped:

```bash
node test-wasm.mjs /tmp/chessceo-stockfish-wasm-output/sf_18_lite_st_module.js \
  --nnue-root ~/Stockfish-18 \
  --nnue-root ~/Stockfish-17 \
  --nnue-root public/workers \
  --stop-test
```

The test imports the module in Node, loads the NNUE files it asks for from the
given roots, runs `uci`, `isready` and `go depth 1`, and waits for `bestmove`.
It prints timings for import, instantiate, NNUE load, `uciok`, `readyok` and
the search.
