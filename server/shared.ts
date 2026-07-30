export const MAX_SOURCE_BYTES = 256 * 1024
export const MAX_COMPILER_OUTPUT_BYTES = 128 * 1024
export const MAX_WASM_BYTES = 4 * 1024 * 1024
export const CLANG_TIMEOUT_MS = 10_000
export const WORKER_GUARD_MS = 12_000
export const MAX_QUEUED_JOBS = 4

export type DiagnosticSeverity = "fatal error" | "error" | "warning" | "note"
export type SourceLanguage = "c" | "cpp"

export interface CompilerDiagnostic {
  file: string
  line: number | null
  column: number | null
  severity: DiagnosticSeverity
  message: string
}

export type CompileFailureReason =
  | "compile_error"
  | "timeout"
  | "source_limit"
  | "output_limit"
  | "wasm_limit"
  | "invalid_plugin"
  | "tool_error"

export interface CompileResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  diagnostics: CompilerDiagnostic[]
  output: string
  durationMs: number
  reason?: CompileFailureReason
  wasm?: ArrayBuffer
}

export interface CompilerConfig {
  csoundSdkPath: string
  cCompilerPath: string
  cppCompilerPath: string
  cppLibraryPath: string
  linkerPath: string
}

export interface CompileJobMessage {
  type: "compile"
  id: number
  source: string
  language: SourceLanguage
}

export interface WorkerReadyMessage {
  type: "ready"
}

export interface WorkerStartedMessage {
  type: "started"
  id: number
  pid: number
}

export interface WorkerResultMessage {
  type: "result"
  id: number
  result: CompileResult
}

export type CompilerWorkerMessage =
  | WorkerReadyMessage
  | WorkerStartedMessage
  | WorkerResultMessage
