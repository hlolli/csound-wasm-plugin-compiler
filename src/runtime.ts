import type { CsoundObj } from "@csound/browser"

const DEFAULT_STOP_TIMEOUT_MS = 800
const MAX_DIAGNOSTIC_MESSAGES = 12

export type RuntimeState =
  | "idle"
  | "loading"
  | "compiling"
  | "starting"
  | "playing"
  | "stopping"
  | "error"

export type RuntimeErrorCode =
  | "invalid-plugin"
  | "invalid-csd"
  | "initialize-failed"
  | "compile-failed"
  | "start-failed"
  | "stop-failed"
  | "stop-timeout"
  | "terminate-failed"

export type RuntimeStateCallback = (
  state: RuntimeState,
  error?: CsoundRuntimeError
) => void

export type RuntimeMessageCallback = (message: string) => void

export interface CsoundRuntimeOptions {
  onStateChange?: RuntimeStateCallback
  onMessage?: RuntimeMessageCallback
  stopTimeoutMs?: number
}

export class CsoundRuntimeError extends Error {
  readonly code: RuntimeErrorCode
  readonly diagnostics: readonly string[]
  readonly originalError?: unknown

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options: {
      diagnostics?: readonly string[]
      originalError?: unknown
    } = {}
  ) {
    super(message)
    this.name = "CsoundRuntimeError"
    this.code = code
    this.diagnostics = options.diagnostics ?? []
    this.originalError = options.originalError
  }
}

interface ActiveRun {
  readonly id: number
  readonly csound: CsoundObj
  readonly diagnostics: string[]
  readonly messageListener: (message: unknown) => void
  readonly endedListener: () => void
  active: boolean
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: CsoundRuntimeError
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(timeoutError), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

export class CsoundRuntime {
  private readonly onStateChange?: RuntimeStateCallback
  private readonly onMessage?: RuntimeMessageCallback
  private readonly stopTimeoutMs: number
  private readonly terminationTasks = new WeakMap<CsoundObj, Promise<void>>()

  private stateValue: RuntimeState = "idle"
  private stateError?: CsoundRuntimeError
  private runId = 0
  private currentRun?: ActiveRun
  private pendingInitialization?: Promise<CsoundObj | undefined>
  private cleanupInstance?: CsoundObj
  private cleanupTask?: Promise<void>

  constructor(options: CsoundRuntimeOptions = {}) {
    this.onStateChange = options.onStateChange
    this.onMessage = options.onMessage
    this.stopTimeoutMs = Math.max(100, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
  }

  get state(): RuntimeState {
    return this.stateValue
  }

  get isPlaying(): boolean {
    return this.stateValue === "playing"
  }

  get canStop(): boolean {
    return Boolean(
      this.currentRun ||
      this.pendingInitialization ||
      this.cleanupInstance
    )
  }

  async getAudioContextState(): Promise<AudioContextState | "unavailable"> {
    const run = this.currentRun
    if (!run) return "unavailable"

    try {
      const context = await run.csound.getAudioContext()
      return context?.state ?? "unavailable"
    } catch {
      return "unavailable"
    }
  }

  async start(pluginWasm: ArrayBuffer, csdText: string): Promise<void> {
    this.assertPlugin(pluginWasm)
    this.assertCsd(csdText)

    await this.stop()

    const id = ++this.runId
    this.setState("loading")

    const pluginUrl = URL.createObjectURL(
      new Blob([pluginWasm], { type: "application/wasm" })
    )

    let csound: CsoundObj | undefined
    let initialization: Promise<CsoundObj | undefined> | undefined

    try {
      try {
        const { default: Csound } = await import("@csound/browser")

        if (id !== this.runId) {
          return
        }

        initialization = Csound({
          autoConnect: true,
          useWorker: true,
          useSAB: false,
          withPlugins: [pluginUrl] as unknown as object[]
        })
        this.pendingInitialization = initialization

        try {
          csound = await initialization
        } finally {
          if (this.pendingInitialization === initialization) {
            this.pendingInitialization = undefined
          }
        }
      } catch (error) {
        throw new CsoundRuntimeError(
          "initialize-failed",
          `Could not start Csound: ${errorMessage(error)}`,
          { originalError: error }
        )
      } finally {
        URL.revokeObjectURL(pluginUrl)
      }

      if (!csound) {
        throw new CsoundRuntimeError(
          "initialize-failed",
          "Could not start Csound in this browser"
        )
      }

      if (id !== this.runId) {
        await this.cleanupStaleInstance(csound)
        return
      }

      const diagnostics: string[] = []
      const messageListener = (value: unknown) => {
        const message = String(value)
        diagnostics.push(message)

        if (diagnostics.length > MAX_DIAGNOSTIC_MESSAGES) {
          diagnostics.shift()
        }

        this.emitMessage(message)
      }

      let run: ActiveRun
      const endedListener = () => {
        const task = this.finishNaturally(run)
        this.trackCleanup(task)
        void task.catch(() => undefined)
      }

      run = {
        id,
        csound,
        diagnostics,
        messageListener,
        endedListener,
        active: false
      }

      csound.removeListener("message", console.log)
      csound.on("message", messageListener)
      csound.on("realtimePerformanceEnded", endedListener)
      this.currentRun = run

      this.setState("compiling")
      let compileResult: number

      try {
        compileResult = await csound.compileCSD(csdText)
      } catch (error) {
        throw new CsoundRuntimeError(
          "compile-failed",
          `Could not compile the CSD: ${errorMessage(error)}`,
          {
            diagnostics,
            originalError: error
          }
        )
      }

      if (!this.isCurrent(run)) {
        return
      }

      if (compileResult !== 0) {
        throw this.resultError(
          "compile-failed",
          "CSD compilation failed",
          compileResult,
          diagnostics
        )
      }

      this.setState("starting")
      let startResult: number

      try {
        startResult = await csound.start()
      } catch (error) {
        throw new CsoundRuntimeError(
          "start-failed",
          `Could not start audio: ${errorMessage(error)}`,
          {
            diagnostics,
            originalError: error
          }
        )
      }

      if (!this.isCurrent(run)) {
        return
      }

      if (startResult !== 0) {
        throw this.resultError(
          "start-failed",
          "Csound could not start audio",
          startResult,
          diagnostics
        )
      }

      run.active = true
      this.setState("playing")
    } catch (error) {
      if (id !== this.runId) {
        if (csound) {
          await this.cleanupStaleInstance(csound)
        }
        return
      }

      const runtimeError = this.normalizeStartError(error)
      const run = this.currentRun

      if (run?.id === id) {
        this.detachListeners(run)

        try {
          await this.terminateWithTimeout(run.csound)
          if (this.currentRun === run) {
            this.currentRun = undefined
          }
        } catch (cleanupError) {
          const combinedError = new CsoundRuntimeError(
            runtimeError.code,
            `${runtimeError.message}. Cleanup failed: ${errorMessage(cleanupError)}`,
            {
              diagnostics: runtimeError.diagnostics,
              originalError: runtimeError
            }
          )

          this.setState("error", combinedError)
          throw combinedError
        }
      } else if (csound) {
        await this.cleanupStaleInstance(csound)
      }

      this.setState("error", runtimeError)
      throw runtimeError
    }
  }

  stop(): Promise<void> {
    if (this.cleanupTask) {
      return this.cleanupTask
    }

    return this.trackCleanup(this.stopCurrentRun())
  }

  private async stopCurrentRun(): Promise<void> {
    ++this.runId

    const run = this.currentRun
    const pendingInitialization = this.pendingInitialization
    const cleanupInstance = this.cleanupInstance
    const priorState = this.stateValue

    if (!run && !pendingInitialization && !cleanupInstance) {
      this.setState("idle")
      return
    }

    this.setState("stopping")

    let stopError: CsoundRuntimeError | undefined

    if (run) {
      run.csound.off("realtimePerformanceEnded", run.endedListener)

      if (run.active || priorState === "starting") {
        try {
          await withTimeout(
            Promise.resolve(run.csound.stop()).then(() => undefined),
            this.stopTimeoutMs,
            new CsoundRuntimeError(
              "stop-timeout",
              `Csound did not stop within ${this.stopTimeoutMs} ms`
            )
          )
          run.active = false
        } catch (error) {
          stopError =
            error instanceof CsoundRuntimeError
              ? error
              : new CsoundRuntimeError(
                  "stop-failed",
                  `Could not stop Csound: ${errorMessage(error)}`,
                  { originalError: error }
                )
        }
      }

      this.detachListeners(run)
    }

    const instances = new Set<CsoundObj>()
    if (run) instances.add(run.csound)
    if (cleanupInstance) instances.add(cleanupInstance)

    if (pendingInitialization) {
      try {
        const initialized = await withTimeout(
          pendingInitialization,
          this.stopTimeoutMs,
          new CsoundRuntimeError(
            "stop-timeout",
            `Csound did not finish loading within ${this.stopTimeoutMs} ms`
          )
        )
        if (initialized) {
          this.cleanupInstance = initialized
          instances.add(initialized)
        }
      } catch (error) {
        if (error instanceof CsoundRuntimeError && error.code === "stop-timeout") {
          stopError = stopError
            ? new CsoundRuntimeError(
                "stop-timeout",
                `${stopError.message}. ${error.message}`,
                { originalError: error }
              )
            : error
        } else if (this.pendingInitialization === pendingInitialization) {
          this.pendingInitialization = undefined
        }
      }
    }

    const terminationErrors: CsoundRuntimeError[] = []

    for (const instance of instances) {
      try {
        await this.terminateWithTimeout(instance)

        if (this.currentRun?.csound === instance) {
          this.currentRun = undefined
        }
        if (this.cleanupInstance === instance) {
          this.cleanupInstance = undefined
        }
      } catch (error) {
        if (this.currentRun?.csound !== instance) {
          this.cleanupInstance = instance
        }

        terminationErrors.push(
          error instanceof CsoundRuntimeError
            ? error
            : new CsoundRuntimeError(
                "terminate-failed",
                `Could not close Csound: ${errorMessage(error)}`,
                { originalError: error }
              )
        )
      }
    }

    if (terminationErrors.length > 0) {
      const message = [stopError?.message, ...terminationErrors.map((error) => error.message)]
        .filter(Boolean)
        .join(". ")
      const finalError = new CsoundRuntimeError(
        "terminate-failed",
        message,
        { originalError: terminationErrors[0] }
      )
      this.setState("error", finalError)
      throw finalError
    }

    if (stopError) {
      this.setState("error", stopError)
      throw stopError
    }

    this.setState("idle")
  }

  private async finishNaturally(run: ActiveRun): Promise<void> {
    if (!this.isCurrent(run)) {
      return
    }

    ++this.runId
    this.setState("stopping")
    run.active = false
    this.detachListeners(run)

    try {
      await this.terminateWithTimeout(run.csound)
      if (this.currentRun === run) {
        this.currentRun = undefined
      }
      this.setState("idle")
    } catch (error) {
      const runtimeError = new CsoundRuntimeError(
        "terminate-failed",
        `Audio ended but Csound did not close: ${errorMessage(error)}`,
        { originalError: error }
      )

      this.setState("error", runtimeError)
      throw runtimeError
    }
  }

  private terminate(csound: CsoundObj): Promise<void> {
    const existingTask = this.terminationTasks.get(csound)

    if (existingTask) {
      return existingTask
    }

    const task = Promise.resolve()
      .then(() => csound.terminateInstance())
      .then(() => undefined)
    this.terminationTasks.set(csound, task)
    task.then(
      () => {
        if (this.terminationTasks.get(csound) === task) {
          this.terminationTasks.delete(csound)
        }
        this.releaseTerminatedInstance(csound)
      },
      () => {
        if (this.terminationTasks.get(csound) === task) {
          this.terminationTasks.delete(csound)
        }
      }
    )
    return task
  }

  private releaseTerminatedInstance(csound: CsoundObj): void {
    if (this.currentRun?.csound === csound) {
      this.currentRun = undefined
    }
    if (this.cleanupInstance === csound) {
      this.cleanupInstance = undefined
    }

    if (
      this.stateValue !== "error" ||
      this.currentRun ||
      this.pendingInitialization ||
      this.cleanupInstance
    ) {
      return
    }

    if (
      this.stateError?.code === "compile-failed" ||
      this.stateError?.code === "start-failed" ||
      this.stateError?.code === "initialize-failed" ||
      this.stateError?.code === "invalid-plugin" ||
      this.stateError?.code === "invalid-csd"
    ) {
      this.setState("error", this.stateError)
      return
    }

    this.setState("idle")
  }

  private terminateWithTimeout(csound: CsoundObj): Promise<void> {
    return withTimeout(
      this.terminate(csound),
      this.stopTimeoutMs,
      new CsoundRuntimeError(
        "terminate-failed",
        `Csound did not close within ${this.stopTimeoutMs} ms`
      )
    )
  }

  private async cleanupStaleInstance(csound: CsoundObj): Promise<void> {
    this.cleanupInstance = csound

    try {
      await this.terminateWithTimeout(csound)
      if (this.cleanupInstance === csound) {
        this.cleanupInstance = undefined
      }
    } catch {
      return
    }
  }

  private detachListeners(run: ActiveRun): void {
    run.csound.off("realtimePerformanceEnded", run.endedListener)
    run.csound.off("message", run.messageListener)
  }

  private isCurrent(run: ActiveRun): boolean {
    return this.currentRun === run && this.runId === run.id
  }

  private trackCleanup(task: Promise<void>): Promise<void> {
    this.cleanupTask = task

    task.then(
      () => {
        if (this.cleanupTask === task) {
          this.cleanupTask = undefined
        }
      },
      () => {
        if (this.cleanupTask === task) {
          this.cleanupTask = undefined
        }
      }
    )

    return task
  }

  private setState(state: RuntimeState, error?: CsoundRuntimeError): void {
    this.stateValue = state
    this.stateError = state === "error" ? error : undefined

    try {
      this.onStateChange?.(state, error)
    } catch (callbackError) {
      console.error("Runtime state callback failed", callbackError)
    }
  }

  private emitMessage(message: string): void {
    try {
      this.onMessage?.(message)
    } catch (callbackError) {
      console.error("Runtime message callback failed", callbackError)
    }
  }

  private assertPlugin(pluginWasm: ArrayBuffer): void {
    if (pluginWasm.byteLength < 8) {
      throw new CsoundRuntimeError(
        "invalid-plugin",
        "The compiled plugin is empty or too short"
      )
    }

    const magic = new Uint8Array(pluginWasm, 0, 4)
    const isWasm =
      magic[0] === 0x00 &&
      magic[1] === 0x61 &&
      magic[2] === 0x73 &&
      magic[3] === 0x6d

    if (!isWasm) {
      throw new CsoundRuntimeError(
        "invalid-plugin",
        "The compiled plugin is not a WebAssembly module"
      )
    }
  }

  private assertCsd(csdText: string): void {
    if (!csdText.trim()) {
      throw new CsoundRuntimeError("invalid-csd", "The CSD editor is empty")
    }
  }

  private resultError(
    code: "compile-failed" | "start-failed",
    message: string,
    result: number,
    diagnostics: readonly string[]
  ): CsoundRuntimeError {
    const detail = diagnostics
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")

    return new CsoundRuntimeError(
      code,
      detail ? `${message} with code ${result}\n${detail}` : `${message} with code ${result}`,
      { diagnostics: [...diagnostics] }
    )
  }

  private normalizeStartError(error: unknown): CsoundRuntimeError {
    if (error instanceof CsoundRuntimeError) {
      return error
    }

    return new CsoundRuntimeError(
      "initialize-failed",
      `Could not run Csound: ${errorMessage(error)}`,
      { originalError: error }
    )
  }
}

export function createCsoundRuntime(
  options: CsoundRuntimeOptions = {}
): CsoundRuntime {
  return new CsoundRuntime(options)
}
