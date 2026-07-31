import type { CsoundObj } from "@csound/browser"

export const AUDIO_EXPORT_FILE_NAME = "opcode-wasm-render.wav"

const DEFAULT_STOP_TIMEOUT_MS = 1_500
const DEFAULT_RENDER_TIMEOUT_MS = 120_000
const MAX_RENDER_MESSAGES = 20

export type AudioRenderState =
  | "idle"
  | "loading"
  | "compiling"
  | "rendering"
  | "stopping"
  | "error"

export interface WavInfo {
  channels: number
  sampleRate: number
  bitDepth: number
  durationSeconds: number
}

export interface RenderedAudio extends WavInfo {
  fileName: string
  wav: ArrayBuffer
}

export interface AudioRendererOptions {
  onStateChange?: (state: AudioRenderState, error?: AudioRenderError) => void
  onMessage?: (message: string) => void
  stopTimeoutMs?: number
  renderTimeoutMs?: number
  createCsound?: (options: {
    autoConnect: boolean
    useWorker: boolean
    useSAB: boolean
    withPlugins: object[]
  }) => Promise<CsoundObj | undefined>
}

export type AudioRenderErrorCode =
  | "invalid-plugin"
  | "invalid-csd"
  | "initialize-failed"
  | "compile-failed"
  | "start-failed"
  | "render-failed"
  | "invalid-wav"
  | "stop-failed"

export class AudioRenderError extends Error {
  readonly code: AudioRenderErrorCode
  readonly diagnostics: readonly string[]
  readonly originalError?: unknown

  constructor(
    code: AudioRenderErrorCode,
    message: string,
    options: {
      diagnostics?: readonly string[]
      originalError?: unknown
    } = {}
  ) {
    super(message)
    this.name = "AudioRenderError"
    this.code = code
    this.diagnostics = options.diagnostics ?? []
    this.originalError = options.originalError
  }
}

interface ActiveRender {
  readonly id: number
  readonly csound: CsoundObj
  readonly diagnostics: string[]
  readonly messageListener: (message: unknown) => void
  readonly renderEndedListener: () => void
  readonly realtimeEndedListener: () => void
  started: boolean
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function abortError(): DOMException {
  return new DOMException("Audio render stopped", "AbortError")
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: AudioRenderError
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(timeoutError),
      timeoutMs
    )
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  })
}

function assertPlugin(pluginWasm: ArrayBuffer): void {
  if (pluginWasm.byteLength < 8) {
    throw new AudioRenderError(
      "invalid-plugin",
      "The compiled plugin is empty or too short"
    )
  }

  const magic = new Uint8Array(pluginWasm, 0, 4)
  if (
    magic[0] !== 0x00 ||
    magic[1] !== 0x61 ||
    magic[2] !== 0x73 ||
    magic[3] !== 0x6d
  ) {
    throw new AudioRenderError(
      "invalid-plugin",
      "The compiled plugin is not a WebAssembly module"
    )
  }
}

function tokenizeOptions(value: string): string[] {
  return value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) ?? []
}

function commentOffset(value: string): number {
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\" && quote) {
      escaped = true
      continue
    }
    if (character === "'" || character === "\"") {
      quote = quote === character ? undefined : quote ?? character
      continue
    }
    if (character === ";" && !quote) return index
  }

  return -1
}

function cleanOptionLine(value: string): string {
  const offset = commentOffset(value)
  const optionText = offset < 0 ? value : value.slice(0, offset)
  const comment = offset < 0 ? "" : value.slice(offset).trimStart()
  const tokens = tokenizeOptions(optionText)
  const kept: string[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]

    if (token === "--") {
      kept.push(...tokens.slice(index))
      break
    }

    if (token === "-o" || token === "--output") {
      index += 1
      continue
    }

    if (
      token.startsWith("-o") ||
      token.startsWith("--output=") ||
      token.startsWith("-iadc") ||
      token === "-n" ||
      token === "--nosound" ||
      token === "-A" ||
      token === "-J" ||
      token === "-W"
    ) {
      continue
    }

    kept.push(token)
  }

  const cleaned = kept.join(" ")
  if (!comment) return cleaned
  return cleaned ? `${cleaned} ${comment}` : comment
}

function offlineOptions(value: string, outputFile: string): string {
  const kept = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanOptionLine)
    .join("\n")
    .trim()

  return [`-W -o${outputFile}`, kept].filter(Boolean).join("\n")
}

export function prepareOfflineCsd(
  csdText: string,
  outputFile = AUDIO_EXPORT_FILE_NAME
): string {
  if (!csdText.trim()) {
    throw new AudioRenderError("invalid-csd", "The CSD editor is empty")
  }

  if (!/^[A-Za-z0-9._-]+$/.test(outputFile)) {
    throw new AudioRenderError("invalid-csd", "The audio file name is not safe")
  }

  const optionsPattern = /<CsOptions\b[^>]*>([\s\S]*?)<\/CsOptions>/i
  const match = optionsPattern.exec(csdText)

  if (match) {
    const options = offlineOptions(match[1], outputFile)
    return csdText.replace(
      optionsPattern,
      `<CsOptions>\n${options}\n</CsOptions>`
    )
  }

  const synthesizerPattern = /<CsoundSynthesizer\b[^>]*>/i
  if (!synthesizerPattern.test(csdText)) {
    throw new AudioRenderError(
      "invalid-csd",
      "The CSD needs a CsoundSynthesizer element"
    )
  }

  return csdText.replace(
    synthesizerPattern,
    (opening) => `${opening}\n<CsOptions>\n-W -o${outputFile}\n</CsOptions>`
  )
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  )
}

export function readWavInfo(wav: ArrayBuffer): WavInfo {
  const bytes = new Uint8Array(wav)
  if (
    bytes.byteLength < 44 ||
    chunkName(bytes, 0) !== "RIFF" ||
    chunkName(bytes, 8) !== "WAVE"
  ) {
    throw new AudioRenderError("invalid-wav", "Csound did not make a WAV file")
  }

  const view = new DataView(wav)
  let channels = 0
  let sampleRate = 0
  let byteRate = 0
  let bitDepth = 0
  let dataSize = 0
  let offset = 12

  while (offset + 8 <= bytes.byteLength) {
    const name = chunkName(bytes, offset)
    const size = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8
    if (dataOffset + size > bytes.byteLength) break

    if (name === "fmt " && size >= 16) {
      channels = view.getUint16(dataOffset + 2, true)
      sampleRate = view.getUint32(dataOffset + 4, true)
      byteRate = view.getUint32(dataOffset + 8, true)
      bitDepth = view.getUint16(dataOffset + 14, true)
    }

    if (name === "data") dataSize = size
    offset = dataOffset + size + (size % 2)
  }

  if (!channels || !sampleRate || !byteRate || !bitDepth || !dataSize) {
    throw new AudioRenderError("invalid-wav", "The rendered WAV file is incomplete")
  }

  return {
    channels,
    sampleRate,
    bitDepth,
    durationSeconds: dataSize / byteRate
  }
}

export class CsoundAudioRenderer {
  private readonly onStateChange?: AudioRendererOptions["onStateChange"]
  private readonly onMessage?: AudioRendererOptions["onMessage"]
  private readonly createCsound?: AudioRendererOptions["createCsound"]
  private readonly stopTimeoutMs: number
  private readonly renderTimeoutMs: number
  private readonly terminationTasks = new WeakMap<CsoundObj, Promise<void>>()
  private readonly terminatedInstances = new WeakSet<CsoundObj>()

  private stateValue: AudioRenderState = "idle"
  private renderId = 0
  private currentRender?: ActiveRender
  private pendingInitialization?: Promise<CsoundObj | undefined>
  private cleanupInstance?: CsoundObj
  private currentAbort?: {
    id: number
    reject: (error: DOMException) => void
  }
  private stopTask?: Promise<void>

  constructor(options: AudioRendererOptions = {}) {
    this.onStateChange = options.onStateChange
    this.onMessage = options.onMessage
    this.createCsound = options.createCsound
    this.stopTimeoutMs = Math.max(
      200,
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    )
    this.renderTimeoutMs = Math.max(
      50,
      options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS
    )
  }

  get state(): AudioRenderState {
    return this.stateValue
  }

  get canStop(): boolean {
    return Boolean(
      this.currentRender ||
      this.pendingInitialization ||
      this.cleanupInstance
    )
  }

  async render(pluginWasm: ArrayBuffer, csdText: string): Promise<RenderedAudio> {
    assertPlugin(pluginWasm)
    const renderCsd = prepareOfflineCsd(csdText)
    await this.stop()

    const id = ++this.renderId
    this.setState("loading")
    const pluginUrl = URL.createObjectURL(
      new Blob([pluginWasm], { type: "application/wasm" })
    )
    let pluginUrlReleased = false
    const releasePluginUrl = () => {
      if (pluginUrlReleased) return
      URL.revokeObjectURL(pluginUrl)
      pluginUrlReleased = true
    }
    let rejectAbort!: (error: DOMException) => void
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject
    })
    const diagnostics: string[] = []
    const timeoutError = new AudioRenderError(
      "render-failed",
      `Audio render exceeded ${Math.round(this.renderTimeoutMs / 1_000)} seconds`,
      { diagnostics }
    )
    let renderTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      renderTimeoutId = setTimeout(
        () => reject(timeoutError),
        this.renderTimeoutMs
      )
    })
    const waitFor = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, aborted, timedOut])
    this.currentAbort = { id, reject: rejectAbort }

    let csound: CsoundObj | undefined
    let initialization: Promise<CsoundObj | undefined> | undefined
    let run: ActiveRender | undefined
    let renderFinished = false

    try {
      try {
        const Csound = this.createCsound ??
          (await waitFor(import("@csound/browser"))).default
        if (id !== this.renderId) throw abortError()

        initialization = Csound({
          autoConnect: false,
          useWorker: true,
          useSAB: false,
          withPlugins: [pluginUrl] as unknown as object[]
        })
        this.pendingInitialization = initialization
        initialization.then(
          (instance) => {
            if (this.pendingInitialization === initialization) {
              this.pendingInitialization = undefined
            }
            releasePluginUrl()
            if (instance && (id !== this.renderId || renderFinished)) {
              this.cleanupInstance = instance
              void this.terminate(instance).catch(() => undefined)
            }
          },
          () => {
            if (this.pendingInitialization === initialization) {
              this.pendingInitialization = undefined
            }
            releasePluginUrl()
          }
        )
        csound = await waitFor(initialization)
      } catch (error) {
        if (id !== this.renderId) throw abortError()
        if (error instanceof DOMException && error.name === "AbortError") throw error
        if (error === timeoutError) throw error
        throw new AudioRenderError(
          "initialize-failed",
          `Could not start the audio renderer: ${errorMessage(error)}`,
          { originalError: error }
        )
      }

      if (!csound) {
        throw new AudioRenderError(
          "initialize-failed",
          "Could not start the audio renderer in this browser"
        )
      }
      if (id !== this.renderId) throw abortError()

      let runtimeFailure: string | undefined
      const messageListener = (value: unknown) => {
        const message = String(value)
        runtimeFailure ??= message
          .split(/\r?\n/)
          .find((line) => /\b(?:INIT|PERF) ERROR\b/i.test(line))
          ?.trim()
        diagnostics.push(message)
        if (diagnostics.length > MAX_RENDER_MESSAGES) diagnostics.shift()
        this.emitMessage(message)
      }

      let resolveRender!: () => void
      let rejectRender!: (error: AudioRenderError) => void
      const renderEnded = new Promise<void>((resolve, reject) => {
        resolveRender = resolve
        rejectRender = reject
      })
      const renderEndedListener = () => resolveRender()
      const realtimeEndedListener = () => {
        rejectRender(new AudioRenderError(
          "render-failed",
          "Csound opened a real-time output instead of the WAV file",
          { diagnostics }
        ))
      }

      run = {
        id,
        csound,
        diagnostics,
        messageListener,
        renderEndedListener,
        realtimeEndedListener,
        started: false
      }
      this.currentRender = run
      csound.removeListener("message", console.log)
      csound.on("message", messageListener)
      csound.on("renderEnded", renderEndedListener)
      csound.on("realtimePerformanceEnded", realtimeEndedListener)

      this.setState("compiling")
      let compileResult: number
      try {
        compileResult = await waitFor(csound.compileCSD(renderCsd))
      } catch (error) {
        if (id !== this.renderId) throw abortError()
        if (error === timeoutError) throw error
        throw new AudioRenderError(
          "compile-failed",
          `Could not compile the CSD for export: ${errorMessage(error)}`,
          { diagnostics, originalError: error }
        )
      }

      if (id !== this.renderId) throw abortError()
      if (compileResult !== 0) {
        throw new AudioRenderError(
          "compile-failed",
          `CSD export compile failed with code ${compileResult}`,
          { diagnostics }
        )
      }

      this.setState("rendering")
      let startResult: number
      try {
        startResult = await waitFor(csound.start())
        run.started = true
      } catch (error) {
        if (id !== this.renderId) throw abortError()
        if (error === timeoutError) throw error
        throw new AudioRenderError(
          "start-failed",
          `Could not start the audio render: ${errorMessage(error)}`,
          { diagnostics, originalError: error }
        )
      }

      if (id !== this.renderId) throw abortError()
      if (startResult !== 0) {
        throw new AudioRenderError(
          "start-failed",
          `Csound could not start the audio render with code ${startResult}`,
          { diagnostics }
        )
      }

      await waitFor(renderEnded)
      if (id !== this.renderId) throw abortError()

      try {
        await waitFor(Promise.resolve(csound.reset()))
      } catch (error) {
        if (id !== this.renderId) throw abortError()
        if (error === timeoutError) throw error
        throw new AudioRenderError(
          "render-failed",
          `Could not finish the WAV file: ${errorMessage(error)}`,
          { diagnostics, originalError: error }
        )
      }

      if (runtimeFailure) {
        throw new AudioRenderError(
          "render-failed",
          `Csound audio render failed: ${runtimeFailure.trim()}`,
          {
            diagnostics: [
              runtimeFailure,
              ...diagnostics.filter((message) => message !== runtimeFailure)
            ]
          }
        )
      }

      let rendered: Uint8Array | undefined
      try {
        rendered = await waitFor(csound.fs.readFile(AUDIO_EXPORT_FILE_NAME))
      } catch (error) {
        if (id !== this.renderId) throw abortError()
        if (error === timeoutError) throw error
        throw new AudioRenderError(
          "render-failed",
          `Could not read the rendered WAV file: ${errorMessage(error)}`,
          { diagnostics, originalError: error }
        )
      }

      if (!(rendered instanceof Uint8Array) || rendered.byteLength === 0) {
        throw new AudioRenderError(
          "render-failed",
          "Csound did not leave a rendered WAV file",
          { diagnostics }
        )
      }

      const wav = rendered.slice().buffer
      const info = readWavInfo(wav)
      this.setState("idle")
      return {
        fileName: AUDIO_EXPORT_FILE_NAME,
        wav,
        ...info
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error
      }

      const renderError = error instanceof AudioRenderError
        ? error
        : new AudioRenderError(
            "render-failed",
            `Could not render audio: ${errorMessage(error)}`,
            { originalError: error }
          )
      this.setState("error", renderError)
      throw renderError
    } finally {
      renderFinished = true
      if (renderTimeoutId !== undefined) clearTimeout(renderTimeoutId)
      if (!initialization) releasePluginUrl()
      if (run) this.detachListeners(run)
      if (this.currentRender === run) this.currentRender = undefined
      if (this.currentAbort?.id === id) this.currentAbort = undefined

      if (csound) {
        this.cleanupInstance = csound
        try {
          await withTimeout(
            this.terminate(csound),
            this.stopTimeoutMs,
            new AudioRenderError(
              "stop-failed",
              `Csound did not close the audio renderer within ${this.stopTimeoutMs} ms`
            )
          )
        } catch (error) {
          if (id === this.renderId) {
            const renderError = error instanceof AudioRenderError
              ? error
              : new AudioRenderError(
                  "stop-failed",
                  `Could not close the audio renderer: ${errorMessage(error)}`,
                  { originalError: error }
                )
            this.setState("error", renderError)
            throw renderError
          }
        }
      }

      if (id === this.renderId && this.stateValue !== "error") {
        this.setState("idle")
      }
    }
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    const task = this.stopCurrent()
    this.stopTask = task
    task.finally(() => {
      if (this.stopTask === task) this.stopTask = undefined
    }).catch(() => undefined)
    return task
  }

  private async stopCurrent(): Promise<void> {
    ++this.renderId
    const run = this.currentRender
    const pending = this.pendingInitialization
    const cleanupInstance = this.cleanupInstance
    const abort = this.currentAbort

    abort?.reject(abortError())
    if (this.currentAbort === abort) this.currentAbort = undefined

    if (!run && !pending && !cleanupInstance) {
      this.setState("idle")
      return
    }

    this.setState("stopping")

    if (run?.started) {
      try {
        await withTimeout(
          Promise.resolve(run.csound.stop()).then(() => undefined),
          this.stopTimeoutMs,
          new AudioRenderError(
            "stop-failed",
            `Csound did not stop the audio render within ${this.stopTimeoutMs} ms`
          )
        )
      } catch {
        // Closing the worker below still stops the render
      }
    }

    const instances = new Set<CsoundObj>()
    if (run) instances.add(run.csound)
    if (cleanupInstance) instances.add(cleanupInstance)

    if (pending) {
      try {
        const initialized = await withTimeout(
          pending,
          this.stopTimeoutMs,
          new AudioRenderError(
            "stop-failed",
            `Csound did not finish loading within ${this.stopTimeoutMs} ms`
          )
        )
        if (initialized) {
          this.cleanupInstance = initialized
          instances.add(initialized)
        }
      } catch (error) {
        if (error instanceof AudioRenderError) {
          this.setState("error", error)
          throw error
        }
      }
    }

    if (run) {
      this.detachListeners(run)
      if (this.currentRender === run) this.currentRender = undefined
    }

    const errors: AudioRenderError[] = []
    for (const instance of instances) {
      try {
        await withTimeout(
          this.terminate(instance),
          this.stopTimeoutMs,
          new AudioRenderError(
            "stop-failed",
            `Csound did not close the audio renderer within ${this.stopTimeoutMs} ms`
          )
        )
      } catch (error) {
        errors.push(error instanceof AudioRenderError
          ? error
          : new AudioRenderError(
              "stop-failed",
              `Could not close the audio renderer: ${errorMessage(error)}`,
              { originalError: error }
            ))
      }
    }

    if (errors.length > 0) {
      const renderError = new AudioRenderError(
        "stop-failed",
        errors.map((error) => error.message).join(". "),
        { originalError: errors[0] }
      )
      this.setState("error", renderError)
      throw renderError
    }

    this.setState("idle")
  }

  private terminate(csound: CsoundObj): Promise<void> {
    if (this.terminatedInstances.has(csound)) return Promise.resolve()
    const current = this.terminationTasks.get(csound)
    if (current) return current

    const task = Promise.resolve(csound.terminateInstance()).then(() => undefined)
    this.terminationTasks.set(csound, task)
    task.then(
      () => {
        this.terminatedInstances.add(csound)
        if (this.terminationTasks.get(csound) === task) {
          this.terminationTasks.delete(csound)
        }
        if (this.cleanupInstance === csound) {
          this.cleanupInstance = undefined
        }
      },
      () => {
        if (this.terminationTasks.get(csound) === task) {
          this.terminationTasks.delete(csound)
        }
      }
    )
    return task
  }

  private detachListeners(run: ActiveRender): void {
    run.csound.off("message", run.messageListener)
    run.csound.off("renderEnded", run.renderEndedListener)
    run.csound.off("realtimePerformanceEnded", run.realtimeEndedListener)
  }

  private setState(state: AudioRenderState, error?: AudioRenderError): void {
    this.stateValue = state
    try {
      this.onStateChange?.(state, error)
    } catch (callbackError) {
      console.error("Audio render state callback failed", callbackError)
    }
  }

  private emitMessage(message: string): void {
    try {
      this.onMessage?.(message)
    } catch (callbackError) {
      console.error("Audio render message callback failed", callbackError)
    }
  }
}

export function createCsoundAudioRenderer(
  options: AudioRendererOptions = {}
): CsoundAudioRenderer {
  return new CsoundAudioRenderer(options)
}
