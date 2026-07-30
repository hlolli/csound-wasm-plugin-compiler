import { parentPort, workerData } from "node:worker_threads"

import { compilePlugin } from "./compile"
import {
  type CompileJobMessage,
  type CompileResult,
  type CompilerConfig,
  type CompilerWorkerMessage,
} from "./shared"
import { messageDiagnostic } from "./diagnostics"

if (!parentPort) {
  throw new Error("Compiler worker needs a parent port")
}

const port = parentPort
const config = workerData as CompilerConfig
let running = false

port.postMessage({ type: "ready" } satisfies CompilerWorkerMessage)

port.on("message", async (message: CompileJobMessage) => {
  if (message.type !== "compile") {
    return
  }

  if (running) {
    const result: CompileResult = {
      ok: false,
      exitCode: null,
      timedOut: false,
      diagnostics: [messageDiagnostic("Compiler worker is already busy")],
      output: "Compiler worker is already busy",
      durationMs: 0,
      reason: "tool_error",
    }
    port.postMessage({
      type: "result",
      id: message.id,
      result,
    } satisfies CompilerWorkerMessage)
    return
  }

  running = true

  try {
    const result = await compilePlugin(message.source, message.language, config, (pid) => {
      port.postMessage({
        type: "started",
        id: message.id,
        pid,
      } satisfies CompilerWorkerMessage)
    })

    const response = {
      type: "result",
      id: message.id,
      result,
    } satisfies CompilerWorkerMessage

    if (result.wasm) {
      port.postMessage(response, [result.wasm])
    } else {
      port.postMessage(response)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Compiler worker failed"
    const result: CompileResult = {
      ok: false,
      exitCode: null,
      timedOut: false,
      diagnostics: [messageDiagnostic(detail)],
      output: detail,
      durationMs: 0,
      reason: "tool_error",
    }

    port.postMessage({
      type: "result",
      id: message.id,
      result,
    } satisfies CompilerWorkerMessage)
  } finally {
    running = false
  }
})
