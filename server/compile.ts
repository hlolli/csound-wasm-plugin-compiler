import { spawn, type ChildProcess } from "node:child_process"
import { Buffer } from "node:buffer"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import {
  CLANG_TIMEOUT_MS,
  MAX_COMPILER_OUTPUT_BYTES,
  MAX_SOURCE_BYTES,
  MAX_WASM_BYTES,
  type CompileFailureReason,
  type CompileResult,
  type CompilerConfig,
  type SourceLanguage,
} from "./shared"
import {
  messageDiagnostic,
  parseCompilerDiagnostics,
  sanitizeCompilerOutput,
} from "./diagnostics"
import { addOpcodeWasmHeader } from "./wasm-metadata"

const outputName = "plugin.wasm"

interface ProcessResult {
  code: number | null
  output: string
  timedOut: boolean
  outputLimitHit: boolean
}

function sourceName(language: SourceLanguage): string {
  return language === "cpp" ? "plugin.cpp" : "plugin.c"
}

function compilerPath(config: CompilerConfig, language: SourceLanguage): string {
  return language === "cpp" ? config.cppCompilerPath : config.cCompilerPath
}

function compileArgs(
  config: CompilerConfig,
  language: SourceLanguage,
  inputName: string,
): string[] {
  return [
    `-fuse-ld=${config.linkerPath}`,
    "-O2",
    "-fPIC",
    "-fno-exceptions",
    ...(language === "cpp"
      ? ["-fno-rtti", `-L${config.cppLibraryPath}`]
      : []),
    "-mllvm",
    "-wasm-enable-sjlj",
    "-D__wasi__=1",
    "-D__wasm32__=1",
    "-D_WASI_EMULATED_SIGNAL=1",
    "-D_WASI_EMULATED_MMAN=1",
    "-DUSE_DOUBLE=1",
    `-I${join(config.csoundSdkPath, "include")}`,
    `-I${join(config.csoundSdkPath, "include", "csound")}`,
    "-fdiagnostics-color=never",
    "-fmessage-length=0",
    "-ferror-limit=50",
    "-nostartfiles",
    "-Wl,-z,stack-size=131072",
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
    outputName,
  ]
}

function runClang(
  config: CompilerConfig,
  language: SourceLanguage,
  inputName: string,
  buildDir: string,
  onSpawn: (pid: number) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    const executable = compilerPath(config, language)

    try {
      child = spawn(executable, compileArgs(config, language, inputName), {
        cwd: buildDir,
        env: {
          HOME: buildDir,
          TMPDIR: buildDir,
          LANG: "C",
          LC_ALL: "C",
          PATH: `${dirname(executable)}:/usr/bin:/bin`,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      reject(error)
      return
    }

    if (typeof child.pid === "number") {
      onSpawn(child.pid)
    }

    const chunks: Buffer[] = []
    let outputBytes = 0
    let outputLimitHit = false
    let timedOut = false
    let settled = false

    const stopChild = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
      }
    }

    const collect = (chunk: Buffer) => {
      if (outputLimitHit) {
        return
      }

      const remaining = MAX_COMPILER_OUTPUT_BYTES - outputBytes
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining)
        chunks.push(kept)
        outputBytes += kept.byteLength
      }

      if (chunk.byteLength > remaining) {
        outputLimitHit = true
        stopChild()
      }
    }

    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)

    const timer = setTimeout(() => {
      timedOut = true
      stopChild()
    }, CLANG_TIMEOUT_MS)

    child.once("error", (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.once("close", (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        output: Buffer.concat(chunks, outputBytes).toString("utf8"),
        timedOut,
        outputLimitHit,
      })
    })
  })
}

function failedResult(
  reason: CompileFailureReason,
  message: string,
  startedAt: number,
  options: Partial<CompileResult> = {},
): CompileResult {
  return {
    ok: false,
    exitCode: options.exitCode ?? null,
    timedOut: options.timedOut ?? false,
    diagnostics: options.diagnostics ?? [messageDiagnostic(message)],
    output: options.output ?? message,
    durationMs: performance.now() - startedAt,
    reason,
  }
}

async function validatePlugin(wasm: ArrayBuffer): Promise<string | null> {
  let module: WebAssembly.Module

  try {
    module = await WebAssembly.compile(wasm)
  } catch {
    return "Clang produced an invalid WebAssembly module"
  }

  const exports = new Set(WebAssembly.Module.exports(module).map((item) => item.name))
  if (!exports.has("__wasm_call_ctors")) {
    return "The plugin does not export __wasm_call_ctors"
  }

  const hasEntry =
    exports.has("csound_opcode_init") ||
    exports.has("csound_fgen_init") ||
    exports.has("csoundModuleCreate")

  if (!hasEntry) {
    return "The source does not export a Csound plugin entry point"
  }

  return null
}

function exactArrayBuffer(bytes: Buffer): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer
  }

  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

export async function compilePlugin(
  source: string,
  language: SourceLanguage,
  config: CompilerConfig,
  onSpawn: (pid: number) => void,
): Promise<CompileResult> {
  const startedAt = performance.now()
  const inputName = sourceName(language)

  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return failedResult(
      "source_limit",
      `Source is larger than ${MAX_SOURCE_BYTES} bytes`,
      startedAt,
    )
  }

  const buildDir = await mkdtemp(join(tmpdir(), "csound-plugin-"))

  try {
    await writeFile(join(buildDir, inputName), source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })

    let processResult: ProcessResult

    try {
      processResult = await runClang(
        config,
        language,
        inputName,
        buildDir,
        onSpawn,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start Clang"
      return failedResult("tool_error", message, startedAt)
    }

    const safeOutput = sanitizeCompilerOutput(processResult.output, buildDir)
    const diagnostics = parseCompilerDiagnostics(
      processResult.output,
      buildDir,
      inputName,
    )

    if (processResult.timedOut) {
      const message = `Clang timed out after ${CLANG_TIMEOUT_MS} ms`
      return failedResult(
        "timeout",
        message,
        startedAt,
        {
          exitCode: processResult.code,
          timedOut: true,
          diagnostics:
            diagnostics.length > 0
              ? diagnostics
              : [messageDiagnostic(message)],
          output: safeOutput || message,
        },
      )
    }

    if (processResult.outputLimitHit) {
      const message = `Compiler output is larger than ${MAX_COMPILER_OUTPUT_BYTES} bytes`
      return failedResult(
        "output_limit",
        message,
        startedAt,
        {
          exitCode: processResult.code,
          diagnostics:
            diagnostics.length > 0
              ? diagnostics
              : [messageDiagnostic(message)],
          output: safeOutput || message,
        },
      )
    }

    if (processResult.code !== 0) {
      const message = `Clang exited with code ${processResult.code ?? "unknown"}`
      return failedResult("compile_error", message, startedAt, {
        exitCode: processResult.code,
        diagnostics: diagnostics.length > 0 ? diagnostics : [messageDiagnostic(message)],
        output: safeOutput,
      })
    }

    let outputStat

    try {
      outputStat = await stat(join(buildDir, outputName))
    } catch {
      return failedResult(
        "tool_error",
        "Clang did not create plugin.wasm",
        startedAt,
        {
          exitCode: processResult.code,
          diagnostics,
          output: safeOutput,
        },
      )
    }

    if (!outputStat.isFile()) {
      return failedResult("tool_error", "Clang output is not a file", startedAt, {
        exitCode: processResult.code,
        diagnostics,
        output: safeOutput,
      })
    }

    if (outputStat.size > MAX_WASM_BYTES) {
      return failedResult(
        "wasm_limit",
        `Plugin is larger than ${MAX_WASM_BYTES} bytes`,
        startedAt,
        {
          exitCode: processResult.code,
          diagnostics,
          output: safeOutput,
        },
      )
    }

    const wasm = addOpcodeWasmHeader(
      exactArrayBuffer(await readFile(join(buildDir, outputName))),
    )

    if (wasm.byteLength > MAX_WASM_BYTES) {
      return failedResult(
        "wasm_limit",
        `Plugin is larger than ${MAX_WASM_BYTES} bytes`,
        startedAt,
        {
          exitCode: processResult.code,
          diagnostics,
          output: safeOutput,
        },
      )
    }

    const validationError = await validatePlugin(wasm)

    if (validationError) {
      return failedResult("invalid_plugin", validationError, startedAt, {
        exitCode: processResult.code,
        diagnostics: [...diagnostics, messageDiagnostic(validationError)],
        output: safeOutput,
      })
    }

    return {
      ok: true,
      exitCode: processResult.code,
      timedOut: false,
      diagnostics,
      output: safeOutput,
      durationMs: performance.now() - startedAt,
      wasm,
    }
  } finally {
    await rm(buildDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    })
  }
}
