#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const assetManifestPath = path.join(repoRoot, "assets.manifest.json");

const targets = {
  sf17: {
    name: "sf17",
    sourceOption: "sf17Source",
    defaultSource: path.join(os.homedir(), "Stockfish-17"),
    patch: path.join(scriptDir, "patches", "sf17-web.patch"),
    stPatch: path.join(scriptDir, "patches", "sf17-web-st.patch"),
    litePatch: path.join(scriptDir, "patches", "sf17-web-lite.patch"),
    outputBase: "sf_17",
    exportName: "Sf17_Web",
  },
  sf18: {
    name: "sf18",
    sourceOption: "sf18Source",
    defaultSource: path.join(os.homedir(), "Stockfish-18"),
    patch: path.join(scriptDir, "patches", "sf18-web.patch"),
    stPatch: path.join(scriptDir, "patches", "sf18-web-st.patch"),
    litePatch: path.join(scriptDir, "patches", "sf18-web-lite.patch"),
    outputBase: "sf_18",
    exportName: "Sf18_Web",
  },
};

const threadingModes = {
  mt: {
    name: "mt",
    exportSuffix: "",
    threaded: true,
  },
  st: {
    name: "st",
    exportSuffix: "_St",
    threaded: false,
  },
};

const netProfiles = {
  full: {
    name: "full",
    define: "",
    exportSuffix: "_Full",
  },
  lite: {
    name: "lite",
    define: "-DSTOCKFISH_WEB_LITE_NET",
    exportSuffix: "_Lite",
  },
};

const ignoredSources = new Set([
  "glue.cpp",
  "pyffish.cpp",
  "ffishjs.cpp",
  "universal/entry_arm64.cpp",
  "universal/entry_x86.cpp",
  "universal/entry_riscv64.cpp",
  "universal/nnue_embed.cpp",
]);

function usage() {
  console.error(`Usage:
  node scripts/stockfish/build-wasm.mjs [sf17|sf18|all]

Options:
  --sf17-source <path>   default: ~/Stockfish-17
  --sf18-source <path>   default: ~/Stockfish-18
  --output-dir <path>    default: /tmp/chessceo-stockfish-wasm-output
  --build-dir <path>     default: /tmp/chessceo-stockfish-wasm-build
  --jobs <n>             default: CPU count
  --threading <mode>     mt, st, or both; default: mt
  --weight <profile>     full, lite, or both; default: full

The script uses local Emscripten. Set EMSDK_ROOT=/path/to/emsdk when it is not in ~/emsdk.`);
}

function parseArgs(argv) {
  const args = {
    targets: [],
    sf17Source: targets.sf17.defaultSource,
    sf18Source: targets.sf18.defaultSource,
    outputDir: path.join(os.tmpdir(), "chessceo-stockfish-wasm-output"),
    buildDir: path.join(os.tmpdir(), "chessceo-stockfish-wasm-build"),
    jobs: String(Math.max(1, os.availableParallelism?.() ?? os.cpus().length ?? 1)),
    threading: "mt",
    weight: "full",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--sf17-source") {
      args.sf17Source = requireValue(argv, ++i, arg);
    } else if (arg === "--sf18-source") {
      args.sf18Source = requireValue(argv, ++i, arg);
    } else if (arg === "--output-dir") {
      args.outputDir = requireValue(argv, ++i, arg);
    } else if (arg === "--build-dir") {
      args.buildDir = requireValue(argv, ++i, arg);
    } else if (arg === "--jobs") {
      args.jobs = requireValue(argv, ++i, arg);
    } else if (arg === "--threading") {
      args.threading = requireValue(argv, ++i, arg);
    } else if (arg === "--weight") {
      args.weight = requireValue(argv, ++i, arg);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.targets.push(arg);
    }
  }

  if (args.targets.length === 0) {
    args.targets = ["all"];
  }
  if (args.targets.includes("all")) {
    args.targets = ["sf17", "sf18"];
  }
  for (const targetName of args.targets) {
    if (!targets[targetName]) {
      throw new Error(`Unknown target: ${targetName}`);
    }
  }
  if (args.threading !== "mt" && args.threading !== "st" && args.threading !== "both") {
    throw new Error(`Unknown threading mode: ${args.threading}`);
  }
  if (args.weight !== "full" && args.weight !== "lite" && args.weight !== "both") {
    throw new Error(`Unknown weight profile: ${args.weight}`);
  }

  args.outputDir = path.resolve(args.outputDir);
  args.buildDir = path.resolve(args.buildDir);
  args.sf17Source = path.resolve(args.sf17Source);
  args.sf18Source = path.resolve(args.sf18Source);
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
  const env = await emscriptenEnv();
  const workerAssetVersion = await managedAssetGroupVersion("workers");

  await fs.mkdir(args.outputDir, { recursive: true });
  await run("em++", ["--version"], { env });

  for (const targetName of args.targets) {
    const modes = args.threading === "both" ? ["mt", "st"] : [args.threading];
    const weights = args.weight === "both" ? ["full", "lite"] : [args.weight];
    for (const weight of weights) {
      for (const mode of modes) {
        await buildTarget(targets[targetName], netProfiles[weight], threadingModes[mode], args, env, workerAssetVersion);
      }
    }
  }
}

async function buildTarget(target, netProfile, threading, args, env, workerAssetVersion) {
  const sourceDir = args[target.sourceOption];
  const moduleBase = `${target.outputBase}_${netProfile.name}_${threading.name}_module`;
  const workDir = path.join(args.buildDir, `${target.name}-${netProfile.name}-${threading.name}`);
  const outputJs = path.join(args.outputDir, `${moduleBase}.js`);
  const outputWasm = path.join(args.outputDir, `${moduleBase}.wasm`);
  const wrapperName = `${target.outputBase}_${netProfile.name}_${threading.name}.js`;
  const wrapperPath = path.join(args.outputDir, wrapperName);

  if (!existsSync(path.join(sourceDir, "src", "main.cpp"))) {
    throw new Error(`Stockfish source not found: ${sourceDir}`);
  }

  console.log(`# ${target.name} ${netProfile.name} ${threading.name}`);
  console.log(`source: ${sourceDir}`);
  console.log(`build:  ${workDir}`);
  console.log(`output: ${args.outputDir}`);

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(workDir), { recursive: true });
  await copySource(sourceDir, workDir);
  await copyGlue(workDir, threading);
  await run("git", ["apply", "--recount", target.patch], { cwd: workDir });
  if (netProfile.name === "lite") {
    await run("git", ["apply", "--recount", target.litePatch], { cwd: workDir });
  }
  if (!threading.threaded) {
    await run("git", ["apply", "--recount", target.stPatch], { cwd: workDir });
  }

  const sources = await stockfishSources(path.join(workDir, "src"));
  await fs.writeFile(
    path.join(workDir, "Makefile.chessceo-wasm"),
    makefile(target, netProfile, threading, moduleBase, sources),
  );

  await run("make", ["-f", "Makefile.chessceo-wasm", `-j${args.jobs}`], {
    cwd: workDir,
    env,
  });

  await fs.copyFile(path.join(workDir, `${moduleBase}.js`), outputJs);
  await fs.copyFile(path.join(workDir, `${moduleBase}.wasm`), outputWasm);
  await fs.copyFile(path.join(scriptDir, "glue", "sf_nnue_loader.js"), path.join(args.outputDir, "sf_nnue_loader.js"));
  await fs.writeFile(wrapperPath, workerWrapper(moduleBase, threading.threaded, workerAssetVersion));

  console.log(`wrote ${outputJs} (${await humanSize(outputJs)})`);
  console.log(`wrote ${outputWasm} (${await humanSize(outputWasm)})`);
  console.log(`wrote ${wrapperPath} (${await humanSize(wrapperPath)})`);
  console.log("");
}

async function emscriptenEnv() {
  const env = { ...process.env };
  const emsdkRoot = process.env.EMSDK_ROOT || path.join(os.homedir(), "emsdk");
  const pathParts = [];
  const emscriptenBin = path.join(emsdkRoot, "upstream", "emscripten");
  const nodeBin = await firstExistingNodeBin(path.join(emsdkRoot, "node"));

  if (existsSync(emscriptenBin)) {
    pathParts.push(emscriptenBin);
  }
  if (nodeBin) {
    pathParts.push(nodeBin);
  }
  if (!env.EM_CONFIG && existsSync(path.join(emsdkRoot, ".emscripten"))) {
    env.EM_CONFIG = path.join(emsdkRoot, ".emscripten");
  }
  if (!env.EM_CACHE) {
    env.EM_CACHE = path.join(os.tmpdir(), "chessceo-emscripten-cache");
  }
  await fs.mkdir(env.EM_CACHE, { recursive: true });
  env.PATH = [...pathParts, env.PATH || ""].filter(Boolean).join(path.delimiter);
  return env;
}

async function firstExistingNodeBin(nodeRoot) {
  try {
    const entries = await fs.readdir(nodeRoot, { withFileTypes: true });
    const match = entries.find((entry) => entry.isDirectory());
    if (!match) {
      return null;
    }
    const bin = path.join(nodeRoot, match.name, "bin");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

async function copySource(sourceDir, workDir) {
  await fs.cp(sourceDir, workDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== ".git" && !base.endsWith(".nnue");
    },
  });
}

async function copyGlue(workDir, threading) {
  const glueDir = path.join(scriptDir, "glue");
  const glueSource = threading.threaded ? "glue.cpp" : "glue-st.cpp";
  await fs.copyFile(path.join(glueDir, glueSource), path.join(workDir, "src", "glue.cpp"));
  await fs.copyFile(path.join(glueDir, "glue.hpp"), path.join(workDir, "src", "glue.hpp"));
  await fs.mkdir(path.join(workDir, "web"), { recursive: true });
  await fs.copyFile(path.join(glueDir, "initModule.js"), path.join(workDir, "web", "initModule.js"));
}

async function stockfishSources(srcDir) {
  const result = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".cpp")) {
        const rel = slash(path.relative(srcDir, fullPath));
        if (!ignoredSources.has(rel)) {
          result.push(rel);
        }
      }
    }
  }

  await walk(srcDir);
  result.sort();
  return result;
}

function makefile(target, netProfile, threading, moduleBase, sources) {
  const commonDefines = [
    "-DPOSIXALIGNEDALLOC",
    "-DUSE_POPCNT",
    "-DUSE_SSE2",
    "-DUSE_SSSE3",
    "-DUSE_SSE41",
    "-DNO_PREFETCH",
    "-DNNUE_EMBEDDING_OFF",
    "-DNO_TABLEBASES",
    `-DSTOCKFISH_WEB_${target.name.toUpperCase()}`,
  ];
  if (netProfile.define) {
    commonDefines.push(netProfile.define);
  }
  if (threading.threaded) {
    commonDefines.push("-DUSE_SLOPPY_ATOMICS");
  } else {
    commonDefines.push("-DSTOCKFISH_WEB_SINGLE_THREADED", "-D__EMSCRIPTEN_SINGLE_THREADED__");
  }

  const compileThreadFlags = threading.threaded ? " -pthread" : "";
  const memoryFlags = threading.threaded
    ? "-sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH -sSTACK_SIZE=3MB"
    : "-sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=2147483648 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=3MB";
  const linkThreadFlags = threading.threaded
    ? " -sPROXY_TO_PTHREAD -sALLOW_BLOCKING_ON_MAIN_THREAD=0 -Wno-pthreads-mem-growth"
    : " -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=10485760 -Wno-pthreads-mem-growth";
  const exportName = `${target.exportName}${netProfile.exportSuffix}${threading.exportSuffix}`;
  const exportedFunctions = [
    "_malloc",
    "_main",
    "_uci",
    "_setNnueBuffer",
    "_getRecommendedNnue",
  ];
  if (!threading.threaded) {
    exportedFunctions.push("_command", "_isSearching");
  }

  return `
CXX = em++
EXE = ${moduleBase}

CXX_FLAGS = -O3 -DNDEBUG --closure=1 -Isrc${compileThreadFlags} -msimd128 -mavx -flto -fno-exceptions \\
\t${commonDefines.join(" ")}

LD_FLAGS = -sENVIRONMENT=web,worker,node \\
\t--pre-js=web/initModule.js -sEXIT_RUNTIME=0 -sEXPORT_ES6 -sEXPORT_NAME=${exportName} \\
\t-sEXPORTED_FUNCTIONS='[${exportedFunctions.join(",")}]' -sEXPORTED_RUNTIME_METHODS='[stringToUTF8,lengthBytesUTF8,UTF8ToString,HEAPU8,ccall]' \\
\t-sINCOMING_MODULE_JS_API='[locateFile,print,printErr,wasmMemory,buffer,instantiateWasm,mainScriptUrlOrBlob,onExit]' \\
\t${memoryFlags} -sSTRICT${linkThreadFlags}

SRCS = ${sources.join(" ")}
OBJS = $(addprefix src/, $(SRCS:.cpp=.o)) src/glue.o
DEPS = $(OBJS:.o=.d)

$(EXE).js: $(OBJS)
\t$(CXX) $(CXX_FLAGS) $(LD_FLAGS) $(OBJS) -o $(EXE).js

$(OBJS): Makefile.chessceo-wasm

%.o: %.cpp
\t$(CXX) $(CXX_FLAGS) -MMD -MP -c $< -o $@

-include $(DEPS)
`;
}

async function managedAssetGroupVersion(groupId) {
  const manifest = JSON.parse(await fs.readFile(assetManifestPath, "utf8"));
  const group = manifest.groups?.find((candidate) => candidate.id === groupId);
  if (!group?.version) throw new Error(`Missing asset manifest version for ${groupId}`);
  return group.version;
}

function workerWrapper(moduleName, sharedMemory, assetVersion) {
  const loaderUrl = `/workers/sf_nnue_loader.js?v=${encodeURIComponent(assetVersion)}`;
  return `(function () {
  self.STOCKFISH_NNUE_WORKER = {
    module: ${JSON.stringify(`${moduleName}.js`)},
    sharedMemory: ${sharedMemory ? "true" : "false"},
    assetVersion: ${JSON.stringify(assetVersion)},
  };
  importScripts(${JSON.stringify(loaderUrl)});
})();
`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`$ ${[command, ...args].join(" ")}`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}`));
      }
    });
  });
}

async function humanSize(file) {
  const stat = await fs.stat(file);
  if (stat.size < 1024 * 1024) {
    return `${Math.round(stat.size / 1024)} KB`;
  }
  return `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
}

function slash(value) {
  return value.split(path.sep).join("/");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
