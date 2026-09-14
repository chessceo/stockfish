#include <cstdlib>
#include <iostream>
#include <string>
#include <streambuf>

#include <emscripten.h>

#include "evaluate.h"
#include "nnue/nnue_architecture.h"
#include "position.h"
#include "uci.h"

extern Stockfish::UCIEngine* uci_global;

namespace {

struct MemoryBuffer: public std::streambuf {
    MemoryBuffer(char* buf, size_t sz) { setg(buf, buf, buf + sz); }
};

void load_nnue(char* buf, size_t sz, int index) {
    MemoryBuffer buffer(buf, sz);
    std::istream in(&buffer);

    if (index == 0)
        uci_global->engine.load_big_network(in);
#ifdef EvalFileDefaultNameSmall
    if (index == 1)
        uci_global->engine.load_small_network(in);
#endif

    std::free(buf);
}

}  // namespace

extern "C" {
EMSCRIPTEN_KEEPALIVE void command(const char* utf8) {
    if (uci_global)
        uci_global->command(std::string(utf8));
}

EMSCRIPTEN_KEEPALIVE void uci(const char* utf8) {
    command(utf8);
    std::free((void*) utf8);
}

EMSCRIPTEN_KEEPALIVE void setNnueBuffer(char* buf, size_t sz, int index) {
    if (uci_global)
        load_nnue(buf, sz, index);
    else
        std::free(buf);
}

EMSCRIPTEN_KEEPALIVE const char* getRecommendedNnue(int index) {
#ifdef EvalFileDefaultNameSmall
    if (index == 1)
        return EvalFileDefaultNameSmall;
#endif
    if (index == 0)
    {
#if defined(EvalFileDefaultName)
        return EvalFileDefaultName;
#elif defined(EvalFileDefaultNameBig)
        return EvalFileDefaultNameBig;
#endif
    }
    return "";
}
}
