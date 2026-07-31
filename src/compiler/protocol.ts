import type { SourceLanguage } from "../editors"

export const MAX_SOURCE_BYTES = 256 * 1024
export const MAX_COMPILER_OUTPUT_BYTES = 128 * 1024
export const MAX_WASM_BYTES = 4 * 1024 * 1024
export const COMPILER_GUARD_MS = 30_000

export type DiagnosticSeverity = "fatal error" | "error" | "warning" | "note"

export interface CompilerDiagnostic {
  file: string
  line: number | null
  column: number | null
  severity: DiagnosticSeverity
  message: string
}

export type CompileFailureReason =
  | "compile_error"
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

export interface CompileJobMessage {
  type: "compile"
  id: number
  source: string
  language: SourceLanguage
}

export interface CompilerLoadMessage {
  type: "load"
  loaded: number
  total: number
}

export interface CompilerReadyMessage {
  type: "ready"
}

export interface CompilerResultMessage {
  type: "result"
  id: number
  result: CompileResult
}

export interface CompilerFatalMessage {
  type: "fatal"
  message: string
}

export type CompilerWorkerRequest = CompileJobMessage

export type CompilerWorkerResponse =
  | CompilerLoadMessage
  | CompilerReadyMessage
  | CompilerResultMessage
  | CompilerFatalMessage
