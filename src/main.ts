import "@fontsource/ibm-plex-sans/latin-400.css"
import "@fontsource/ibm-plex-sans/latin-500.css"
import "@fontsource/ibm-plex-sans/latin-700.css"
import "@fontsource/jetbrains-mono/latin-400.css"
import "@fontsource/jetbrains-mono/latin-700.css"

import "./styles.css"

import {
  createCsoundAudioRenderer,
  type AudioRenderError,
  type AudioRenderState,
  type RenderedAudio
} from "./audio-render"
import {
  CompilerClient,
  type CompilerState
} from "./compiler/client"
import type { CompileResult } from "./compiler/protocol"
import {
  createEditors,
  sourceFileName,
  type EditorDiagnostic,
  type EditorWorkspacePatch,
  type SourceLanguage
} from "./editors"
import { ACTIVE_DEMO, ACTIVE_DEMO_WORKSPACE, DEMOS } from "./demos"
import {
  createCsoundRuntime,
  type CsoundRuntimeError,
  type RuntimeState
} from "./runtime"
import {
  createShareUrl,
  decodeShareHash,
  SHARE_HASH_PREFIX,
  SHARE_URL_WARNING_LENGTH,
  type ShareWorkspace
} from "./share"
import {
  registerWebMcpTools,
  WebMcpActionError,
  type VersionedWorkspace,
  type WebMcpRegistration
} from "./webmcp"

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
const exportAudioButton = requiredElement<HTMLButtonElement>("export-audio-button")
const shareButton = requiredElement<HTMLButtonElement>("share-button")
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
const webMcpInfoButton = requiredElement<HTMLButtonElement>("webmcp-info-button")
const webMcpInfoTooltip = requiredElement<HTMLSpanElement>("webmcp-info-tooltip")
const demoTitle = requiredElement<HTMLParagraphElement>("demo-title")
const demoNav = requiredElement<HTMLElement>("demo-nav")

function appRootUrl(): URL {
  const url = new URL(window.location.href)
  url.hash = ""
  url.search = ""

  if (ACTIVE_DEMO) {
    const segments = url.pathname.split("/")
    const routeIndex = segments.lastIndexOf(ACTIVE_DEMO.slug)
    if (routeIndex >= 0) {
      url.pathname = `${segments.slice(0, routeIndex).join("/")}/`
    }
  } else if (url.pathname.endsWith("/index.html")) {
    url.pathname = url.pathname.slice(0, -"index.html".length)
  } else if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`
  }

  return url
}

function renderDemoNavigation(): void {
  const rootUrl = appRootUrl()
  const links = [
    {
      current: ACTIVE_DEMO === undefined,
      href: rootUrl.href,
      label: "Workbench"
    },
    ...DEMOS.filter((demo) => demo !== ACTIVE_DEMO).map((demo) => ({
      current: false,
      href: new URL(`${demo.slug}/`, rootUrl).href,
      label: demo.title
    }))
  ]

  const fragment = document.createDocumentFragment()
  for (const item of links) {
    const link = document.createElement("a")
    link.className = "demo-nav__link"
    link.dataset.state = item.current ? "active" : "idle"
    link.href = item.href
    link.textContent = item.label
    if (item.current) link.setAttribute("aria-current", "page")
    fragment.append(link)
  }
  demoNav.replaceChildren(fragment)

  if (ACTIVE_DEMO) {
    demoTitle.hidden = false
    demoTitle.textContent = ACTIVE_DEMO.title
    document.title = `${ACTIVE_DEMO.title} · OPCODE.WASM`
  }
}

renderDemoNavigation()

let compilerReady = false
let operationRunning = false
let operationKind: "compile" | "run" | "render" | "stop" | undefined
let operationId = 0
let workspaceRevision = 0
let messages: UiDiagnostic[] = []
let compiledPlugin: ArrayBuffer | undefined
let initialWorkspace: ShareWorkspace | undefined
let shareLoadError: string | undefined
let shareHashActive = window.location.hash.startsWith(SHARE_HASH_PREFIX)
let shareFeedbackTimer: ReturnType<typeof setTimeout> | undefined
let audioExportFeedbackTimer: ReturnType<typeof setTimeout> | undefined
let webMcpRegistration: WebMcpRegistration | undefined

try {
  initialWorkspace = decodeShareHash(window.location.hash) ?? undefined
} catch (error) {
  shareLoadError = errorText(error)
}

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
  onSourceChange: () => setCompiledPlugin(),
  onWorkspaceChange: handleWorkspaceChange,
  initialWorkspace,
  defaultWorkspace: ACTIVE_DEMO_WORKSPACE,
  persistToLocalStorage: ACTIVE_DEMO === undefined
})

const runtime = createCsoundRuntime({
  onStateChange: handleRuntimeState,
  onMessage: handleRuntimeMessage
})

const audioRenderer = createCsoundAudioRenderer({
  onStateChange: handleAudioRenderState,
  onMessage: handleRuntimeMessage
})

const compiler = new CompilerClient({
  onStateChange: handleCompilerState
})

function handleWorkspaceChange(): void {
  workspaceRevision += 1
  clearShareHash()
}

function clearShareHash(): void {
  if (!shareHashActive) return

  const url = new URL(window.location.href)
  url.hash = ""
  window.history.replaceState(window.history.state, "", url)
  shareHashActive = false
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Use the local copy fallback below
    }
  }

  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined
  const proxy = document.createElement("textarea")
  proxy.className = "clipboard-proxy"
  proxy.value = value
  proxy.readOnly = true
  proxy.tabIndex = -1
  proxy.setAttribute("aria-label", "Share link")
  document.body.append(proxy)
  proxy.select()

  let copied = false
  try {
    copied = document.execCommand("copy")
  } finally {
    proxy.remove()
    activeElement?.focus({ preventScroll: true })
  }

  if (!copied) throw new Error("Browser clipboard access failed")
}

function setShareButton(
  state: "idle" | "loading" | "error" | "success",
  label: string
): void {
  shareButton.dataset.state = state
  shareButton.textContent = label
  if (state === "loading") {
    shareButton.setAttribute("aria-busy", "true")
  } else {
    shareButton.removeAttribute("aria-busy")
  }
}

function resetShareButtonLater(): void {
  if (shareFeedbackTimer !== undefined) clearTimeout(shareFeedbackTimer)
  shareFeedbackTimer = setTimeout(() => {
    setShareButton("idle", "Share")
    shareFeedbackTimer = undefined
  }, 2500)
}

function putShareUrl(): string {
  const shareUrl = createShareUrl(
    editors.getWorkspace(),
    window.location.href
  )
  window.history.replaceState(window.history.state, "", shareUrl)
  shareHashActive = true

  if (shareUrl.length > SHARE_URL_WARNING_LENGTH) {
    addDiagnostic({
      level: "warning",
      message: "This share link is longer than 64 KiB. Some apps may shorten it."
    })
  }

  return shareUrl
}

async function shareWorkspace(): Promise<void> {
  if (shareButton.dataset.state === "loading") return
  if (shareFeedbackTimer !== undefined) {
    clearTimeout(shareFeedbackTimer)
    shareFeedbackTimer = undefined
  }

  setShareButton("loading", "Copying")
  let addressReady = false

  try {
    const shareUrl = putShareUrl()
    addressReady = true
    await copyText(shareUrl)
    setShareButton("success", "Copied")
  } catch (error) {
    const detail = errorText(error)
    addDiagnostic({
      level: addressReady ? "warning" : "error",
      message: addressReady
        ? `The share URL is in the address bar, but copying failed. ${detail}`
        : `The share URL could not be made. ${detail}`
    })
    setShareButton("error", addressReady ? "Copy failed" : "Share failed")
  }

  resetShareButtonLater()
}

function setStatus(
  state: "ready" | "working" | "playing" | "error",
  label: string
): void {
  status.dataset.state = state
  statusLabel.textContent = label
}

function setAudioExportButton(
  state: "idle" | "loading" | "error" | "success" | "disabled",
  label: string
): void {
  exportAudioButton.dataset.state = state
  exportAudioButton.textContent = label
  if (state === "loading") {
    exportAudioButton.setAttribute("aria-busy", "true")
  } else {
    exportAudioButton.removeAttribute("aria-busy")
  }
}

function resetAudioExportButtonLater(): void {
  if (audioExportFeedbackTimer !== undefined) {
    clearTimeout(audioExportFeedbackTimer)
  }
  audioExportFeedbackTimer = setTimeout(() => {
    setAudioExportButton("idle", "Export WAV")
    audioExportFeedbackTimer = undefined
    updateControls()
  }, 2500)
}

function downloadFile(
  data: ArrayBuffer,
  type: string,
  fileName: string
): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function setCompiledPlugin(wasm?: ArrayBuffer): void {
  compiledPlugin = wasm
  exportButton.title = compiledPlugin
    ? `Download plugin.wasm · ${readableBytes(compiledPlugin.byteLength)}`
    : "Run a successful build first"
  updateControls()
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
    operationKind === "stop" ||
    (!operationRunning && !runtime.canStop && !audioRenderer.canStop)
  runButton.dataset.state = runButton.disabled && !operationRunning
    ? "disabled"
    : runState
  stopButton.dataset.state = operationKind === "stop" ? "loading" : "idle"
  exportButton.disabled = !compiledPlugin || operationRunning
  exportButton.dataset.state = exportButton.disabled ? "disabled" : "idle"

  const audioExportDisabled =
    !compilerReady || operationRunning || runtime.canStop
  exportAudioButton.disabled = audioExportDisabled
  if (operationKind === "render") {
    setAudioExportButton("loading", "Rendering")
  } else if (
    exportAudioButton.dataset.state !== "success" &&
    exportAudioButton.dataset.state !== "error"
  ) {
    setAudioExportButton(
      audioExportDisabled ? "disabled" : "idle",
      "Export WAV"
    )
  }
  exportAudioButton.title = runtime.canStop
    ? "Stop playback before exporting audio"
    : compilerReady
      ? "Render example.csd and download WAV audio"
      : "Wait for the browser compiler"
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

function finishChangedOperation(message: string): void {
  compilerState.textContent = "Compiler ready"
  addDiagnostic({
    level: "warning",
    message
  })
  setStatus(
    runtime.isPlaying ? "playing" : "ready",
    runtime.isPlaying ? "Playing" : "Ready"
  )
}

async function compileSource(
  source: string,
  language: SourceLanguage
): Promise<CompileResult> {
  return compiler.compile(source, language)
}

interface SuccessfulBuild {
  status: "built"
  sources: ReturnType<typeof editors.getSources>
  inputName: string
  result: CompileResult & { wasm: ArrayBuffer }
}

interface IncompleteBuild {
  status: "failed" | "changed"
  sources: ReturnType<typeof editors.getSources>
  inputName: string
  result?: CompileResult
}

type BuildOutcome = SuccessfulBuild | IncompleteBuild

function diagnosticData(): Array<{
  level: DiagnosticLevel
  message: string
  line?: number | null
  column?: number | null
}> {
  return messages.map((message) => ({ ...message }))
}

function operationUnavailable(): string | undefined {
  if (!compilerReady) return "compiler_not_ready"
  if (operationRunning) return "workbench_busy"
  return undefined
}

function beginOperation(
  kind: "compile" | "run" | "render" | "stop"
): number {
  const id = ++operationId
  operationRunning = true
  operationKind = kind
  updateControls("loading")
  return id
}

function endOperation(
  id: number,
  controlState: "idle" | "loading" | "error" | "success" = "idle"
): void {
  if (id !== operationId) return
  operationRunning = false
  operationKind = undefined
  updateControls(controlState)
}

async function buildCurrentPlugin(currentId: number): Promise<BuildOutcome> {
  const sources = editors.getSources()
  const inputName = sourceFileName(sources.language)
  setCompiledPlugin()
  editors.setCompilerDiagnostics([])
  replaceDiagnostics([], `Building ${inputName}`)
  compilerState.textContent = "Compiler working"
  setStatus("working", "Compiling plugin")
  updateControls("loading")

  const result = await compileSource(sources.source, sources.language)
  if (currentId !== operationId) throw new DOMException("Build stopped", "AbortError")

  const currentSources = editors.getSources()
  if (!sourceMatches(currentSources, sources)) {
    editors.setCompilerDiagnostics([])
    replaceDiagnostics([], `Built ${inputName}, but the source changed`)
    finishChangedOperation("Source changed during the build. Run again.")
    return { status: "changed", sources, inputName, result }
  }

  editors.setCompilerDiagnostics(result.diagnostics)
  const compilerDiagnostics = result.diagnostics.map((diagnostic) =>
    compilerMessage(diagnostic, inputName)
  )

  if (!result.ok || !result.wasm) {
    const fallback = result.output.trim() || "Clang did not build the plugin"
    replaceDiagnostics(
      compilerDiagnostics.length > 0
        ? compilerDiagnostics
        : [{ level: "error", message: fallback }]
    )
    compilerState.textContent = "Compiler error"
    const priorAudio = runtime.isPlaying ? " Prior audio is still playing" : ""
    setStatus("error", `Build failed.${priorAudio}`)
    return { status: "failed", sources, inputName, result }
  }

  const successfulResult = result as CompileResult & { wasm: ArrayBuffer }
  replaceDiagnostics([
    ...compilerDiagnostics,
    {
      level: "success",
      message: `Built plugin.wasm from ${inputName} in ${Math.round(result.durationMs)} ms · ${readableBytes(result.wasm.byteLength)}`
    }
  ])
  setCompiledPlugin(result.wasm)
  compilerState.textContent = `Compiler ready · ${Math.round(result.durationMs)} ms`
  return {
    status: "built",
    sources,
    inputName,
    result: successfulResult
  }
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

function audioRenderLabel(state: AudioRenderState): string {
  switch (state) {
    case "loading":
      return "Renderer loading"
    case "compiling":
      return "Render CSD compiling"
    case "rendering":
      return "Audio rendering"
    case "stopping":
      return "Render stopping"
    case "error":
      return "Render error"
    default:
      return runtimeLabel(runtime.state)
  }
}

function handleAudioRenderState(
  state: AudioRenderState,
  error?: AudioRenderError
): void {
  audioState.textContent = audioRenderLabel(state)

  if (operationKind === "render") {
    if (state === "loading") setStatus("working", "Loading renderer")
    if (state === "compiling") setStatus("working", "Compiling render CSD")
    if (state === "rendering") setStatus("working", "Rendering WAV")
    updateControls("loading")
    return
  }

  if (state === "error") {
    setStatus("error", error?.message ?? "Audio render failed")
    updateControls("error")
    return
  }

  updateControls()
}

function handleRuntimeState(state: RuntimeState, error?: CsoundRuntimeError): void {
  if (state !== "idle" || audioRenderer.state === "idle") {
    audioState.textContent = runtimeLabel(state)
  }

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

async function compileOnly(): Promise<Record<string, unknown>> {
  const unavailable = operationUnavailable()
  if (unavailable) {
    return {
      compiled: false,
      reason: unavailable,
      revision: workspaceRevision
    }
  }

  const currentId = beginOperation("compile")
  let controls: "idle" | "error" = "idle"

  try {
    const build = await buildCurrentPlugin(currentId)
    controls = build.status === "failed" ? "error" : "idle"
    if (build.status === "built") {
      setStatus(runtime.isPlaying ? "playing" : "ready", runtime.isPlaying ? "Playing" : "Ready")
    }
    return {
      compiled: build.status === "built",
      reason: build.status === "built" ? undefined : build.status,
      file_name: build.status === "built" ? "plugin.wasm" : undefined,
      wasm_bytes: build.status === "built" ? build.result.wasm.byteLength : undefined,
      duration_ms: build.result?.durationMs,
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } catch (error) {
    if (currentId !== operationId || (error instanceof DOMException && error.name === "AbortError")) {
      return { compiled: false, reason: "stopped", revision: workspaceRevision }
    }

    controls = "error"
    const message = errorText(error)
    compilerState.textContent = "Compiler error"
    addDiagnostic({ level: "error", message })
    setStatus("error", message)
    return {
      compiled: false,
      reason: "compile_failed",
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } finally {
    endOperation(currentId, controls)
  }
}

async function run(): Promise<Record<string, unknown>> {
  const unavailable = operationUnavailable()
  if (unavailable) {
    return {
      playing: runtime.isPlaying,
      started: false,
      reason: unavailable,
      revision: workspaceRevision
    }
  }

  const currentId = beginOperation("run")
  let controls: "idle" | "error" | "success" = "idle"
  let pluginBuilt = false

  try {
    const build = await buildCurrentPlugin(currentId)
    if (build.status !== "built") {
      controls = build.status === "failed" ? "error" : "idle"
      return {
        playing: runtime.isPlaying,
        started: false,
        reason: build.status,
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    pluginBuilt = true
    if (editors.getSources().csd !== build.sources.csd) {
      finishChangedOperation("CSD changed during the build. Run again.")
      return {
        playing: runtime.isPlaying,
        started: false,
        reason: "changed",
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    await audioRenderer.stop()
    setStatus("working", "Replacing Csound")
    await runtime.start(build.result.wasm, build.sources.csd)
    if (currentId !== operationId) {
      return { playing: false, started: false, reason: "stopped" }
    }

    const sourcesAfterStart = editors.getSources()
    if (
      !sourceMatches(sourcesAfterStart, build.sources) ||
      sourcesAfterStart.csd !== build.sources.csd
    ) {
      await runtime.stop()
      if (currentId !== operationId) {
        return { playing: false, started: false, reason: "stopped" }
      }
      finishChangedOperation("Code changed while Csound started. Run again.")
      return {
        playing: false,
        started: false,
        reason: "changed",
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    const audioContextState = await runtime.getAudioContextState()
    if (audioContextState === "suspended") {
      await runtime.stop()
      controls = "error"
      addDiagnostic({
        level: "warning",
        message: "The browser blocked audio start. Click Run once to allow sound."
      })
      setStatus("error", "Click Run to allow audio")
      return {
        playing: false,
        started: false,
        reason: "user_gesture_required",
        audio_context_state: audioContextState,
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    controls = runtime.isPlaying ? "success" : "idle"
    setStatus(runtime.isPlaying ? "playing" : "ready", runtime.isPlaying ? "Playing" : "Ready")
    return {
      playing: runtime.isPlaying,
      started: runtime.isPlaying,
      wasm_bytes: build.result.wasm.byteLength,
      build_duration_ms: build.result.durationMs,
      audio_context_state: audioContextState,
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } catch (error) {
    if (currentId !== operationId || (error instanceof DOMException && error.name === "AbortError")) {
      return { playing: false, started: false, reason: "stopped" }
    }

    controls = "error"
    compilerState.textContent = pluginBuilt ? "Compiler ready" : "Compiler error"
    const message = errorText(error)
    if (!messages.some((item) => item.level === "error" && item.message === message)) {
      addDiagnostic({ level: "error", message })
    }
    setStatus("error", message)
    return {
      playing: false,
      started: false,
      reason: "run_failed",
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } finally {
    endOperation(currentId, controls)
  }
}

function exportPlugin(): Record<string, unknown> {
  if (!compiledPlugin) {
    throw new WebMcpActionError(
      "no_build",
      "Compile the plugin before exporting WebAssembly"
    )
  }

  downloadFile(compiledPlugin, "application/wasm", "plugin.wasm")
  addDiagnostic({
    level: "success",
    message: `Exported plugin.wasm · ${readableBytes(compiledPlugin.byteLength)} · OPCODE.WASM`
  })
  return {
    exported: true,
    file_name: "plugin.wasm",
    wasm_bytes: compiledPlugin.byteLength,
    build_header: "Built by OPCODE.WASM"
  }
}

async function exportAudio(): Promise<Record<string, unknown>> {
  const unavailable = operationUnavailable()
  if (unavailable || runtime.canStop) {
    return {
      exported: false,
      reason: runtime.canStop ? "playback_active" : unavailable,
      revision: workspaceRevision
    }
  }

  if (audioExportFeedbackTimer !== undefined) {
    clearTimeout(audioExportFeedbackTimer)
    audioExportFeedbackTimer = undefined
  }
  const currentId = beginOperation("render")
  let controls: "idle" | "error" = "idle"
  let rendered: RenderedAudio | undefined

  try {
    const build = await buildCurrentPlugin(currentId)
    if (build.status !== "built") {
      controls = build.status === "failed" ? "error" : "idle"
      if (controls === "error") {
        setAudioExportButton("error", "Render failed")
        resetAudioExportButtonLater()
      }
      return {
        exported: false,
        reason: build.status,
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    if (editors.getSources().csd !== build.sources.csd) {
      finishChangedOperation("CSD changed during the build. Export again.")
      return {
        exported: false,
        reason: "changed",
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    rendered = await audioRenderer.render(build.result.wasm, build.sources.csd)
    if (currentId !== operationId) {
      return { exported: false, reason: "stopped", revision: workspaceRevision }
    }

    const currentSources = editors.getSources()
    if (
      !sourceMatches(currentSources, build.sources) ||
      currentSources.csd !== build.sources.csd
    ) {
      finishChangedOperation("Code changed during the audio render. Export again.")
      return {
        exported: false,
        reason: "changed",
        revision: workspaceRevision,
        diagnostics: diagnosticData()
      }
    }

    downloadFile(rendered.wav, "audio/wav", rendered.fileName)
    addDiagnostic({
      level: "success",
      message: `Exported ${rendered.fileName} · ${rendered.durationSeconds.toFixed(2)} s · ${readableBytes(rendered.wav.byteLength)}`
    })
    setStatus("ready", "Ready")
    setAudioExportButton("success", "Saved")
    resetAudioExportButtonLater()
    return {
      exported: true,
      file_name: rendered.fileName,
      audio_bytes: rendered.wav.byteLength,
      duration_seconds: rendered.durationSeconds,
      sample_rate: rendered.sampleRate,
      channels: rendered.channels,
      bit_depth: rendered.bitDepth,
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } catch (error) {
    if (currentId !== operationId || (error instanceof DOMException && error.name === "AbortError")) {
      return { exported: false, reason: "stopped", revision: workspaceRevision }
    }

    controls = "error"
    const message = errorText(error)
    addDiagnostic({ level: "error", message })
    setStatus("error", message)
    setAudioExportButton("error", "Render failed")
    resetAudioExportButtonLater()
    return {
      exported: false,
      reason: "render_failed",
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } finally {
    endOperation(currentId, controls)
  }
}

async function stop(): Promise<Record<string, unknown>> {
  const currentId = ++operationId
  compiler.cancel()
  operationRunning = true
  operationKind = "stop"
  setStatus("working", "Stopping")
  updateControls("loading")

  try {
    const results = await Promise.allSettled([
      runtime.stop(),
      audioRenderer.stop()
    ])
    if (currentId !== operationId) return { stopped: false, reason: "replaced" }

    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => errorText(result.reason))
    if (errors.length > 0) throw new Error(errors.join(". "))

    setStatus(compilerReady ? "ready" : "working", compilerReady ? "Ready" : "Loading compiler")
    audioState.textContent = "Audio idle"
    return {
      stopped: true,
      revision: workspaceRevision
    }
  } catch (error) {
    if (currentId !== operationId) return { stopped: false, reason: "replaced" }
    const message = errorText(error)
    addDiagnostic({
      level: "error",
      message
    })
    setStatus("error", message)
    return {
      stopped: false,
      reason: "stop_failed",
      revision: workspaceRevision,
      diagnostics: diagnosticData()
    }
  } finally {
    if (currentId === operationId) {
      operationRunning = false
      operationKind = undefined
      updateControls()
    }
  }
}

function workbenchState(): VersionedWorkspace & Record<string, unknown> {
  return {
    ...editors.getWorkspace(),
    revision: workspaceRevision,
    build_state: operationRunning
      ? operationKind ?? "working"
      : compilerReady
        ? "ready"
        : "loading",
    audio_state: runtime.state !== "idle"
      ? runtime.state
      : audioRenderer.state,
    compiled_wasm_bytes: compiledPlugin?.byteLength ?? 0,
    diagnostics: diagnosticData()
  }
}

function updateWorkspaceFromWebMcp(
  patch: EditorWorkspacePatch,
  baseRevision: number
): Record<string, unknown> {
  if (operationRunning) {
    throw new WebMcpActionError(
      "workbench_busy",
      "Stop the current work before changing the editors"
    )
  }
  if (baseRevision !== workspaceRevision) {
    throw new WebMcpActionError(
      "revision_conflict",
      `Workspace is now at revision ${workspaceRevision}. Read it again before editing.`
    )
  }

  const before = editors.getWorkspace()
  const updated = editors.updateWorkspace(patch)
  const changedFields = (Object.keys(patch) as Array<keyof EditorWorkspacePatch>)
    .filter((field) => before[field] !== updated[field])
  renderSourceLanguage(updated.language)

  if (changedFields.length === 0) {
    return {
      revision: workspaceRevision,
      changed_fields: [],
      language: updated.language,
      build_state: compilerReady ? "ready" : "loading",
      audio_state: runtime.state !== "idle" ? runtime.state : audioRenderer.state
    }
  }

  if (changedFields.some((field) => field !== "csd")) {
    editors.setCompilerDiagnostics([])
  }
  replaceDiagnostics([], "Workspace updated through WebMCP")
  setStatus(
    runtime.isPlaying ? "playing" : compilerReady ? "ready" : "working",
    runtime.isPlaying ? "Playing" : compilerReady ? "Ready" : "Loading compiler"
  )
  updateControls()
  return {
    revision: workspaceRevision,
    changed_fields: changedFields,
    language: updated.language,
    build_state: compilerReady ? "ready" : "loading",
    audio_state: runtime.state !== "idle" ? runtime.state : audioRenderer.state
  }
}

async function setupWebMcp(): Promise<void> {
  try {
    webMcpRegistration = await registerWebMcpTools({
      readWorkspace: workbenchState,
      updateWorkspace: updateWorkspaceFromWebMcp,
      compilePlugin: compileOnly,
      runCsound: run,
      stopCsound: stop,
      exportWasm: () => {
        if (operationRunning) {
          throw new WebMcpActionError(
            "workbench_busy",
            "Stop the current work before exporting WebAssembly"
          )
        }
        return exportPlugin()
      },
      exportAudio,
      createShareLink: () => {
        const url = putShareUrl()
        return {
          url,
          url_length: url.length,
          revision: workspaceRevision
        }
      }
    })

    webMcpInfoButton.dataset.state = webMcpRegistration.supported
      ? "ready"
      : "flag-needed"
    webMcpInfoButton.setAttribute(
      "aria-label",
      webMcpRegistration.supported
        ? `${webMcpRegistration.toolCount} WebMCP tools ready. Show setup details`
        : "WebMCP supported. Show setup details"
    )
  } catch (error) {
    webMcpInfoButton.dataset.state = "error"
    addDiagnostic({
      level: "warning",
      message: errorText(error)
    })
  }
}

runButton.addEventListener("click", () => void run())
stopButton.addEventListener("click", () => void stop())
exportButton.addEventListener("click", () => {
  try {
    exportPlugin()
  } catch (error) {
    addDiagnostic({ level: "error", message: errorText(error) })
  }
})
exportAudioButton.addEventListener("click", () => void exportAudio())
shareButton.addEventListener("click", () => void shareWorkspace())
cLanguageButton.addEventListener("click", () => selectSourceLanguage("c"))
cppLanguageButton.addEventListener("click", () => selectSourceLanguage("cpp"))
clearButton.addEventListener("click", () => {
  editors.setCompilerDiagnostics([])
  replaceDiagnostics([], "No messages")
})
webMcpInfoButton.addEventListener("keydown", (event) => {
  if (event.key === "Escape") webMcpInfoButton.blur()
})

window.addEventListener("beforeunload", () => {
  webMcpRegistration?.dispose()
  compiler.destroy()
  editors.destroy()
  void runtime.stop()
  void audioRenderer.stop()
})

renderSourceLanguage(editors.getSources().language)
renderDiagnostics(
  ACTIVE_DEMO
    ? `Press Run to build and play ${ACTIVE_DEMO.title}`
    : undefined
)
webMcpInfoTooltip.textContent = "Enable chrome://flags/#enable-webmcp-testing, then relaunch Chrome."
if (shareLoadError) {
  addDiagnostic({
    level: "error",
    message: `The share link was not loaded. ${shareLoadError}`
  })
} else if (initialWorkspace) {
  addDiagnostic({
    level: "success",
    message: `Loaded shared ${sourceFileName(initialWorkspace.language)} and example.csd`
  })
}
updateControls()
void setupWebMcp()
