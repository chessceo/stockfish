# Stockfish 19

chess.ceo does not build Stockfish 19 itself. It ships the prebuilt modules
from [`@lichess-org/stockfish-web`](https://github.com/lichess-org/stockfish-web)
**0.5.0** (commit `931c33470b0c80756c99dfb05008d951aaa8f751`, GPL-3.0). The
engine source, patch and build scripts are in that repository at that commit.

| Shipped file | From the lichess package | Change |
|---|---|---|
| `sf_19_full_mt_module.wasm` | `sf_19.wasm` | none (sha256 `e8470564155e…`) |
| `sf_19_lite_mt_module.wasm` | `sf_19_smallnet.wasm` | none (sha256 `7e6629d0e122…`) |
| `sf_19_full_mt_module.js` | `sf_19.js` | wasm file name only |
| `sf_19_lite_mt_module.js` | `sf_19_smallnet.js` | wasm file name only |
| `sf_19_full.nnue` | `nn-1a298aa575a0.nnue` | renamed |
| `sf_19_lite.nnue` | `nn-61e7af4bb97d.nnue` | renamed |

The two files here are our own code: classic workers that wrap the lichess
module in the postMessage/UCI protocol the app's other Stockfish workers use.

- `sf_19_full_mt.js`: loads the full module and net
- `sf_19_lite_mt.js`: the same for the smallnet module and net

Each worker queues UCI commands until the module and the net are loaded, then
sends them in order. While the net downloads it posts progress to the page.
