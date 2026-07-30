import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import { CompilerPool } from "../server/compiler-pool"
import type {
  CompileResult,
  CompilerConfig,
  SourceLanguage,
} from "../server/shared"
import {
  OPCODE_WASM_BUILD_HEADER,
  OPCODE_WASM_SECTION_NAME,
} from "../server/wasm-metadata"
import { DEFAULT_CPP_SOURCE, DEFAULT_C_SOURCE } from "../src/examples"

const projectRoot = resolve(import.meta.dir, "..")
const csoundSdkPath = resolve(
  projectRoot,
  process.env.CSOUND_WASM_SDK_PATH ?? ".cache/csound-plugin-sdk",
)

function envPath(
  name: "WASI_CC" | "WASI_CXX" | "WASI_CXX_LIB_DIR" | "WASI_LD",
): string {
  const value = process.env[name]
  return value ? resolve(projectRoot, value) : ""
}

const config: CompilerConfig = {
  csoundSdkPath,
  cCompilerPath: envPath("WASI_CC"),
  cppCompilerPath: envPath("WASI_CXX"),
  cppLibraryPath: envPath("WASI_CXX_LIB_DIR"),
  linkerPath: envPath("WASI_LD"),
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

const toolchainAvailable = (
  await Promise.all([
    canAccess(config.cCompilerPath, constants.X_OK),
    canAccess(config.cppCompilerPath, constants.X_OK),
    canAccess(config.cppLibraryPath, constants.R_OK),
    canAccess(config.linkerPath, constants.X_OK),
    canAccess(
      join(config.csoundSdkPath, "include", "csound", "csound.h"),
      constants.R_OK,
    ),
    canAccess(
      join(config.csoundSdkPath, "include", "csound", "csdl.h"),
      constants.R_OK,
    ),
  ])
).every(Boolean)

async function compile(
  source: string,
  language: SourceLanguage = "c",
): Promise<CompileResult> {
  const pool = new CompilerPool(config)
  try {
    return await pool.compile(source, language)
  } finally {
    await pool.close()
  }
}

describe.skipIf(!toolchainAvailable)("CompilerPool with the Nix WASI toolchain", () => {
  test("compiles the default opcode and exports its entry points", async () => {
    const result = await compile(DEFAULT_C_SOURCE)

    expect(result.ok).toBe(true)
    expect(result.wasm).toBeInstanceOf(ArrayBuffer)

    const wasm = result.wasm as ArrayBuffer
    expect(Array.from(new Uint8Array(wasm, 0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d])

    const module = await WebAssembly.compile(wasm)
    const exports = new Set(WebAssembly.Module.exports(module).map((item) => item.name))
    const imports = WebAssembly.Module.imports(module)
    const buildHeaders = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME,
    )

    expect(exports.has("__wasm_call_ctors")).toBe(true)
    expect(exports.has("csound_opcode_init")).toBe(true)
    expect(exports.has("_start")).toBe(false)
    expect(imports.every((item) => item.module === "env")).toBe(true)
    expect(buildHeaders).toHaveLength(1)
    expect(new TextDecoder().decode(buildHeaders[0])).toBe(
      OPCODE_WASM_BUILD_HEADER,
    )
  })

  test("returns the source line for broken C", async () => {
    const validLine = "p->out[index] = p->in[index] * *p->gain;"
    const brokenLine = "p->out[index] = ;"
    const source = DEFAULT_C_SOURCE.replace(validLine, brokenLine)
    const expectedLine =
      source.split("\n").findIndex((line) => line.includes(brokenLine)) + 1

    const result = await compile(source)

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("compile_error")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        file: "plugin.c",
        line: expectedLine,
        severity: "error",
      }),
    )
  })

  test("compiles the default C++ opcode with the C++ driver", async () => {
    const result = await compile(DEFAULT_CPP_SOURCE, "cpp")

    expect(result.ok).toBe(true)
    expect(result.wasm).toBeInstanceOf(ArrayBuffer)

    const module = await WebAssembly.compile(result.wasm as ArrayBuffer)
    const exports = new Set(
      WebAssembly.Module.exports(module).map((item) => item.name),
    )
    const buildHeaders = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME,
    )

    expect(exports.has("__wasm_call_ctors")).toBe(true)
    expect(exports.has("csoundModuleInit")).toBe(true)
    expect(exports.has("_start")).toBe(false)
    expect(buildHeaders).toHaveLength(1)
    expect(new TextDecoder().decode(buildHeaders[0])).toBe(
      OPCODE_WASM_BUILD_HEADER,
    )
  })

  test("returns the source line for broken C++", async () => {
    const validLine = "out[index] = in[index] * gain;"
    const brokenLine = "out[index] = ;"
    const source = DEFAULT_CPP_SOURCE.replace(validLine, brokenLine)
    const expectedLine =
      source.split("\n").findIndex((line) => line.includes(brokenLine)) + 1

    const result = await compile(source, "cpp")

    expect(result.ok).toBe(false)
    expect(result.reason).toBe("compile_error")
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        file: "plugin.cpp",
        line: expectedLine,
        severity: "error",
      }),
    )
  })
})
