import { resolve } from "node:path"

import {
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test
} from "bun:test"
import type { Tree } from "@yowasp/clang"

import {
  CSOUND_HOST_TABLE_ENTRIES,
  CSOUND_PLUGIN_GLOBAL_BASE,
  CSOUND_PLUGIN_TABLE_BASE,
  compilePlugin,
  initializeCompiler
} from "../src/compiler/compile"
import { extractCsoundHeaders } from "../src/compiler/sdk-archive"
import {
  getOpcodeWasmLoaderSize,
  OPCODE_WASM_BUILD_HEADER,
  OPCODE_WASM_SECTION_NAME
} from "../src/compiler/wasm-metadata"
import {
  DEFAULT_CPP_SOURCE,
  DEFAULT_CSD_SOURCE,
  DEFAULT_C_SOURCE
} from "../src/examples"

setDefaultTimeout(30_000)

const projectRoot = resolve(import.meta.dir, "..")
const csoundBrowserEntry = resolve(
  projectRoot,
  "node_modules/@csound/browser/dist/csound.js"
)
const csoundBrowserExport =
  "const Csound = kd; const libcsound = __lcs__; export { Csound, libcsound }; export default Csound;"
let libcsoundFactory: typeof import("@csound/browser").libcsound | undefined
let csoundHeaders: Tree

beforeAll(async () => {
  const compressed = new Uint8Array(
    await Bun.file(
      resolve(
        projectRoot,
        "node_modules/@csound/wasm-bin/lib/csound-plugin-sdk.tar.gz"
      )
    ).arrayBuffer()
  )
  csoundHeaders = extractCsoundHeaders(Bun.gunzipSync(compressed))
  await initializeCompiler(() => {})
})

async function loadLibcsound(): Promise<
  typeof import("@csound/browser").libcsound
> {
  if (libcsoundFactory) return libcsoundFactory

  const source = await Bun.file(csoundBrowserEntry).text()
  if (!source.includes(csoundBrowserExport)) {
    throw new Error("The pinned Csound browser entry has changed")
  }

  const executable = source.replace(
    csoundBrowserExport,
    "return __lcs__;"
  )
  libcsoundFactory = new Function(executable)() as typeof libcsoundFactory
  if (!libcsoundFactory) {
    throw new Error("Could not load the Csound test factory")
  }
  return libcsoundFactory
}

async function runPluginToScoreEnd(wasm: ArrayBuffer): Promise<number> {
  Object.defineProperty(globalThis, "window", {
    value: {
      atob: globalThis.atob.bind(globalThis),
      btoa: globalThis.btoa.bind(globalThis),
      webkitAudioContext: undefined
    },
    configurable: true
  })

  try {
    const libcsound = await loadLibcsound()
    const api = await libcsound({
      withPlugins: [wasm]
    })
    const csound = api.csoundCreate()
    const csd = DEFAULT_CSD_SOURCE.replace("-odac -d -m128", "-n -d -m0")

    try {
      expect(api.csoundCompileCSD(csound, csd)).toBe(0)
      expect(api.csoundStart(csound)).toBe(0)

      let blocks = 0
      let performResult = 0

      while (performResult === 0 && blocks < 10_000) {
        performResult = api.csoundPerformKsmps(csound)
        blocks += 1
      }

      expect(performResult).not.toBe(0)
      return blocks
    } finally {
      api.csoundDestroy(csound)
    }
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
}

describe("browser Clang", () => {
  test("places plugin functions above the pinned Csound table", async () => {
    const hostWasm = await Bun.file(
      resolve(
        projectRoot,
        "node_modules/@csound/wasm-bin/lib/csound.wasm"
      )
    ).arrayBuffer()
    const hostModule = await WebAssembly.compile(hostWasm)
    const tableExport = WebAssembly.Module.exports(hostModule).find(
      (item) => item.kind === "table"
    ) as (WebAssembly.ModuleExportDescriptor & {
      type: { minimum: number }
    }) | undefined

    expect(tableExport?.type.minimum).toBe(CSOUND_HOST_TABLE_ENTRIES)
    expect(CSOUND_PLUGIN_TABLE_BASE).toBeGreaterThan(
      CSOUND_HOST_TABLE_ENTRIES
    )
  })

  test("compiles the default C opcode", async () => {
    const result = await compilePlugin(DEFAULT_C_SOURCE, "c", csoundHeaders)

    expect(result.ok).toBe(true)
    expect(result.wasm).toBeInstanceOf(ArrayBuffer)

    const wasm = result.wasm as ArrayBuffer
    const module = await WebAssembly.compile(wasm)
    const exports = new Set(
      WebAssembly.Module.exports(module).map((item) => item.name)
    )
    const imports = WebAssembly.Module.imports(module)
    const memoryImport = imports.find(
      (item) => item.kind === "memory"
    ) as (WebAssembly.ModuleImportDescriptor & {
      type: { minimum: number }
    }) | undefined
    const tableImport = imports.find(
      (item) => item.kind === "table"
    ) as (WebAssembly.ModuleImportDescriptor & {
      type: { minimum: number }
    }) | undefined
    const buildHeaders = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME
    )

    expect(exports.has("__wasm_call_ctors")).toBe(true)
    expect(exports.has("csound_opcode_init")).toBe(true)
    expect(exports.has("_start")).toBe(false)
    expect(imports.every((item) => item.module === "env")).toBe(true)
    expect(memoryImport?.type.minimum).toBeGreaterThanOrEqual(
      CSOUND_PLUGIN_GLOBAL_BASE / 65_536
    )
    expect(tableImport?.type.minimum).toBeGreaterThan(
      CSOUND_PLUGIN_TABLE_BASE
    )
    expect(buildHeaders).toHaveLength(1)
    expect(new TextDecoder().decode(buildHeaders[0])).toBe(
      OPCODE_WASM_BUILD_HEADER
    )
  })

  test("reserves enough loader memory for large static data", async () => {
    const source = DEFAULT_C_SOURCE.replace(
      "typedef struct {",
      [
        "__attribute__((used))",
        "static unsigned char large_static_data[5 * 1024 * 1024];",
        "",
        "typedef struct {"
      ].join("\n")
    )
    const result = await compilePlugin(source, "c", csoundHeaders)

    expect(result.ok).toBe(true)

    const wasm = result.wasm as ArrayBuffer
    const module = await WebAssembly.compile(wasm)
    const imports = WebAssembly.Module.imports(module)
    const memoryImport = imports.find(
      (item) => item.kind === "memory"
    ) as (WebAssembly.ModuleImportDescriptor & {
      type: { minimum: number }
    }) | undefined
    const loaderSize = getOpcodeWasmLoaderSize(wasm, {
      memoryBaseBytes: CSOUND_PLUGIN_GLOBAL_BASE,
      hostTableEntries: CSOUND_HOST_TABLE_ENTRIES
    })

    expect(loaderSize.memoryBytes).toBe(
      (memoryImport?.type.minimum ?? 0) * 65_536 -
        CSOUND_PLUGIN_GLOBAL_BASE
    )
    expect(loaderSize.memoryBytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(await runPluginToScoreEnd(wasm)).toBeLessThan(10_000)
  })

  test("accepts Csound headers under the csound folder", async () => {
    const source = DEFAULT_C_SOURCE
      .replace('#include "csound.h"', "#include <csound/csound.h>")
      .replace('#include "csdl.h"', "#include <csound/csdl.h>")
    const result = await compilePlugin(source, "c", csoundHeaders)

    expect(result.ok).toBe(true)
    expect(result.wasm).toBeInstanceOf(ArrayBuffer)
  })

  test("returns the source line for broken C", async () => {
    const validLine = "p->out[index] = p->in[index] * *p->gain;"
    const brokenLine = "p->out[index] = ;"
    const source = DEFAULT_C_SOURCE.replace(validLine, brokenLine)
    const expectedLine =
      source.split("\n").findIndex((line) => line.includes(brokenLine)) + 1

    const result = await compilePlugin(source, "c", csoundHeaders)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("compile_error")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        file: "plugin.c",
        line: expectedLine,
        severity: "error"
      })
    )
  })

  test("compiles the default C++ opcode", async () => {
    const result = await compilePlugin(DEFAULT_CPP_SOURCE, "cpp", csoundHeaders)

    expect(result.ok).toBe(true)
    expect(result.wasm).toBeInstanceOf(ArrayBuffer)

    const module = await WebAssembly.compile(result.wasm as ArrayBuffer)
    const exports = new Set(
      WebAssembly.Module.exports(module).map((item) => item.name)
    )
    const buildHeaders = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME
    )

    expect(exports.has("__wasm_call_ctors")).toBe(true)
    expect(exports.has("csound_opcode_init")).toBe(true)
    expect(exports.has("csoundModuleInit")).toBe(false)
    expect(exports.has("_start")).toBe(false)
    expect(buildHeaders).toHaveLength(1)
    expect(new TextDecoder().decode(buildHeaders[0])).toBe(
      OPCODE_WASM_BUILD_HEADER
    )
  })

  test("runs the default C++ opcode to the end of its score", async () => {
    const result = await compilePlugin(DEFAULT_CPP_SOURCE, "cpp", csoundHeaders)

    expect(result.ok).toBe(true)
    expect(
      await runPluginToScoreEnd(result.wasm as ArrayBuffer)
    ).toBeLessThan(10_000)
  })

  test("returns the source line for broken C++", async () => {
    const validLine = "out[index] = in[index] * gain;"
    const brokenLine = "out[index] = ;"
    const source = DEFAULT_CPP_SOURCE.replace(validLine, brokenLine)
    const expectedLine =
      source.split("\n").findIndex((line) => line.includes(brokenLine)) + 1

    const result = await compilePlugin(source, "cpp", csoundHeaders)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("compile_error")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        file: "plugin.cpp",
        line: expectedLine,
        severity: "error"
      })
    )
  })

  test("accepts modload.h under the csound folder", async () => {
    const source = DEFAULT_CPP_SOURCE.replace(
      "#include <modload.h>",
      "#include <csound/modload.h>"
    )
    const result = await compilePlugin(source, "cpp", csoundHeaders)

    expect(result.ok).toBe(true)

    const module = await WebAssembly.compile(result.wasm as ArrayBuffer)
    const exports = new Set(
      WebAssembly.Module.exports(module).map((item) => item.name)
    )

    expect(exports.has("csound_opcode_init")).toBe(true)
    expect(exports.has("csoundModuleInit")).toBe(false)
  })

  test("rejects the unsafe C++ module entry path", async () => {
    const source = `#include <csound/csound.h>

extern "C" int32_t csoundModuleCreate(CSOUND *) {
  return 0;
}

extern "C" int32_t csoundModuleInit(CSOUND *) {
  return 0;
}
`
    const result = await compilePlugin(source, "cpp", csoundHeaders)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("invalid_plugin")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "cannot run module-entry plugins"
        )
      })
    )
  })
})
