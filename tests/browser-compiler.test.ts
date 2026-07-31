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
  compilePlugin,
  initializeCompiler
} from "../src/compiler/compile"
import { extractCsoundHeaders } from "../src/compiler/sdk-archive"
import {
  OPCODE_WASM_BUILD_HEADER,
  OPCODE_WASM_SECTION_NAME
} from "../src/compiler/wasm-metadata"
import { DEFAULT_CPP_SOURCE, DEFAULT_C_SOURCE } from "../src/examples"

setDefaultTimeout(30_000)

const projectRoot = resolve(import.meta.dir, "..")
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

describe("browser Clang", () => {
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
    const buildHeaders = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME
    )

    expect(exports.has("__wasm_call_ctors")).toBe(true)
    expect(exports.has("csound_opcode_init")).toBe(true)
    expect(exports.has("_start")).toBe(false)
    expect(imports.every((item) => item.module === "env")).toBe(true)
    expect(buildHeaders).toHaveLength(1)
    expect(new TextDecoder().decode(buildHeaders[0])).toBe(
      OPCODE_WASM_BUILD_HEADER
    )
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
    expect(exports.has("csoundModuleInit")).toBe(true)
    expect(exports.has("_start")).toBe(false)
    expect(buildHeaders).toHaveLength(1)
    expect(new TextDecoder().decode(buildHeaders[0])).toBe(
      OPCODE_WASM_BUILD_HEADER
    )
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
})
