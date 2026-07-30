import { Worker } from "node:worker_threads"

import {
  MAX_QUEUED_JOBS,
  WORKER_GUARD_MS,
  type CompileJobMessage,
  type CompileResult,
  type CompilerConfig,
  type CompilerWorkerMessage,
  type SourceLanguage,
} from "./shared"

interface PendingJob {
  id: number
  source: string
  language: SourceLanguage
  resolve: (result: CompileResult) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  pid?: number
}

export class CompilerBusyError extends Error {
  constructor() {
    super("The compile queue is full")
    this.name = "CompilerBusyError"
  }
}

export class CompilerGuardError extends Error {
  constructor() {
    super(`The compiler worker did not finish within ${WORKER_GUARD_MS} ms`)
    this.name = "CompilerGuardError"
  }
}

export class CompilerWorkerError extends Error {
  constructor(message = "The compiler worker stopped") {
    super(message)
    this.name = "CompilerWorkerError"
  }
}

export class CompilerPool {
  private readonly config: CompilerConfig
  private readonly queue: PendingJob[] = []
  private worker: Worker | undefined
  private active: PendingJob | undefined
  private ready = false
  private nextId = 1
  private closed = false

  constructor(config: CompilerConfig) {
    this.config = config
    this.startWorker()
  }

  get isReady(): boolean {
    return this.ready && Boolean(this.worker)
  }

  get queuedJobs(): number {
    return this.queue.length
  }

  compile(source: string, language: SourceLanguage = "c"): Promise<CompileResult> {
    if (this.closed) {
      return Promise.reject(new CompilerWorkerError("The compiler pool is closed"))
    }

    const pendingJobs = this.queue.length + (this.active ? 1 : 0)
    if (pendingJobs >= MAX_QUEUED_JOBS + 1) {
      return Promise.reject(new CompilerBusyError())
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextId,
        source,
        language,
        resolve,
        reject,
      })
      this.nextId += 1
      this.dispatch()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const error = new CompilerWorkerError("The compiler pool is closed")

    if (this.active) {
      clearTimeout(this.active.timer)
      this.active.reject(error)
      this.active = undefined
    }

    for (const job of this.queue.splice(0)) {
      job.reject(error)
    }

    const worker = this.worker
    this.worker = undefined
    this.ready = false
    if (worker) {
      await worker.terminate()
    }
  }

  private startWorker(): void {
    if (this.closed) {
      return
    }

    const worker = new Worker(new URL("./compiler-worker.ts", import.meta.url), {
      workerData: this.config,
    })

    this.worker = worker
    this.ready = false

    worker.on("message", (message: CompilerWorkerMessage) => {
      if (worker !== this.worker) {
        return
      }
      this.onMessage(message)
    })

    worker.on("error", (error: unknown) => {
      if (worker !== this.worker) {
        return
      }
      const message = error instanceof Error ? error.message : "The compiler worker failed"
      this.replaceWorker(new CompilerWorkerError(message))
    })

    worker.on("exit", (code) => {
      if (worker !== this.worker || this.closed) {
        return
      }
      this.replaceWorker(
        new CompilerWorkerError(`The compiler worker exited with code ${code}`),
      )
    })
  }

  private onMessage(message: CompilerWorkerMessage): void {
    if (message.type === "ready") {
      this.ready = true
      this.dispatch()
      return
    }

    if (!this.active || message.id !== this.active.id) {
      return
    }

    if (message.type === "started") {
      this.active.pid = message.pid
      return
    }

    if (message.type === "result") {
      const job = this.active
      clearTimeout(job.timer)
      this.active = undefined
      job.resolve(message.result)
      this.dispatch()
    }
  }

  private dispatch(): void {
    if (!this.ready || !this.worker || this.active || this.closed) {
      return
    }

    const job = this.queue.shift()
    if (!job) {
      return
    }

    this.active = job
    job.timer = setTimeout(() => {
      if (this.active?.id !== job.id) {
        return
      }

      if (job.pid) {
        try {
          process.kill(job.pid, "SIGKILL")
        } catch {
          // The process may have stopped before the guard ran
        }
      }

      this.replaceWorker(new CompilerGuardError())
    }, WORKER_GUARD_MS)

    this.worker.postMessage({
      type: "compile",
      id: job.id,
      source: job.source,
      language: job.language,
    } satisfies CompileJobMessage)
  }

  private replaceWorker(error: Error): void {
    const worker = this.worker
    this.worker = undefined
    this.ready = false

    if (this.active) {
      clearTimeout(this.active.timer)
      this.active.reject(error)
      this.active = undefined
    }

    if (worker) {
      void worker.terminate()
    }

    if (!this.closed) {
      this.startWorker()
    }
  }
}
