import type { SourceLanguage } from "../editors"
import {
  COMPILER_GUARD_MS,
  type CompileResult,
  type CompilerWorkerRequest,
  type CompilerWorkerResponse
} from "./protocol"

const COMPILER_LOAD_GUARD_MS = 120_000

export type CompilerState =
  | { state: "loading"; loaded: number; total: number }
  | { state: "ready" }
  | { state: "error"; message: string }

interface PendingCompile {
  id: number
  source: string
  language: SourceLanguage
  resolve: (result: CompileResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface CompilerClientOptions {
  onStateChange: (state: CompilerState) => void
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError")
}

export class CompilerClient {
  private worker: Worker | undefined
  private nextJobId = 1
  private pending: PendingCompile | undefined
  private stopped = false

  constructor(private readonly options: CompilerClientOptions) {
    this.options.onStateChange({ state: "ready" })
  }

  get isWorking(): boolean {
    return this.pending !== undefined
  }

  compile(source: string, language: SourceLanguage): Promise<CompileResult> {
    if (this.stopped) {
      return Promise.reject(new Error("Browser Clang is closed"))
    }
    if (this.pending) {
      return Promise.reject(new Error("Browser Clang is already working"))
    }

    this.options.onStateChange({
      state: "loading",
      loaded: 0,
      total: 0
    })

    const id = this.nextJobId++
    const promise = new Promise<CompileResult>((resolve, reject) => {
      this.pending = {
        id,
        source,
        language,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.fail(
            new Error(
              `Browser Clang did not load after ${COMPILER_LOAD_GUARD_MS / 1000} seconds`
            )
          )
        }, COMPILER_LOAD_GUARD_MS)
      }
    })

    try {
      this.startWorker()
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error("Browser Clang worker could not start")
      )
    }

    return promise
  }

  cancel(): boolean {
    if (!this.pending) return false
    this.finishWithError(abortError("Build stopped"))
    return true
  }

  destroy(): void {
    this.stopped = true
    this.worker?.terminate()
    this.worker = undefined

    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(abortError("Compiler closed"))
      this.pending = undefined
    }
  }

  private startWorker(): void {
    const worker = new Worker(
      new URL("./compiler.worker.ts", import.meta.url),
      {
        type: "module",
        name: "opcode-wasm-clang"
      }
    )
    this.worker = worker

    worker.addEventListener(
      "message",
      (event: MessageEvent<CompilerWorkerResponse>) => {
        if (worker !== this.worker) return
        this.onMessage(event.data)
      }
    )

    worker.addEventListener("error", (event) => {
      if (worker !== this.worker) return
      this.fail(new Error(event.message || "Browser Clang worker stopped"))
    })

    worker.addEventListener("messageerror", () => {
      if (worker !== this.worker) return
      this.fail(new Error("Browser Clang sent an invalid message"))
    })
  }

  private onMessage(message: CompilerWorkerResponse): void {
    if (message.type === "load") {
      this.options.onStateChange({
        state: "loading",
        loaded: message.loaded,
        total: message.total
      })
      return
    }

    if (message.type === "fatal") {
      this.fail(new Error(message.message))
      return
    }

    if (!this.pending) return

    if (message.type === "ready") {
      clearTimeout(this.pending.timer)
      this.pending.timer = setTimeout(() => {
        this.fail(
          new Error(
            `Browser Clang timed out after ${COMPILER_GUARD_MS / 1000} seconds`
          )
        )
      }, COMPILER_GUARD_MS)

      this.worker?.postMessage({
        type: "compile",
        id: this.pending.id,
        source: this.pending.source,
        language: this.pending.language
      } satisfies CompilerWorkerRequest)
      return
    }

    if (message.id !== this.pending.id) return

    const pending = this.pending
    clearTimeout(pending.timer)
    this.pending = undefined
    this.worker?.terminate()
    this.worker = undefined
    this.options.onStateChange({ state: "ready" })
    pending.resolve(message.result)
  }

  private fail(error: Error): void {
    this.finishWithError(error)
    if (!this.stopped) {
      this.options.onStateChange({
        state: "error",
        message: error.message
      })
    }
  }

  private finishWithError(error: Error): void {
    this.worker?.terminate()
    this.worker = undefined

    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = undefined
    }

    if (!this.stopped && error.name === "AbortError") {
      this.options.onStateChange({ state: "ready" })
    }
  }
}
