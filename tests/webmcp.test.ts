import { describe, expect, test } from "bun:test"

import {
  registerWebMcpTools,
  WebMcpActionError,
  type ModelContextLike,
  type WebMcpWorkbenchApi
} from "../src/webmcp"

interface CapturedTool {
  name: string
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function fakeApi(): WebMcpWorkbenchApi {
  const workspace = {
    c: "c source",
    cpp: "cpp source",
    csd: "csd source",
    language: "c" as const,
    revision: 4,
    build_state: "ready",
    audio_state: "idle"
  }

  return {
    readWorkspace: () => workspace,
    updateWorkspace: (patch, baseRevision) => {
      if (baseRevision !== workspace.revision) {
        throw new WebMcpActionError(
          "revision_conflict",
          `Workspace is now at revision ${workspace.revision}`
        )
      }
      return {
        ...workspace,
        ...patch,
        revision: workspace.revision + 1
      }
    },
    compilePlugin: async () => ({ built: true, wasm_bytes: 100 }),
    runCsound: async () => ({ playing: true }),
    stopCsound: async () => ({ stopped: true }),
    exportWasm: () => ({ file_name: "plugin.wasm", wasm_bytes: 100 }),
    exportAudio: async () => ({
      file_name: "opcode-wasm-render.wav",
      audio_bytes: 200,
      duration_seconds: 1
    }),
    createShareLink: () => ({ url: "https://example.test/#pako:data" })
  }
}

function fakeContext() {
  const tools: CapturedTool[] = []
  const signals: AbortSignal[] = []
  const context: ModelContextLike = {
    registerTool: (tool, options) => {
      tools.push(tool)
      if (options?.signal) signals.push(options.signal)
    }
  }
  return { context, tools, signals }
}

describe("WebMCP tools", () => {
  test("stays optional when the browser has no WebMCP API", async () => {
    const registration = await registerWebMcpTools(fakeApi(), undefined)

    expect(registration.supported).toBe(false)
    expect(registration.toolCount).toBe(0)
  })

  test("registers the focused workbench tool set", async () => {
    const capture = fakeContext()
    const registration = await registerWebMcpTools(fakeApi(), capture.context)

    expect(capture.tools.map((tool) => tool.name)).toEqual([
      "read_workspace",
      "update_workspace",
      "compile_plugin",
      "run_csound",
      "stop_csound",
      "export_wasm",
      "export_audio",
      "create_share_link"
    ])
    expect(registration.supported).toBe(true)
    expect(registration.toolCount).toBe(8)
    expect(capture.signals.every((signal) => !signal.aborted)).toBe(true)

    registration.dispose()
    expect(capture.signals.every((signal) => signal.aborted)).toBe(true)
  })

  test("returns the full workspace as JSON", async () => {
    const capture = fakeContext()
    await registerWebMcpTools(fakeApi(), capture.context)
    const tool = capture.tools.find((item) => item.name === "read_workspace")

    expect(tool).toBeDefined()
    const result = await tool!.execute({})
    expect(result).toMatchObject({
      ok: true,
      action: "read_workspace",
      revision: 4,
      c: "c source",
      cpp: "cpp source",
      csd: "csd source"
    })
  })

  test("updates code only from the current revision", async () => {
    const capture = fakeContext()
    await registerWebMcpTools(fakeApi(), capture.context)
    const tool = capture.tools.find((item) => item.name === "update_workspace")

    const updated = await tool!.execute({
      base_revision: 4,
      cpp: "new cpp source",
      language: "cpp"
    })
    expect(updated).toMatchObject({
      ok: true,
      revision: 5,
      cpp: "new cpp source",
      language: "cpp"
    })

    const stale = await tool!.execute({
      base_revision: 2,
      c: "stale edit"
    })
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: "revision_conflict"
      }
    })
  })

  test("rejects malformed tool input as a structured error", async () => {
    const capture = fakeContext()
    await registerWebMcpTools(fakeApi(), capture.context)
    const tool = capture.tools.find((item) => item.name === "update_workspace")

    const result = await tool!.execute({
      base_revision: 4,
      unknown: true
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input"
      }
    })
  })

  test("marks a domain failure as a failed tool call", async () => {
    const capture = fakeContext()
    const api = fakeApi()
    api.exportAudio = async () => ({
      exported: false,
      reason: "render_failed"
    })
    await registerWebMcpTools(api, capture.context)
    const tool = capture.tools.find((item) => item.name === "export_audio")

    const result = await tool!.execute({})
    expect(result).toMatchObject({
      ok: false,
      exported: false,
      error: {
        code: "render_failed"
      }
    })
  })

  test("enforces source size in code as well as schema", async () => {
    const capture = fakeContext()
    await registerWebMcpTools(fakeApi(), capture.context)
    const tool = capture.tools.find((item) => item.name === "update_workspace")

    const result = await tool!.execute({
      base_revision: 4,
      c: "x".repeat(262_145)
    })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "input_too_large"
      }
    })
  })
})
