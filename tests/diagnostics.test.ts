import { describe, expect, test } from "bun:test"

import {
  parseCompilerDiagnostics,
  sanitizeCompilerOutput,
} from "../src/compiler/diagnostics"

describe("compiler diagnostics", () => {
  test("parses source lines and keeps non-source files", () => {
    const output = [
      "/workspace/plugin.c:12:7: error: expected expression",
      "plugin.c:18:3: warning: unused value [-Wunused-value]",
      "/sdk/include/csound/csound.h:20:2: note: expanded from here",
      "1 error generated.",
    ].join("\n")

    expect(parseCompilerDiagnostics(output)).toEqual([
      {
        file: "plugin.c",
        line: 12,
        column: 7,
        severity: "error",
        message: "expected expression",
      },
      {
        file: "plugin.c",
        line: 18,
        column: 3,
        severity: "warning",
        message: "unused value [-Wunused-value]",
      },
      {
        file: "/sdk/include/csound/csound.h",
        line: 20,
        column: 2,
        severity: "note",
        message: "expanded from here",
      },
    ])
  })

  test("removes color and carriage returns", () => {
    const output =
      "\u001b[31mplugin.c:4:2: error: broken\u001b[0m\r\n" +
      "1 error generated.\r"

    expect(sanitizeCompilerOutput(output)).toBe(
      "plugin.c:4:2: error: broken\n1 error generated.",
    )
  })
})
