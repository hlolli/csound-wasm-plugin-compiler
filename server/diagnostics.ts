import { basename, resolve } from "node:path"

import type { CompilerDiagnostic, DiagnosticSeverity } from "./shared"

const diagnosticPattern =
  /^(.*?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning|note):\s+(.*)$/

const ansiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g

export function sanitizeCompilerOutput(output: string, buildDir: string): string {
  return output
    .replace(ansiPattern, "")
    .split(buildDir)
    .join("<build>")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .trim()
}

export function parseCompilerDiagnostics(
  output: string,
  buildDir: string,
  sourceName = "plugin.c",
): CompilerDiagnostic[] {
  const sourcePath = resolve(buildDir, sourceName)
  const diagnostics: CompilerDiagnostic[] = []

  for (const line of output.replaceAll("\r\n", "\n").split("\n")) {
    const match = line.match(diagnosticPattern)
    if (!match) {
      continue
    }

    const rawFile = match[1]
    const isSource =
      rawFile === sourceName ||
      resolve(rawFile) === sourcePath ||
      (rawFile.startsWith(buildDir) && basename(rawFile) === sourceName)

    diagnostics.push({
      file: isSource ? sourceName : rawFile.split(buildDir).join("<build>"),
      line: Number.parseInt(match[2], 10),
      column: match[3] ? Number.parseInt(match[3], 10) : null,
      severity: match[4] as DiagnosticSeverity,
      message: match[5].trim(),
    })
  }

  return diagnostics
}

export function messageDiagnostic(
  message: string,
  severity: DiagnosticSeverity = "error",
): CompilerDiagnostic {
  return {
    file: "",
    line: null,
    column: null,
    severity,
    message,
  }
}
