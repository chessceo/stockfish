# Stockfish engine — build & tuning notes

> Mirrored here (from `chessceo_app/stockfish_build/`) as GPL-3.0 source
> availability for the Stockfish build the chess.ceo mobile app embeds — same
> reason `../patches` and `../glue` exist for the web WASM build. This is a
> snapshot, not the live development location: `build_android.sh` still
> expects the app repo's own layout (it references
> `../packages/stockfish/ios/FlutterStockfish/` by relative path) — `glue/`
> here holds a copy of that FFI wrapper source (`ffi.cpp`/`ffi.h`) for
> reference, not a drop-in replacement for running the script standalone.

The app embeds a custom Stockfish build. iOS compiles from source via the
podspec (Xcode); **Android needs a prebuilt `.so` that is NOT in git**
(too large — see `.gitignore`). A fresh checkout has an empty
`packages/stockfish/android/src/main/jniLibs/arm64-v8a/`, so Stockfish won't
load on Android until you build the library locally with the steps below.

## Building the Android library

`build_android.sh` produces **one** arm64 `libstockfish.so` containing *both*
the `armv8` and `armv8-dotprod` engine builds. It selects between them inside
`main()` on the kernel's `HWCAP_ASIMDDP` bit
(`Stockfish/src/universal/entry_arm64.cpp`), so `ffi.dart` just opens
`libstockfish.so` — there is no lib-picking logic on the Dart side any more.

**Why one library:** the NNUE net is ~86 MB and the engine code is ~0.8 MB. The
old two-`.so` layout shipped the same net twice, costing ~64 MB of download for
bytes no device could use. Upstream's `armv8-universal` target exists precisely
to avoid that — the net is emitted once and every per-arch object references it.

The script expects the Stockfish source tree at `stockfish_build/Stockfish/`
(also gitignored). The source already lives in the repo under
`packages/stockfish/ios/Stockfish/` — but **without a Makefile** (Xcode doesn't
need one). So staging is required:

```bash
cd <repo>
cp -r packages/stockfish/ios/Stockfish stockfish_build/Stockfish      # stage source
curl -sL -o stockfish_build/Stockfish/src/Makefile \
  https://raw.githubusercontent.com/official-stockfish/Stockfish/master/src/Makefile
```

Use the Makefile tag that matches the source version. The staged tree is
currently a **dev** build (`src/misc.cpp` says `version = "dev"`) with a single
net, `nn-83a0d6daf7e5.nnue` (90 MB on disk). It needs a Makefile new enough to
have the Section 6 universal driver.

### The PIE→PIC gotcha (required)

Stockfish's `COMP=ndk` profile builds a position-independent **executable**
(`-fPIE`/`-pie`). That is incompatible with linking a `-shared` library and
breaks the LTO codegen (`relocation R_AARCH64_* cannot be used ... recompile
with -fPIC`). Patch the staged Makefile so the ndk profile emits `-fPIC`:

```bash
cd stockfish_build/Stockfish/src
sed -i \
  -e 's|CXXFLAGS += -stdlib=libc++ -fPIE|CXXFLAGS += -stdlib=libc++ -fPIC|' \
  -e 's|LDFLAGS += -static-libstdc++ -pie -lm -latomic|LDFLAGS += -static-libstdc++ -lm -latomic|' \
  Makefile
# also neutralise the "Android 5 PIE" block (OS==Android): -fPIE/-pie → -fPIC
```

The same trap bites a second time in the universal build, in a place that is
easy to miss: the per-arch object the driver consumes is the machine code lld
emits during **that arch's own link** (`--save-temps`). If that link isn't
`-shared -fPIC`, LTO picks the non-PIC model and the final `-shared` link fails
against `libc++_static.a`. `build_android.sh` passes `EXTRALDFLAGS="-shared
-fPIC"` for exactly this reason — don't drop it.

### The `#embed` gotcha (patched automatically)

Upstream's universal driver embeds the net with C++26 `#embed` and weak
per-arch symbols. **The NDK's Clang 19.0.1 implements neither `#embed` nor
`--embed-dir`.** `build_android.sh` therefore rewrites
`universal/nnue_embed.cpp` to use incbin, turns the `UNIVERSAL_BINARY` branch of
`nnue/network.cpp` into plain `extern` declarations, and strips `--embed-dir`
from the Makefile. Net effect is the same as upstream: exactly one copy of the
net, referenced by both arch builds. All three patches are idempotent and run on
every invocation, so a re-staged source tree fixes itself.

The FFI wrapper (`stockfish_ffi.cpp`) is compiled **standalone** and added to
the final link — it must not go into `SRCS`, or every per-arch object would
carry its own copy of `stockfish_init`/`stockfish_main`/… and the final link
would fail on duplicate symbols. Its call to `main()` resolves to the
dispatcher.

Then build + install:

```bash
export NDK_PATH="$HOME/Android/Sdk/ndk/<version>"      # NDK 28.2 verified
cd stockfish_build && bash build_android.sh            # ~40s
cp libstockfish.so ../packages/stockfish/android/src/main/jniLibs/arm64-v8a/
```

The `.so` is ~88 MB — the net is embedded, so analysis works fully offline. The
script already fails the build if the four `stockfish_*` FFI symbols aren't
exported. Worth checking by hand after any change to the build:

```bash
python3 -c "d=open('libstockfish.so','rb').read(); \
  h=open('Stockfish/src/nn-83a0d6daf7e5.nnue','rb').read(64); print('net copies:', d.count(h))"  # must be 1
llvm-nm -D libstockfish.so | grep -E 'T (entry_armv8|_Z19entry_armv8_dotprod)'  # both arches linked in
llvm-objdump -d libstockfish.so | grep -c '\bsdot\b'                            # >0: dotprod code really present
llvm-readelf -lW libstockfish.so | awk '/LOAD/{print $NF}' | sort -u            # 0x4000 for 16KB-page devices
```

### Verifying the CPU dispatch (automatic, needs qemu)

Every modern arm64 phone takes the **dotprod** branch, so device testing never
touches the `armv8` fallback that exists for pre-2018 CPUs. After linking the
`.so`, `build_android.sh` relinks the same per-arch objects as a *static* CLI
binary (`stockfish_cli_universal`, gitignored, ~100 MB — static because
qemu-user has no Android loader) and runs it under two emulated CPUs:

```
ok    cpu=cortex-a53 -> armv8, nodes 159388
ok    cpu=max -> armv8-dotprod, nodes 159388
CPU dispatch: ok (both branches run, identical search)
```

`compiler` reports which build answered; `bench` proves it searches. The node
counts **must match** — both branches are the same engine, so a divergence means
the dispatch or the shared net is wrong. The build fails on mismatch. Without
`qemu-aarch64` installed (Arch: `sudo pacman -S qemu-user`) the check is skipped
with a warning and the fallback path ships untested.

Build an arm64 **CLI executable** for on-device benchmarking the same way, but
keep the stock Makefile (PIE is correct for an executable) and drop `-shared`:
`make build ARCH=armv8-dotprod COMP=ndk EXE=stockfish`.

## Thread cap (`maxThreads`)

`EngineBarState.maxThreads` (`lib/board/engine_bar.dart`) caps the CPU-threads
slider; `MyAppState.setEngineThreads` (`lib/main.dart`) stores it.

- **Staff** (`User.isStaff` — MODERATOR/ADMIN): full `nproc`.
- **Everyone else**: `nproc − 1` (leave a core for OS/UI).
- Always `.clamp(1, 50)`. Degrades sanely on low-core devices (dual-core → 1
  thread for regular users, which is the right call anyway).

### Why not just use all cores? (measured)

Benchmarked on a **Snapdragon 8 Elite Gen 5** (SM8850, all-big Oryon: 2× prime
4.6 GHz + 6× perf 3.6 GHz, no little cores), SF17 dotprod, depth-16 burst /
depth-18 sustained:

- **Scaling is near-linear to 8 threads** — per-thread NPS is flat-to-rising
  (≈560K→680K), no diminishing returns. The big.LITTLE "little cores barely
  help" argument does **not** apply on an all-big SoC.
- **Thermal throttling is the real ceiling, but it's mostly a *charging*
  artifact.** Plugged in, sustained 8-thread NPS decayed ~38% (5.3M→3.3M).
  **Unplugged, it decayed only ~6%** (≈5.0M→4.7M) and stayed 60–72°C (trip is
  95°C). Since people analyze unplugged, 8 threads wins both burst and
  sustained here.
- Going 8→7 threads saves only ~3°C and ~6% NPS: the DVFS governor hands the
  freed power budget to the remaining cores (they clock higher), so "leave a
  core for cooling" buys very little. <!-- 7-vs-8 controlled A/B: see below -->

Caveats: numbers are one flagship; cheaper/older phones throttle harder and have
fewer (sometimes symmetric) cores. Bench is ±5% run-to-run. Sustained windows
were ~2–3 min; a 10-min infinite-analysis soak would heat-soak further.

### 7-vs-8 controlled A/B (same room-cooled baseline)

Three 3-min continuous-load soaks, idle-cooled between (depth-18 back-to-back
benches). Fair pair = 7T and the 8T-repeat, both started at 43°C CPU.

| Phase            | 7 threads | 8 threads (repeat) |
|------------------|-----------|--------------------|
| first ~90s       | ~4.5 M    | ~4.86 M  (8 wins +8%) |
| last ~90s        | ~4.09 M   | ~3.36 M  (7 wins +22%) |
| 3-min avg        | ~4.25 M   | ~3.96 M |
| steady temp      | ~66°C     | ~68°C |

**8 wins the first ~1.5 min; under longer load it throttles below 7 and ends
lower, running ~2°C hotter.** Caveat: the 8-repeat ran *third*, so deeper
chassis/battery heat-soak (invisible to the 43°C CPU sensor) penalised it — the
late crossover is partly that confound. A fridge-cold 8T start peaked 6.26M,
showing what a truly cold die unlocks.

**Takeaway for the cap:** more threads (up to `nproc`) clearly help the common
short/burst case; for marathon analysis 7 vs 8 is roughly a wash. So `nproc−1`
costs little and runs slightly cooler, while full `nproc` buys the burst peak —
which is why staff (opt-in) get it. Lesson for future tests: matching the CPU
temp isn't enough; deep thermal mass (battery/chassis) carries over, so
fridge-cool or fully idle-cool before *each* run.
</content>
</invoke>
