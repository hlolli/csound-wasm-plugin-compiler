import { Exit, commands, type OutputStream, type Tree } from "@yowasp/clang"

import type { SourceLanguage } from "../editors"
import {
  messageDiagnostic,
  parseCompilerDiagnostics,
  sanitizeCompilerOutput
} from "./diagnostics"
import {
  MAX_COMPILER_OUTPUT_BYTES,
  MAX_SOURCE_BYTES,
  MAX_WASM_BYTES,
  type CompileFailureReason,
  type CompileResult
} from "./protocol"
import { CPP_MODLOAD_COMPAT_HEADER } from "./cpp-modload-compat"
import { addOpcodeWasmHeader } from "./wasm-metadata"

const outputName = "plugin.wasm"
const encoder = new TextEncoder()
export const CSOUND_PLUGIN_GLOBAL_BASE = 128 * 1024 * 1024
export const CSOUND_HOST_TABLE_ENTRIES = 3837
export const CSOUND_PLUGIN_TABLE_BASE = 4096

export interface CompilerProgress {
  loaded: number
  total: number
}

export function sourceName(language: SourceLanguage): string {
  return language === "cpp" ? "plugin.cpp" : "plugin.c"
}

export function compileArgs(
  language: SourceLanguage,
  inputName = sourceName(language)
): string[] {
  return [
    "-O2",
    "-fPIC",
    "-fno-exceptions",
    ...(language === "cpp" ? ["-fno-rtti"] : []),
    "-mllvm",
    "-wasm-enable-sjlj",
    "-D__wasi__=1",
    "-D__wasm32__=1",
    "-D_WASI_EMULATED_SIGNAL=1",
    "-D_WASI_EMULATED_MMAN=1",
    "-DUSE_DOUBLE=1",
    "-Iinclude",
    "-Iinclude/csound",
    "-fdiagnostics-color=never",
    "-fmessage-length=0",
    "-ferror-limit=50",
    "-nostartfiles",
    "-Wl,-z,stack-size=131072",
    `-Wl,--global-base=${CSOUND_PLUGIN_GLOBAL_BASE}`,
    `-Wl,--table-base=${CSOUND_PLUGIN_TABLE_BASE}`,
    "-Wl,--no-stack-first",
    "-Wl,--import-table",
    "-Wl,--import-memory",
    "-Wl,--no-entry",
    "-Wl,--export=__wasm_call_ctors",
    "-Wl,--export-if-defined=csound_opcode_init",
    "-Wl,--export-if-defined=csound_fgen_init",
    "-Wl,--export-if-defined=csoundModuleCreate",
    "-Wl,--export-if-defined=csoundModuleInit",
    "-Wl,--export-if-defined=csoundModuleDestroy",
    "-Wl,--export-if-defined=csoundModuleErrorCodeToString",
    "-Wl,--export-if-defined=csoundModuleInfo",
    "-lwasi-emulated-signal",
    "-lwasi-emulated-mman",
    ...(language === "cpp"
      ? ["-lwasi-emulated-getpid", "-lwasi-emulated-process-clocks"]
      : []),
    inputName,
    "-o",
    outputName
  ]
}

export function failedResult(
  reason: CompileFailureReason,
  message: string,
  startedAt: number,
  options: Partial<CompileResult> = {}
): CompileResult {
  return {
    ok: false,
    exitCode: options.exitCode ?? null,
    timedOut: false,
    diagnostics: options.diagnostics ?? [messageDiagnostic(message)],
    output: options.output ?? message,
    durationMs: performance.now() - startedAt,
    reason
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

async function validatePlugin(wasm: ArrayBuffer): Promise<string | null> {
  let module: WebAssembly.Module

  try {
    module = await WebAssembly.compile(wasm)
  } catch {
    return "Clang produced an invalid WebAssembly module"
  }

  const exports = new Set(
    WebAssembly.Module.exports(module).map((item) => item.name)
  )
  if (!exports.has("__wasm_call_ctors")) {
    return "The plugin does not export __wasm_call_ctors"
  }

  if (exports.has("csoundModuleInit")) {
    return [
      "This Csound WASM build cannot run module-entry plugins.",
      "Include <modload.h> so the browser-safe C++ adapter can load it"
    ].join(" ")
  }

  const hasEntry =
    exports.has("csound_opcode_init") ||
    exports.has("csound_fgen_init")

  return hasEntry ? null : "The source does not export a Csound plugin entry point"
}

export async function initializeCompiler(
  onProgress: (progress: CompilerProgress) => void
): Promise<void> {
  await commands.clang(undefined, {}, {
    fetchProgress: ({ totalLength, doneLength }) => {
      onProgress({
        loaded: doneLength,
        total: totalLength
      })
    }
  })
}

export async function compilePlugin(
  source: string,
  language: SourceLanguage,
  csoundHeaders: Tree
): Promise<CompileResult> {
  const startedAt = performance.now()
  const inputName = sourceName(language)

  if (encoder.encode(source).byteLength > MAX_SOURCE_BYTES) {
    return failedResult(
      "source_limit",
      `Source is larger than ${MAX_SOURCE_BYTES} bytes`,
      startedAt
    )
  }

  const includeFiles: Tree = language === "cpp"
    ? {
        csound: {
          ...csoundHeaders,
          "modload.h": CPP_MODLOAD_COMPAT_HEADER
        },
        "modload.h": CPP_MODLOAD_COMPAT_HEADER
      }
    : {
        csound: csoundHeaders
      }

  const files: Tree = {
    [inputName]: source,
    include: includeFiles
  }
  const decoder = new TextDecoder()
  let output = ""
  let outputBytes = 0
  let outputLimitHit = false

  const collect: OutputStream = (bytes) => {
    if (bytes === null) {
      output += decoder.decode()
      return
    }

    if (outputLimitHit) return

    const remaining = MAX_COMPILER_OUTPUT_BYTES - outputBytes
    const kept = bytes.subarray(0, Math.max(remaining, 0))
    output += decoder.decode(kept, { stream: true })
    outputBytes += kept.byteLength
    if (bytes.byteLength > kept.byteLength) outputLimitHit = true
  }

  let resultFiles: Tree | undefined
  let exitCode = 0

  try {
    resultFiles = await commands[language === "cpp" ? "clang++" : "clang"](
      compileArgs(language, inputName),
      files,
      {
        stdout: collect,
        stderr: collect,
        decodeASCII: false
      }
    ) as Tree | undefined
  } catch (error) {
    if (error instanceof Exit) {
      exitCode = error.code
      resultFiles = error.files
    } else {
      const message = error instanceof Error
        ? error.message
        : "Browser Clang could not run"
      return failedResult("tool_error", message, startedAt)
    }
  }

  output += decoder.decode()
  const safeOutput = sanitizeCompilerOutput(output)
  const diagnostics = parseCompilerDiagnostics(safeOutput, inputName)

  if (outputLimitHit) {
    const message = `Compiler output is larger than ${MAX_COMPILER_OUTPUT_BYTES} bytes`
    return failedResult("output_limit", message, startedAt, {
      exitCode,
      diagnostics: diagnostics.length > 0
        ? diagnostics
        : [messageDiagnostic(message)],
      output: safeOutput || message
    })
  }

  if (exitCode !== 0) {
    const message = `Clang exited with code ${exitCode}`
    return failedResult("compile_error", message, startedAt, {
      exitCode,
      diagnostics: diagnostics.length > 0
        ? diagnostics
        : [messageDiagnostic(message)],
      output: safeOutput
    })
  }

  const rawWasm = resultFiles?.[outputName]
  if (!(rawWasm instanceof Uint8Array)) {
    return failedResult(
      "tool_error",
      "Clang did not create plugin.wasm",
      startedAt,
      {
        exitCode,
        diagnostics,
        output: safeOutput
      }
    )
  }

  if (rawWasm.byteLength > MAX_WASM_BYTES) {
    return failedResult(
      "wasm_limit",
      `Plugin is larger than ${MAX_WASM_BYTES} bytes`,
      startedAt,
      {
        exitCode,
        diagnostics,
        output: safeOutput
      }
    )
  }

  const wasm = addOpcodeWasmHeader(exactArrayBuffer(rawWasm), {
    memoryBaseBytes: CSOUND_PLUGIN_GLOBAL_BASE,
    hostTableEntries: CSOUND_HOST_TABLE_ENTRIES
  })
  if (wasm.byteLength > MAX_WASM_BYTES) {
    return failedResult(
      "wasm_limit",
      `Plugin is larger than ${MAX_WASM_BYTES} bytes after adding its build mark`,
      startedAt,
      {
        exitCode,
        diagnostics,
        output: safeOutput
      }
    )
  }

  const validationError = await validatePlugin(wasm)

  if (validationError) {
    return failedResult("invalid_plugin", validationError, startedAt, {
      exitCode,
      diagnostics: [...diagnostics, messageDiagnostic(validationError)],
      output: safeOutput
    })
  }

  return {
    ok: true,
    exitCode,
    timedOut: false,
    diagnostics,
    output: safeOutput,
    durationMs: performance.now() - startedAt,
    wasm
  }
}
