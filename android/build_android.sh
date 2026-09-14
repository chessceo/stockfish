#!/bin/bash
# Build the custom ARM64 Stockfish shared library for Android.
#
# Produces ONE libstockfish.so containing both the armv8 and armv8-dotprod
# engine builds with runtime CPU dispatch and a single copy of the NNUE net.
#
# Auto-detects toolchain on Linux, WSL, and Windows (Git Bash / MSYS2).
# Override the NDK location by exporting NDK_PATH before invoking.
#
# Usage:
#   cd stockfish_build
#   bash build_android.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/Stockfish/src"

# --- inject FFI wrappers ---
# The Dart side (lib/src/ffi.dart) calls stockfish_init / stockfish_main /
# stockfish_stdin_write / stockfish_stdout_read. The iOS build picks these
# up from packages/stockfish/ios/FlutterStockfish/ffi.cpp via the podspec;
# on Android we stage the same source into Stockfish's src/ and link it into
# libstockfish.so.
FFI_SRC_DIR="$SCRIPT_DIR/../packages/stockfish/ios/FlutterStockfish"
cp "$FFI_SRC_DIR/ffi.h" stockfish_ffi.h
# Rewrite include paths to match the in-src layout.
sed -e 's|../Stockfish/src/||g' -e 's|"ffi.h"|"stockfish_ffi.h"|' \
    "$FFI_SRC_DIR/ffi.cpp" > stockfish_ffi.cpp
# The wrapper must NOT go into SRCS. The universal build compiles the whole
# engine once per sub-architecture, so a wrapper in SRCS would land in every
# per-arch object and collide at the final link. It is compiled once, on its
# own, and added to the final link instead — its call to main() then resolves
# to the dispatcher in universal/entry_arm64.cpp. Undo the old SRCS patch if a
# previous version of this script applied it.
if grep -q '^SRCS_FFI = stockfish_ffi.cpp' Makefile; then
    sed -i \
        -e '/^SRCS_FFI = stockfish_ffi.cpp/d' \
        -e 's|^OBJS = \$(notdir \$(SRCS:.cpp=.o)) \$(SRCS_FFI:.cpp=.o)$|OBJS = $(notdir $(SRCS:.cpp=.o))|' \
        Makefile
fi

# --- teach the universal build to embed the net without #embed ---
# Upstream's universal driver embeds the NNUE net with C++26 `#embed` and weak
# per-arch symbols. The NDK's Clang 19.0.1 implements neither `#embed` nor
# `--embed-dir`, so we swap in the incbin path the normal (non-universal)
# build already uses: one standalone object defines the blob, and every
# per-arch object merely declares it `extern`. Same outcome as upstream's weak
# symbols — exactly one copy of the ~86 MB net in the final library — without
# needing a newer compiler.
python3 - <<'PYEOF'
import re, pathlib

src = pathlib.Path('.')

# 1. Standalone embedding object, incbin instead of #embed.
(src / 'universal' / 'nnue_embed.cpp').write_text(
    '// Standalone NNUE embedding for universal binary builds.\n'
    '//\n'
    '// Patched by stockfish_build/build_android.sh: upstream uses C++26 #embed,\n'
    '// which the NDK toolchain does not support. incbin produces the same single\n'
    '// strong definition of the net that every per-arch object links against.\n'
    '#include "../evaluate.h"\n'
    '\n'
    '#define INCBIN_SILENCE_BITCODE_WARNING\n'
    '#include "../incbin/incbin.h"\n'
    '\n'
    'INCBIN(EmbeddedNNUE, EvalFileDefaultName);\n'
)

# 2. Per-arch builds reference the blob instead of defining their own weak copy.
net = src / 'nnue' / 'network.cpp'
text = net.read_text()
if 'SF_ANDROID_EXTERN_NNUE' not in text:
    old = re.search(
        r'    #define WEAK_SYM __attribute__\(\(weak\)\)\n'
        r'extern const unsigned char gEmbeddedNNUEData\[\] WEAK_SYM = \{\n'
        r'    #embed EvalFileDefaultName\n'
        r'\};\n'
        r'extern const unsigned int gEmbeddedNNUESize WEAK_SYM = sizeof\(gEmbeddedNNUEData\);\n',
        text)
    if not old:
        raise SystemExit('network.cpp: UNIVERSAL_BINARY #embed block not found — '
                         'the Stockfish source changed, re-check this patch')
    text = text.replace(old.group(0),
        '    // SF_ANDROID_EXTERN_NNUE: defined once in universal/nnue_embed.cpp\n'
        '    // (incbin), because the NDK Clang has no #embed. Global variables are\n'
        '    // unmangled under the Itanium ABI, so this matches the incbin symbol.\n'
        'extern "C" const unsigned char gEmbeddedNNUEData[];\n'
        'extern "C" const unsigned int  gEmbeddedNNUESize;\n')
    net.write_text(text)

# 3. Drop --embed-dir from both places the Makefile passes it.
mk = src / 'Makefile'
text = mk.read_text()
text = text.replace('$(CXX) -O2 -Wno-c++26-extensions --embed-dir=$(CURDIR) -c $< -o $@',
                    '$(CXX) -O2 -c $< -o $@')
text = text.replace('arch-cxxflags   = --embed-dir=$(CURDIR) -DStockfish',
                    'arch-cxxflags   = -DStockfish')
mk.write_text(text)
PYEOF

# --- locate NDK toolchain ---
if [ -z "$NDK_PATH" ]; then
    if [ -d "$HOME/Android/Sdk/ndk" ]; then
        # Pick the highest-versioned NDK installed via Android Studio on Linux.
        NDK_PATH="$(ls -1 "$HOME/Android/Sdk/ndk" | sort -V | tail -n1)"
        NDK_PATH="$HOME/Android/Sdk/ndk/$NDK_PATH"
    elif [ -d "/mnt/c/Users/nvanf/AppData/Local/Android/Sdk/ndk/28.2.13676358" ]; then
        # WSL fallback for the original Windows dev box.
        NDK_PATH="/mnt/c/Users/nvanf/AppData/Local/Android/Sdk/ndk/28.2.13676358"
    elif [ -d "C:/Users/nvanf/AppData/Local/Android/Sdk/ndk/28.2.13676358" ]; then
        # Git Bash / MSYS2 fallback.
        NDK_PATH="C:/Users/nvanf/AppData/Local/Android/Sdk/ndk/28.2.13676358"
    fi
fi

# Pick the toolchain prebuilt that matches this host.
case "$(uname -s)" in
    Linux*)   HOST_TAG="linux-x86_64" ;;
    Darwin*)  HOST_TAG="darwin-x86_64" ;;
    MINGW*|MSYS*|CYGWIN*) HOST_TAG="windows-x86_64" ;;
    *) HOST_TAG="linux-x86_64" ;;
esac

TOOLCHAIN="$NDK_PATH/toolchains/llvm/prebuilt/$HOST_TAG/bin"

if [ -z "$NDK_PATH" ] || [ ! -d "$TOOLCHAIN" ]; then
    echo "ERROR: NDK toolchain not found."
    echo "  NDK_PATH=$NDK_PATH"
    echo "  Expected: $TOOLCHAIN"
    echo "Export NDK_PATH to point at your NDK installation and retry."
    exit 1
fi

export PATH="$TOOLCHAIN:$PATH"

# One library, both ISA variants. Upstream's `armv8-universal` target compiles
# the engine once per sub-arch (armv8, armv8-dotprod), links them into a single
# binary, and dispatches at runtime on the kernel's HWCAP_ASIMDDP bit
# (universal/entry_arm64.cpp). Crucially the ~86 MB NNUE net is emitted as a
# weak symbol per arch and overridden by one strong copy from
# universal/nnue_embed.o, so the net is stored ONCE. Building the two arches as
# separate .so files instead doubled the net and cost ~64 MB of download.
#
# Deviations from upstream's driver, all supplied here rather than by patching
# the Makefile (command-line variables win over in-file assignments):
#   * CXX             — ARCH=armv8-universal doesn't match the Makefile's arch
#                       parsing, so the NDK triple is never auto-selected.
#   * OBJCOPY         — the host binutils objcopy is not a given; use the NDK's.
#   * EXTRACXXFLAGS   — -fPIC, propagated to the per-arch sub-makes via MAKEFLAGS.
#   * EXTRALDFLAGS    — the per-arch object we actually consume is the machine
#                       code lld emits during that arch's *link* (--save-temps).
#                       Without -shared -fPIC there, LTO codegen picks the
#                       non-PIC model and the final -shared link dies on
#                       "R_AARCH64_ADR_PREL_PG_HI21 ... recompile with -fPIC".
#   * UNIVERSAL_FINAL_FLAGS — upstream links a static *executable* for Linux;
#                       we need -shared, the NDK C++ runtime, and the 16 KB
#                       max-page-size flags Android 15+/16 KB-page devices
#                       require. The staged FFI object joins the link here.
#
# EXE is deliberately NOT set: it propagates to the sub-makes, where the LTO
# object is looked up as `$(basename $(EXE)).lto.o` while lld actually writes
# `<output>.lto.o` — an EXE with a `.so` suffix breaks that lookup. Build under
# the default name and rename afterwards.
CXX_NDK="aarch64-linux-android29-clang++"
FINAL_FLAGS="-fno-exceptions -Os -shared -fPIC -static-libstdc++ -lm -latomic"
FINAL_FLAGS="$FINAL_FLAGS -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"

echo "========================================"
echo "Building universal ARM64 libstockfish.so"
echo "  arches:    armv8 + armv8-dotprod (runtime dispatch)"
echo "  toolchain: $TOOLCHAIN"
echo "========================================"

make clean
# Compiled on its own so it exists exactly once in the final link.
"$CXX_NDK" -O2 -fPIC -std=c++17 -fno-exceptions -stdlib=libc++ \
    -c stockfish_ffi.cpp -o stockfish_ffi.o

make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" build \
    ARCH=armv8-universal \
    COMP=ndk \
    CXX="$CXX_NDK" \
    OBJCOPY=llvm-objcopy \
    EXTRACXXFLAGS="-fPIC" \
    EXTRALDFLAGS="-shared -fPIC" \
    UNIVERSAL_FINAL_FLAGS="$FINAL_FLAGS $(pwd)/stockfish_ffi.o"

cp stockfish "$SCRIPT_DIR/libstockfish.so"
llvm-strip "$SCRIPT_DIR/libstockfish.so"

echo ""
echo "========================================"
echo "Build complete!"
echo "========================================"
ls -lh "$SCRIPT_DIR/libstockfish.so"

# Fail loudly rather than shipping a library the app cannot use.
for sym in stockfish_init stockfish_main stockfish_stdin_write stockfish_stdout_read; do
    llvm-nm -D "$SCRIPT_DIR/libstockfish.so" | grep -q " T $sym$" \
        || { echo "ERROR: $sym not exported"; exit 1; }
done
echo "FFI symbols: ok"

# --- verify the runtime CPU dispatch under emulation ---
# A phone only ever exercises one of the two branches, and every modern arm64
# phone takes the dotprod one — so the armv8 fallback that exists for pre-2018
# CPUs would otherwise ship completely untested. Relink the same per-arch
# objects as a *static* CLI binary (qemu-user has no Android loader, hence
# -static) and run Stockfish's own bench under two emulated CPUs: one without
# dotprod, one with. Both must report the arch they were dispatched to and
# search the identical node count — the two builds are the same engine, so any
# divergence means the dispatch or the shared net is wrong.
CLI="$SCRIPT_DIR/stockfish_cli_universal"
SRC_DIR="$(pwd)"
"$CXX_NDK" -o "$CLI" \
    "$SRC_DIR/temp_builds/entry_arm64.o" \
    "$SRC_DIR/temp_builds/nnue_embed.o" \
    "$SRC_DIR/temp_builds/armv8/stockfish.o" \
    "$SRC_DIR/temp_builds/armv8-dotprod/stockfish.o" \
    -fno-exceptions -Os -static -static-libstdc++ -lm -latomic

if ! command -v qemu-aarch64 >/dev/null 2>&1; then
    echo ""
    echo "WARNING: qemu-aarch64 not found — CPU dispatch NOT verified."
    echo "         Install it (Arch: sudo pacman -S qemu-user) and re-run to"
    echo "         exercise the non-dotprod fallback path."
else
    echo ""
    echo "--- CPU dispatch check (qemu) ---"
    BENCH_ARGS="16 1 8"          # small hash / 1 thread / depth 8 — emulation is slow
    dispatch_nodes=""
    dispatch_fail=0
    for pair in "cortex-a53:armv8" "max:armv8-dotprod"; do
        cpu="${pair%%:*}"; expect="${pair##*:}"
        # Two invocations on purpose: `compiler` prints which build answered,
        # `bench` proves that build actually searches.
        arch_out="$(qemu-aarch64 -cpu "$cpu" -- "$CLI" compiler 2>&1 || true)"
        out="$(qemu-aarch64 -cpu "$cpu" -- "$CLI" bench $BENCH_ARGS 2>&1 || true)"
        got_arch="$(printf '%s\n' "$arch_out" | sed -n 's/.*Compilation architecture *: *//p' | head -1)"
        got_nodes="$(printf '%s\n' "$out" | sed -n 's/^Nodes searched *: *//p' | head -1)"
        if [ "$got_arch" != "$expect" ] || [ -z "$got_nodes" ]; then
            echo "FAIL  cpu=$cpu expected arch '$expect', got '${got_arch:-<none>}', nodes '${got_nodes:-<none>}'"
            printf '%s\n' "$out" | tail -20
            dispatch_fail=1
        else
            echo "ok    cpu=$cpu -> $got_arch, nodes $got_nodes"
            if [ -z "$dispatch_nodes" ]; then
                dispatch_nodes="$got_nodes"
            elif [ "$dispatch_nodes" != "$got_nodes" ]; then
                echo "FAIL  node counts differ between arches ($dispatch_nodes vs $got_nodes)"
                dispatch_fail=1
            fi
        fi
    done
    [ "$dispatch_fail" = 0 ] || { echo "ERROR: CPU dispatch check failed"; exit 1; }
    echo "CPU dispatch: ok (both branches run, identical search)"
fi

echo ""
echo "Next steps:"
echo "  1. cp libstockfish.so ../packages/stockfish/android/src/main/jniLibs/arm64-v8a/"
echo "  2. Remove any stale libstockfish_dotprod.so from that directory"
echo "  3. Run: flutter clean && flutter run --release"
