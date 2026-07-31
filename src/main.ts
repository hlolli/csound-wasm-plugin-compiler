import "@fontsource/ibm-plex-sans/latin-400.css"
import "@fontsource/ibm-plex-sans/latin-500.css"
import "@fontsource/ibm-plex-sans/latin-700.css"
import "@fontsource/jetbrains-mono/latin-400.css"
import "@fontsource/jetbrains-mono/latin-700.css"

import "./styles.css"

import {
  CompilerClient,
  type CompilerState
} from "./compiler/client"
import type { CompileResult } from "./compiler/protocol"
import {
  createEditors,
  sourceFileName,
  type EditorDiagnostic,
  type SourceLanguage
} from "./editors"
import {
  createCsoundRuntime,
  type CsoundRuntimeError,
  type RuntimeState
} from "./runtime"

type DiagnosticLevel = "error" | "warning" | "note" | "success" | "runtime"

interface UiDiagnostic {
  level: DiagnosticLevel
  message: string
  line?: number | null
  column?: number | null
}

const MAX_VISIBLE_MESSAGES = 160

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing #${id}`)
  }
  return element as T
}

function readableBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function cleanRuntimeLine(line: string): string {
  return line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim()
}

const status = requiredElement<HTMLParagraphElement>("compile-status")
const statusLabel = requiredElement<HTMLSpanElement>("compile-status-label")
const runButton = requiredElement<HTMLButtonElement>("run-button")
const stopButton = requiredElement<HTMLButtonElement>("stop-button")
const exportButton = requiredElement<HTMLButtonElement>("export-button")
const cLanguageButton = requiredElement<HTMLButtonElement>("language-c-button")
const cppLanguageButton = requiredElement<HTMLButtonElement>("language-cpp-button")
const sourceDescription = requiredElement<HTMLParagraphElement>("source-description")
const sourceFile = requiredElement<HTMLElement>("source-file-name")
const cEditorHost = requiredElement<HTMLDivElement>("c-editor")
const csdEditorHost = requiredElement<HTMLDivElement>("csd-editor")
const diagnosticCount = requiredElement<HTMLSpanElement>("diagnostic-count")
const clearButton = requiredElement<HTMLButtonElement>("clear-diagnostics")
const diagnosticOutput = requiredElement<HTMLOListElement>("diagnostics-output")
const compilerState = requiredElement<HTMLSpanElement>("compiler-state")
const audioState = requiredElement<HTMLSpanElement>("audio-state")

let compilerReady = false
let operationRunning = false
let operationId = 0
let messages: UiDiagnostic[] = []
let compiledPlugin: ArrayBuffer | undefined

const levelLabels: Record<DiagnosticLevel, string> = {
  error: "[ERR]",
  warning: "[WARN]",
  note: "[NOTE]",
  success: "[OK]",
  runtime: "[CSOUND]"
}

const editors = createEditors({
  cParent: cEditorHost,
  csdParent: csdEditorHost,
  onRun: () => void run(),
  onSourceChange: () => setCompiledPlugin()
})

const runtime = createCsoundRuntime({
  onStateChange: handleRuntimeState,
  onMessage: handleRuntimeMessage
})

const compiler = new CompilerClient({
  onStateChange: handleCompilerState
})

function setStatus(
  state: "ready" | "working" | "playing" | "error",
  label: string
): void {
  status.dataset.state = state
  statusLabel.textContent = label
}

function setCompiledPlugin(wasm?: ArrayBuffer): void {
  compiledPlugin = wasm
  exportButton.disabled = !compiledPlugin
  exportButton.dataset.state = compiledPlugin ? "idle" : "disabled"
  exportButton.title = compiledPlugin
    ? `Download plugin.wasm · ${readableBytes(compiledPlugin.byteLength)}`
    : "Run a successful build first"
}

function renderSourceLanguage(language: SourceLanguage): void {
  const isC = language === "c"
  cLanguageButton.setAttribute("aria-pressed", String(isC))
  cppLanguageButton.setAttribute("aria-pressed", String(!isC))
  sourceDescription.textContent = isC ? "C opcode code" : "C++ opcode code"
  sourceFile.textContent = sourceFileName(language)
}

function selectSourceLanguage(language: SourceLanguage): void {
  if (operationRunning || editors.getSources().language === language) return

  editors.setLanguage(language)
  editors.setCompilerDiagnostics([])
  setCompiledPlugin()
  renderSourceLanguage(language)
  replaceDiagnostics([], `${sourceFileName(language)} selected`)
}

function updateControls(runState: "idle" | "loading" | "error" | "success" = "idle"): void {
  runButton.disabled = !compilerReady || operationRunning
  stopButton.disabled =
    runtime.state === "stopping" ||
    (!operationRunning && !runtime.canStop)
  runButton.dataset.state = runButton.disabled && !operationRunning
    ? "disabled"
    : runState
  stopButton.dataset.state = runtime.state === "stopping" ? "loading" : "idle"
  exportButton.disabled = !compiledPlugin
  exportButton.dataset.state = compiledPlugin ? "idle" : "disabled"
  cLanguageButton.disabled = operationRunning
  cppLanguageButton.disabled = operationRunning
}

function renderDiagnostics(emptyMessage = "Run to build the plugin and start audio"): void {
  diagnosticOutput.replaceChildren()

  if (messages.length === 0) {
    const item = document.createElement("li")
    item.className = "diagnostic diagnostic--empty"
    item.textContent = emptyMessage
    diagnosticOutput.append(item)
    diagnosticCount.textContent = "0 messages"
    return
  }

  const fragment = document.createDocumentFragment()

  for (const message of messages) {
    const item = document.createElement("li")
    item.className = "diagnostic"
    item.dataset.level = message.level

    const level = document.createElement("span")
    level.className = "diagnostic__level"
    level.textContent = levelLabels[message.level]
    item.append(level)

    if (message.line) {
      const location = document.createElement("button")
      location.className = "diagnostic__location"
      location.type = "button"
      location.textContent = message.column
        ? `${message.line}:${message.column}`
        : String(message.line)
      location.setAttribute(
        "aria-label",
        `Go to ${sourceFileName(editors.getSources().language)} line ${message.line}${message.column ? ` column ${message.column}` : ""}`
      )
      location.addEventListener("click", () => {
        editors.focusSourceLine(message.line ?? 1, message.column)
      })
      item.append(location)
    } else {
      const spacer = document.createElement("span")
      spacer.className = "diagnostic__location-space"
      spacer.setAttribute("aria-hidden", "true")
      item.append(spacer)
    }

    const detail = document.createElement("span")
    detail.className = "diagnostic__message"
    detail.textContent = message.message
    item.append(detail)
    fragment.append(item)
  }

  diagnosticOutput.append(fragment)
  diagnosticCount.textContent = `${messages.length} ${messages.length === 1 ? "message" : "messages"}`
}

function replaceDiagnostics(nextMessages: UiDiagnostic[], emptyMessage?: string): void {
  messages = nextMessages.slice(-MAX_VISIBLE_MESSAGES)
  renderDiagnostics(emptyMessage)
}

function addDiagnostic(message: UiDiagnostic): void {
  messages.push(message)
  if (messages.length > MAX_VISIBLE_MESSAGES) {
    messages = messages.slice(-MAX_VISIBLE_MESSAGES)
  }
  renderDiagnostics()
  diagnosticOutput.scrollTop = diagnosticOutput.scrollHeight
}

function compilerMessage(
  diagnostic: EditorDiagnostic,
  inputName: string
): UiDiagnostic {
  const level: DiagnosticLevel =
    diagnostic.severity === "warning"
      ? "warning"
      : diagnostic.severity === "note"
        ? "note"
        : "error"

  return {
    level,
    message: diagnostic.message,
    line: diagnostic.file === inputName ? diagnostic.line : null,
    column: diagnostic.file === inputName ? diagnostic.column : null
  }
}

function sourceMatches(
  left: ReturnType<typeof editors.getSources>,
  right: ReturnType<typeof editors.getSources>
): boolean {
  return left.language === right.language && left.source === right.source
}

function finishChangedRun(message: string): void {
  operationRunning = false
  compilerState.textContent = "Compiler ready"
  addDiagnostic({
    level: "warning",
    message
  })
  setStatus(
    runtime.isPlaying ? "playing" : "ready",
    runtime.isPlaying ? "Playing" : "Ready"
  )
  updateControls(runtime.isPlaying ? "success" : "idle")
}

async function compileSource(
  source: string,
  language: SourceLanguage
): Promise<CompileResult> {
  return compiler.compile(source, language)
}

function runtimeLabel(state: RuntimeState): string {
  switch (state) {
    case "loading":
      return "Audio loading"
    case "compiling":
      return "CSD compiling"
    case "starting":
      return "Audio starting"
    case "playing":
      return "Audio playing"
    case "stopping":
      return "Audio stopping"
    case "error":
      return "Audio error"
    default:
      return "Audio idle"
  }
}

function handleRuntimeState(state: RuntimeState, error?: CsoundRuntimeError): void {
  audioState.textContent = runtimeLabel(state)

  if (operationRunning) {
    if (state === "loading") setStatus("working", "Loading Csound")
    if (state === "compiling") setStatus("working", "Compiling CSD")
    if (state === "starting") setStatus("working", "Starting audio")
    updateControls("loading")
    return
  }

  if (state === "playing") {
    setStatus("playing", "Playing")
    updateControls("success")
    return
  }

  if (state === "error") {
    setStatus("error", error?.message ?? "Csound failed")
    updateControls("error")
    return
  }

  if (state === "idle" && compilerReady) {
    setStatus("ready", "Ready")
  }
  updateControls()
}

function handleCompilerState(state: CompilerState): void {
  if (state.state === "loading") {
    compilerReady = false
    const percent = state.total > 0
      ? Math.min(100, Math.round(state.loaded / state.total * 100))
      : 0
    compilerState.textContent = state.total > 0
      ? `Compiler loading · ${percent}%`
      : "Compiler loading"
    if (operationRunning) {
      setStatus(
        "working",
        state.total > 0 ? `Loading Clang · ${percent}%` : "Loading Clang"
      )
    } else if (runtime.state === "idle") {
      setStatus("working", state.total > 0 ? `Loading compiler · ${percent}%` : "Loading compiler")
    }
    updateControls("loading")
    return
  }

  if (state.state === "error") {
    compilerReady = true
    compilerState.textContent = "Compiler error"
    if (!operationRunning) setStatus("error", state.message)
    updateControls("error")
    return
  }

  compilerReady = true
  compilerState.textContent = "Compiler ready"
  if (!operationRunning) {
    setStatus(runtime.isPlaying ? "playing" : "ready", runtime.isPlaying ? "Playing" : "Ready")
  }
  updateControls(runtime.isPlaying ? "success" : "idle")
}

function handleRuntimeMessage(rawMessage: string): void {
  const lines = rawMessage
    .split(/\r?\n/)
    .map(cleanRuntimeLine)
    .filter(Boolean)

  for (const line of lines) {
    addDiagnostic({
      level: "runtime",
      message: line
    })
  }
}

async function run(): Promise<void> {
  if (!compilerReady || operationRunning) return

  const currentId = ++operationId
  const sources = editors.getSources()
  const inputName = sourceFileName(sources.language)
  let pluginBuilt = false
  setCompiledPlugin()
  operationRunning = true
  editors.setCompilerDiagnostics([])
  replaceDiagnostics([], `Building ${inputName}`)
  compilerState.textContent = "Compiler working"
  setStatus("working", "Compiling plugin")
  updateControls("loading")

  try {
    const result = await compileSource(sources.source, sources.language)
    if (currentId !== operationId) return

    const currentSources = editors.getSources()
    if (!sourceMatches(currentSources, sources)) {
      editors.setCompilerDiagnostics([])
      replaceDiagnostics([], `Built ${inputName}, but the source changed`)
      finishChangedRun("Source changed during the build. Run again.")
      return
    }

    editors.setCompilerDiagnostics(result.diagnostics)
    const compilerDiagnostics = result.diagnostics.map((diagnostic) =>
      compilerMessage(diagnostic, inputName)
    )

    if (!result.ok || !result.wasm) {
      const fallback = result.output.trim() || "Clang did not build the plugin"
      const nextMessages = compilerDiagnostics.length > 0
        ? compilerDiagnostics
        : [{ level: "error" as const, message: fallback }]

      replaceDiagnostics(nextMessages)
      compilerState.textContent = "Compiler error"
      const priorAudio = runtime.isPlaying ? " Prior audio is still playing" : ""
      setStatus("error", `Build failed.${priorAudio}`)
      operationRunning = false
      updateControls("error")
      return
    }

    replaceDiagnostics([
      ...compilerDiagnostics,
      {
        level: "success",
        message: `Built plugin.wasm from ${inputName} in ${Math.round(result.durationMs)} ms · ${readableBytes(result.wasm.byteLength)}`
      }
    ])
    pluginBuilt = true
    setCompiledPlugin(result.wasm)
    compilerState.textContent = `Compiler ready · ${Math.round(result.durationMs)} ms`

    if (currentSources.csd !== sources.csd) {
      finishChangedRun("CSD changed during the build. Run again.")
      return
    }

    setStatus("working", "Replacing Csound")

    await runtime.start(result.wasm, sources.csd)
    if (currentId !== operationId) return

    const sourcesAfterStart = editors.getSources()
    if (
      !sourceMatches(sourcesAfterStart, sources) ||
      sourcesAfterStart.csd !== sources.csd
    ) {
      await runtime.stop()
      if (currentId !== operationId) return
      finishChangedRun("Code changed while Csound started. Run again.")
      return
    }

    operationRunning = false
    if (runtime.isPlaying) {
      setStatus("playing", "Playing")
      updateControls("success")
    } else {
      setStatus("ready", "Ready")
      updateControls()
    }
  } catch (error) {
    if (currentId !== operationId || (error instanceof DOMException && error.name === "AbortError")) {
      return
    }

    operationRunning = false
    compilerState.textContent = pluginBuilt ? "Compiler ready" : "Compiler error"
    const message = errorText(error)

    if (!messages.some((item) => item.level === "error" && item.message === message)) {
      addDiagnostic({
        level: "error",
        message
      })
    }

    setStatus("error", message)
    updateControls("error")
  }
}

function exportPlugin(): void {
  if (!compiledPlugin) return

  const url = URL.createObjectURL(
    new Blob([compiledPlugin], { type: "application/wasm" })
  )
  const link = document.createElement("a")
  link.href = url
  link.download = "plugin.wasm"
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)

  addDiagnostic({
    level: "success",
    message: `Exported plugin.wasm · ${readableBytes(compiledPlugin.byteLength)} · OPCODE.WASM`
  })
}

async function stop(): Promise<void> {
  const currentId = ++operationId
  compiler.cancel()
  operationRunning = true
  setStatus("working", "Stopping")
  updateControls("loading")

  try {
    await runtime.stop()
    if (currentId !== operationId) return
    setStatus(compilerReady ? "ready" : "working", compilerReady ? "Ready" : "Loading compiler")
  } catch (error) {
    if (currentId !== operationId) return
    const message = errorText(error)
    addDiagnostic({
      level: "error",
      message
    })
    setStatus("error", message)
  } finally {
    if (currentId === operationId) {
      operationRunning = false
      updateControls()
    }
  }
}

runButton.addEventListener("click", () => void run())
stopButton.addEventListener("click", () => void stop())
exportButton.addEventListener("click", exportPlugin)
cLanguageButton.addEventListener("click", () => selectSourceLanguage("c"))
cppLanguageButton.addEventListener("click", () => selectSourceLanguage("cpp"))
clearButton.addEventListener("click", () => {
  editors.setCompilerDiagnostics([])
  replaceDiagnostics([], "No messages")
})

window.addEventListener("beforeunload", () => {
  compiler.destroy()
  editors.destroy()
  void runtime.stop()
})

renderSourceLanguage(editors.getSources().language)
renderDiagnostics()
updateControls()
