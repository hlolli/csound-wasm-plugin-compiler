import type {
  EditorWorkspace,
  EditorWorkspacePatch
} from "./editors"

type ToolInput = Record<string, unknown>
type ToolOutput = Record<string, unknown>

interface WebMcpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readOnlyHint: boolean
    untrustedContentHint: boolean
  }
  execute: (input: ToolInput) => Promise<ToolOutput>
}

export interface ModelContextLike {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal }
  ) => void | Promise<void>
}

export interface VersionedWorkspace extends EditorWorkspace {
  revision: number
}

export interface WebMcpWorkbenchApi {
  readWorkspace: () => VersionedWorkspace & ToolOutput
  updateWorkspace: (
    patch: EditorWorkspacePatch,
    baseRevision: number
  ) => ToolOutput
  compilePlugin: () => Promise<ToolOutput>
  runCsound: () => Promise<ToolOutput>
  stopCsound: () => Promise<ToolOutput>
  exportWasm: () => Promise<ToolOutput> | ToolOutput
  exportAudio: () => Promise<ToolOutput>
  createShareLink: () => Promise<ToolOutput> | ToolOutput
}

export interface WebMcpRegistration {
  supported: boolean
  toolCount: number
  dispose: () => void
}

export class WebMcpActionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "WebMcpActionError"
    this.code = code
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function errorCode(error: unknown): string {
  if (error instanceof WebMcpActionError) return error.code
  if (error instanceof DOMException && error.name === "AbortError") return "stopped"
  return "action_failed"
}

function asInput(value: unknown): ToolInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WebMcpActionError("invalid_input", "Tool input must be an object")
  }
  return value as ToolInput
}

function emptyInput(value: unknown): ToolInput {
  const input = asInput(value)
  if (Object.keys(input).length > 0) {
    throw new WebMcpActionError("invalid_input", "This tool takes no input")
  }
  return input
}

function workspaceUpdate(value: unknown): {
  baseRevision: number
  patch: EditorWorkspacePatch
} {
  const input = asInput(value)
  const allowed = new Set(["base_revision", "c", "cpp", "csd", "language"])
  const extra = Object.keys(input).find((key) => !allowed.has(key))
  if (extra) {
    throw new WebMcpActionError(
      "invalid_input",
      `Unknown workspace field: ${extra}`
    )
  }

  const revision = input.base_revision
  if (!Number.isInteger(revision) || Number(revision) < 0) {
    throw new WebMcpActionError(
      "invalid_input",
      "base_revision must be a whole number"
    )
  }

  const patch: EditorWorkspacePatch = {}
  const limits = {
    c: 262_144,
    cpp: 262_144,
    csd: 1_048_576
  }
  for (const key of ["c", "cpp", "csd"] as const) {
    const field = input[key]
    if (field === undefined) continue
    if (typeof field !== "string") {
      throw new WebMcpActionError("invalid_input", `${key} must be text`)
    }
    if (field.length > limits[key]) {
      throw new WebMcpActionError(
        "input_too_large",
        `${key} is longer than ${limits[key]} characters`
      )
    }
    patch[key] = field
  }

  if (input.language !== undefined) {
    if (input.language !== "c" && input.language !== "cpp") {
      throw new WebMcpActionError(
        "invalid_input",
        "language must be c or cpp"
      )
    }
    patch.language = input.language
  }

  if (Object.keys(patch).length === 0) {
    throw new WebMcpActionError(
      "invalid_input",
      "Pass at least one workspace field to change"
    )
  }

  return {
    baseRevision: Number(revision),
    patch
  }
}

function resultObject(
  name: string,
  callback: (input: ToolInput) => ToolOutput | Promise<ToolOutput>,
  parse: (value: unknown) => ToolInput = asInput
): (input: ToolInput) => Promise<ToolOutput> {
  return async (value) => {
    try {
      const output = await callback(parse(value))
      const resultFlags = ["compiled", "started", "stopped", "exported"]
      const failed = resultFlags.some(
        (field) => field in output && output[field] === false
      )
      if (failed) {
        const code = typeof output.reason === "string"
          ? output.reason
          : "action_failed"
        return {
          ok: false,
          action: name,
          ...output,
          error: {
            code,
            message: `The ${name} action did not finish: ${code.replaceAll("_", " ")}`
          }
        }
      }

      return {
        ok: true,
        action: name,
        ...output
      }
    } catch (error) {
      return {
        ok: false,
        action: name,
        error: {
          code: errorCode(error),
          message: errorText(error)
        }
      }
    }
  }
}

const noInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
}

function createTools(api: WebMcpWorkbenchApi): WebMcpTool[] {
  return [
    {
      name: "read_workspace",
      description: "Read all C, C++, and CSD editor text with the active language, revision, build state, and audio state. Call this before changing code.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true
      },
      execute: resultObject(
        "read_workspace",
        () => api.readWorkspace(),
        emptyInput
      )
    },
    {
      name: "update_workspace",
      description: "Replace one or more editor documents with full text. Read the workspace first and pass its revision as base_revision. A stale revision is rejected so human edits are not lost.",
      inputSchema: {
        type: "object",
        properties: {
          base_revision: {
            type: "integer",
            minimum: 0,
            description: "Revision returned by read_workspace"
          },
          c: {
            type: "string",
            maxLength: 262_144,
            description: "Full plugin.c text"
          },
          cpp: {
            type: "string",
            maxLength: 262_144,
            description: "Full plugin.cpp text"
          },
          csd: {
            type: "string",
            maxLength: 1_048_576,
            description: "Full example.csd text"
          },
          language: {
            type: "string",
            enum: ["c", "cpp"],
            description: "Active plugin language"
          }
        },
        required: ["base_revision"],
        additionalProperties: false
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true
      },
      execute: resultObject("update_workspace", (input) => {
        const update = workspaceUpdate(input)
        return api.updateWorkspace(update.patch, update.baseRevision)
      })
    },
    {
      name: "compile_plugin",
      description: "Compile the active C or C++ source into a Csound WebAssembly plugin. Return Clang diagnostics and update the visible diagnostics panel without starting audio.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true
      },
      execute: resultObject(
        "compile_plugin",
        () => api.compilePlugin(),
        emptyInput
      )
    },
    {
      name: "run_csound",
      description: "Compile the active plugin, load it into a new Csound worker, compile the visible CSD, and start audio playback.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true
      },
      execute: resultObject(
        "run_csound",
        () => api.runCsound(),
        emptyInput
      )
    },
    {
      name: "stop_csound",
      description: "Stop the active build, audio render, or Csound playback and close its worker.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true
      },
      execute: resultObject(
        "stop_csound",
        () => api.stopCsound(),
        emptyInput
      )
    },
    {
      name: "export_wasm",
      description: "Download the last good plugin build as plugin.wasm. Compile first if the source changed.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false
      },
      execute: resultObject(
        "export_wasm",
        () => api.exportWasm(),
        emptyInput
      )
    },
    {
      name: "export_audio",
      description: "Compile the active plugin, render the visible CSD offline in Csound, and download the result as a WAV file. The render runs in this browser tab.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true
      },
      execute: resultObject(
        "export_audio",
        () => api.exportAudio(),
        emptyInput
      )
    },
    {
      name: "create_share_link",
      description: "Put the current C, C++, and CSD workspace into a compressed share URL and return the URL. The code stays in the URL fragment.",
      inputSchema: noInputSchema,
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: true
      },
      execute: resultObject(
        "create_share_link",
        () => api.createShareLink(),
        emptyInput
      )
    }
  ]
}

function pageModelContext(): ModelContextLike | undefined {
  if (typeof document === "undefined") return undefined
  return (document as Document & { modelContext?: ModelContextLike }).modelContext
}

export async function registerWebMcpTools(
  api: WebMcpWorkbenchApi,
  modelContext: ModelContextLike | undefined = pageModelContext()
): Promise<WebMcpRegistration> {
  if (!modelContext) {
    return {
      supported: false,
      toolCount: 0,
      dispose: () => undefined
    }
  }

  const controller = new AbortController()
  const tools = createTools(api)

  try {
    for (const tool of tools) {
      await modelContext.registerTool(tool, { signal: controller.signal })
    }
  } catch (error) {
    controller.abort()
    throw new WebMcpActionError(
      "registration_failed",
      `WebMCP tools could not be registered: ${errorText(error)}`
    )
  }

  return {
    supported: true,
    toolCount: tools.length,
    dispose: () => controller.abort()
  }
}
