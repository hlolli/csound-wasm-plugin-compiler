/// <reference lib="webworker" />

import type { Tree } from "@yowasp/clang"

import {
  compilePlugin,
  failedResult,
  initializeCompiler
} from "./compile"
import type {
  CompilerWorkerRequest,
  CompilerWorkerResponse
} from "./protocol"
import { loadCsoundHeaders } from "./sdk"

const worker = self as DedicatedWorkerGlobalScope
let csoundHeaders: Tree
let busy = false

async function initialize(): Promise<void> {
  csoundHeaders = await loadCsoundHeaders()
  await initializeCompiler(({ loaded, total }) => {
    worker.postMessage({
      type: "load",
      loaded,
      total
    } satisfies CompilerWorkerResponse)
  })
  worker.postMessage({ type: "ready" } satisfies CompilerWorkerResponse)
}

worker.addEventListener("message", (event: MessageEvent<CompilerWorkerRequest>) => {
  if (event.data.type !== "compile") return

  const { id, source, language } = event.data
  if (busy) {
    worker.postMessage({
      type: "result",
      id,
      result: failedResult(
        "tool_error",
        "Browser Clang is already working",
        performance.now()
      )
    } satisfies CompilerWorkerResponse)
    return
  }

  busy = true
  void compilePlugin(source, language, csoundHeaders)
    .then((result) => {
      const message = {
        type: "result",
        id,
        result
      } satisfies CompilerWorkerResponse

      if (result.wasm) {
        worker.postMessage(message, [result.wasm])
      } else {
        worker.postMessage(message)
      }
    })
    .catch((error) => {
      const message = error instanceof Error
        ? error.message
        : "Browser Clang failed"
      worker.postMessage({
        type: "result",
        id,
        result: failedResult("tool_error", message, performance.now())
      } satisfies CompilerWorkerResponse)
    })
    .finally(() => {
      busy = false
    })
})

void initialize().catch((error) => {
  worker.postMessage({
    type: "fatal",
    message: error instanceof Error ? error.message : "Browser Clang could not load"
  } satisfies CompilerWorkerResponse)
})
