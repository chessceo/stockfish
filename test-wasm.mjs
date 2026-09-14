#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

function usage() {
  console.error(`Usage:
  node scripts/stockfish/test-wasm.mjs <path-to-engine-js> [--nnue-root <path> ...]

Example:
  node scripts/stockfish/test-wasm.mjs /tmp/chessceo-stockfish-wasm-output/sf_18_full_mt_module.js --nnue-root ~/Stockfish-18 --nnue-root ~/Stockfish-17 --nnue-root public/workers

Options:
  --stop-test           Also verify go infinite can be stopped.`);
}

function parseArgs(argv) {
  const args = {
    engineJs: "",
    nnueRoots: [],
    timeoutMs: 10000,
    stopTest: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--nnue-root") {
      args.nnueRoots.push(resolveHome(requireValue(argv, ++i, arg)));
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--stop-test") {
      args.stopTest = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!args.engineJs) {
      args.engineJs = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!args.engineJs) {
    usage();
    process.exit(1);
  }

  args.engineJs = path.resolve(resolveHome(args.engineJs));
  if (args.nnueRoots.length === 0) {
    args.nnueRoots.push(path.resolve("public/workers"));
    args.nnueRoots.push(path.join(os.homedir(), "Stockfish-18"));
    args.nnueRoots.push(path.join(os.homedir(), "Stockfish-17"));
  }
  return args;
}

function requireValue(argv, index, option) {
  if (!argv[index]) {
    throw new Error(`${option} needs a value`);
  }
  return argv[index];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engineDir = path.dirname(args.engineJs);
  const lines = [];
  const waiters = [];
  const startedAt = performance.now();

  const moduleUrl = pathToFileURL(args.engineJs).href;
  const createStockfish = (await import(moduleUrl)).default;
  const importedAt = performance.now();
  const stockfish = await createStockfish({
    locateFile: (file) => pathToFileURL(path.join(engineDir, file)).href,
    listen: (line) => {
      lines.push(line);
      console.log(line);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(line, lines)) {
          waiter.done(line);
        }
      }
    },
    onError: (line) => console.error(line),
    onExit: (code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    },
  });
  const instantiatedAt = performance.now();

  for (let index = 0; ; index += 1) {
    const filename = stockfish.getRecommendedNnue(index);
    if (!filename) {
      break;
    }
    const nnuePath = await findNnue(filename, args.nnueRoots);
    const readStartedAt = performance.now();
    const nnueBuffer = await fs.readFile(nnuePath);
    const readCompletedAt = performance.now();
    console.error(`loading NNUE[${index}] ${nnuePath} (${formatBytes(nnueBuffer.byteLength)})`);
    stockfish.setNnueBuffer(nnueBuffer, index);
    const appliedAt = performance.now();
    console.error(
      `timing NNUE[${index}]: read ${formatMs(readCompletedAt - readStartedAt)}, apply ${formatMs(appliedAt - readCompletedAt)}`,
    );
  }
  const nnueCompletedAt = performance.now();

  const uciReady = waitFor(waiters, "uciok", args.timeoutMs, (line) => line === "uciok");
  const uciStartedAt = performance.now();
  stockfish.uci("uci");
  await uciReady;
  const uciCompletedAt = performance.now();

  const ready = waitFor(waiters, "readyok", args.timeoutMs, (line) => line === "readyok");
  const readyStartedAt = performance.now();
  stockfish.uci("isready");
  await ready;
  const readyCompletedAt = performance.now();

  stockfish.uci("position startpos");
  const bestmoveReady = waitFor(
    waiters,
    "bestmove",
    args.timeoutMs,
    (line) => line.startsWith("bestmove "),
  );
  const goStartedAt = performance.now();
  stockfish.uci("go depth 1");
  const bestmove = await bestmoveReady;
  const bestmoveAt = performance.now();

  console.error(`smoke test passed: ${bestmove}`);
  console.error(
    `timing summary: import ${formatMs(importedAt - startedAt)}, instantiate ${formatMs(instantiatedAt - importedAt)}, nnue ${formatMs(nnueCompletedAt - instantiatedAt)}, uciok ${formatMs(uciCompletedAt - uciStartedAt)}, readyok ${formatMs(readyCompletedAt - readyStartedAt)}, depth1 ${formatMs(bestmoveAt - goStartedAt)}, total ${formatMs(bestmoveAt - startedAt)}`,
  );

  if (args.stopTest) {
    stockfish.uci("position startpos");
    const stoppedBestmoveReady = waitFor(
      waiters,
      "bestmove after stop",
      args.timeoutMs,
      (line) => line.startsWith("bestmove "),
    );
    const goResult = stockfish.uci("go infinite");
    setTimeout(() => stockfish.uci("stop"), 100);
    const stoppedBestmove = await stoppedBestmoveReady;
    if (goResult && typeof goResult.then === "function") {
      await goResult;
    }
    console.error(`stop test passed: ${stoppedBestmove}`);
  }

  stockfish.uci("quit");
}

function waitFor(waiters, label, timeoutMs, predicate) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      done: (line) => {
        clearTimeout(timer);
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        resolve(line);
      },
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
      }
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

async function findNnue(filename, roots) {
  for (const root of roots) {
    const direct = path.join(root, filename);
    const src = path.join(root, "src", filename);
    if (existsSync(direct)) {
      return direct;
    }
    if (existsSync(src)) {
      return src;
    }
  }
  throw new Error(`NNUE file not found: ${filename}`);
}

function resolveHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(value) {
  return `${Math.round(value)} ms`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
