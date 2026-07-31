import type {
  CompilerDiagnostic,
  DiagnosticSeverity
} from "./protocol"

const diagnosticPattern =
  /^(.*?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning|note):\s+(.*)$/

const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g

function isSourcePath(path: string, sourceName: string): boolean {
  const cleanPath = path.replaceAll("\\", "/")
  return cleanPath === sourceName || cleanPath.endsWith(`/${sourceName}`)
}

export function sanitizeCompilerOutput(output: string): string {
  return output
    .replace(ansiPattern, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim()
}

export function parseCompilerDiagnostics(
  output: string,
  sourceName = "plugin.c"
): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = []

  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(diagnosticPattern)
    if (!match) continue

    diagnostics.push({
      file: isSourcePath(match[1], sourceName) ? sourceName : match[1],
      line: Number.parseInt(match[2], 10),
      column: match[3] ? Number.parseInt(match[3], 10) : null,
      severity: match[4] as DiagnosticSeverity,
      message: match[5].trim()
    })
  }

  return diagnostics
}

export function messageDiagnostic(
  message: string,
  severity: DiagnosticSeverity = "error"
): CompilerDiagnostic {
  return {
    file: "",
    line: null,
    column: null,
    severity,
    message
  }
}
