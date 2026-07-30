import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"

import {
  CompilerBusyError,
  CompilerGuardError,
  CompilerPool,
} from "./compiler-pool"
import {
  MAX_SOURCE_BYTES,
  type CompileResult,
  type CompilerConfig,
  type SourceLanguage,
} from "./shared"
import { messageDiagnostic } from "./diagnostics"

const projectRoot = resolve(import.meta.dir, "..")
const distDir = join(projectRoot, "dist")
const csoundSdkPath = resolve(
  projectRoot,
  process.env.CSOUND_WASM_SDK_PATH ?? ".cache/csound-plugin-sdk",
)

function requiredPath(
  name: "WASI_CC" | "WASI_CXX" | "WASI_CXX_LIB_DIR" | "WASI_LD",
): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is missing. Run this command through Nix.`)
    process.exit(1)
  }

  return resolve(projectRoot, value)
}

const compilerConfig: CompilerConfig = {
  csoundSdkPath,
  cCompilerPath: requiredPath("WASI_CC"),
  cppCompilerPath: requiredPath("WASI_CXX"),
  cppLibraryPath: requiredPath("WASI_CXX_LIB_DIR"),
  linkerPath: requiredPath("WASI_LD"),
}

const compilerPool = new CompilerPool(compilerConfig)
const textDecoder = new TextDecoder("utf-8", { fatal: true })

const assetTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function safeHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  })

  if (contentType) {
    headers.set("Content-Type", contentType)
  }

  return headers
}

function compileStatus(result: CompileResult): number {
  if (result.ok) {
    return 200
  }

  if (result.reason === "timeout") {
    return 504
  }

  if (result.reason === "source_limit") {
    return 413
  }

  if (result.reason === "tool_error") {
    return 500
  }

  return 422
}

function compileResponse(result: CompileResult, status = compileStatus(result)): Response {
  const body = new FormData()
  const { wasm, ...meta } = result

  body.set(
    "meta",
    new Blob([JSON.stringify(meta)], { type: "application/json" }),
    "meta.json",
  )

  if (wasm) {
    body.set(
      "plugin",
      new Blob([wasm], { type: "application/wasm" }),
      "plugin.wasm",
    )
  }

  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function errorResult(message: string, timedOut = false): CompileResult {
  return {
    ok: false,
    exitCode: null,
    timedOut,
    diagnostics: [messageDiagnostic(message)],
    output: message,
    durationMs: 0,
    reason: timedOut ? "timeout" : "tool_error",
  }
}

async function compileRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        Allow: "POST",
        ...Object.fromEntries(safeHeaders("text/plain; charset=utf-8")),
      },
    })
  }

  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("text/plain")) {
    return compileResponse(errorResult("Expected text/plain source"), 400)
  }

  const languageValue = request.headers.get("x-plugin-language") ?? "c"
  if (languageValue !== "c" && languageValue !== "cpp") {
    return compileResponse(
      errorResult("Expected X-Plugin-Language to be c or cpp"),
      400,
    )
  }
  const language: SourceLanguage = languageValue

  const contentLength = Number.parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  )
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES) {
    return compileResponse(
      {
        ...errorResult(`Source is larger than ${MAX_SOURCE_BYTES} bytes`),
        reason: "source_limit",
      },
      413,
    )
  }

  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    return compileResponse(
      {
        ...errorResult(`Source is larger than ${MAX_SOURCE_BYTES} bytes`),
        reason: "source_limit",
      },
      413,
    )
  }

  let source: string
  try {
    source = textDecoder.decode(bytes)
  } catch {
    return compileResponse(errorResult("Source must use UTF-8"), 400)
  }

  try {
    const result = await compilerPool.compile(source, language)
    return compileResponse(result)
  } catch (error) {
    if (error instanceof CompilerBusyError) {
      const response = compileResponse(errorResult(error.message), 429)
      response.headers.set("Retry-After", "1")
      return response
    }

    if (error instanceof CompilerGuardError) {
      return compileResponse(errorResult(error.message, true), 504)
    }

    const message = error instanceof Error ? error.message : "Compiler worker failed"
    return compileResponse(errorResult(message), 500)
  }
}

async function healthResponse(): Promise<Response> {
  const checks = [
    {
      name: "clang",
      path: compilerConfig.cCompilerPath,
      mode: constants.X_OK,
    },
    {
      name: "clang++",
      path: compilerConfig.cppCompilerPath,
      mode: constants.X_OK,
    },
    {
      name: "wasm-ld",
      path: compilerConfig.linkerPath,
      mode: constants.X_OK,
    },
    {
      name: "libc++",
      path: compilerConfig.cppLibraryPath,
      mode: constants.R_OK,
    },
    {
      name: "csound.h",
      path: join(csoundSdkPath, "include", "csound", "csound.h"),
      mode: constants.R_OK,
    },
    {
      name: "csdl.h",
      path: join(csoundSdkPath, "include", "csound", "csdl.h"),
      mode: constants.R_OK,
    },
  ]

  const results = await Promise.all(
    checks.map(async (check) => {
      try {
        await access(check.path, check.mode)
        return { name: check.name, ok: true }
      } catch {
        return { name: check.name, ok: false }
      }
    }),
  )

  const ok = results.every((check) => check.ok) && compilerPool.isReady
  return Response.json(
    {
      ok,
      workerReady: compilerPool.isReady,
      queuedJobs: compilerPool.queuedJobs,
      checks: results,
    },
    {
      status: ok ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

async function staticResponse(request: Request, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        ...Object.fromEntries(safeHeaders("text/plain; charset=utf-8")),
      },
    })
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response("Bad path", {
      status: 400,
      headers: safeHeaders("text/plain; charset=utf-8"),
    })
  }

  if (pathname.includes("\0")) {
    return new Response("Bad path", {
      status: 400,
      headers: safeHeaders("text/plain; charset=utf-8"),
    })
  }

  const requestPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
  const candidate = resolve(distDir, requestPath)
  const pathFromDist = relative(distDir, candidate)

  if (
    pathFromDist === ".." ||
    pathFromDist.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(candidate) === resolve(distDir)
  ) {
    return new Response("Not found", {
      status: 404,
      headers: safeHeaders("text/plain; charset=utf-8"),
    })
  }

  let realDist: string
  let realCandidate: string

  try {
    realDist = await realpath(distDir)
    realCandidate = await realpath(candidate)
  } catch {
    return new Response("Not found", {
      status: 404,
      headers: safeHeaders("text/plain; charset=utf-8"),
    })
  }

  const realPathFromDist = relative(realDist, realCandidate)
  if (
    realPathFromDist === ".." ||
    realPathFromDist.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    return new Response("Not found", {
      status: 404,
      headers: safeHeaders("text/plain; charset=utf-8"),
    })
  }

  const fileStat = await stat(realCandidate)
  if (!fileStat.isFile()) {
    return new Response("Not found", {
      status: 404,
      headers: safeHeaders("text/plain; charset=utf-8"),
    })
  }

  const headers = safeHeaders(
    assetTypes[extname(realCandidate).toLowerCase()] ?? "application/octet-stream",
  )
  headers.set("Content-Length", fileStat.size.toString())

  return new Response(request.method === "HEAD" ? null : Bun.file(realCandidate), {
    status: 200,
    headers,
  })
}

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "", 10)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 8787
}

const hostname = process.env.HOST ?? "127.0.0.1"
const port = readPort(process.env.PORT)

const server = Bun.serve({
  hostname,
  port,
  maxRequestBodySize: MAX_SOURCE_BYTES,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/api/compile") {
      return compileRequest(request)
    }

    if (url.pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
          status: 405,
          headers: {
            Allow: "GET, HEAD",
            ...Object.fromEntries(safeHeaders("text/plain; charset=utf-8")),
          },
        })
      }
      const response = await healthResponse()
      return request.method === "HEAD"
        ? new Response(null, {
            status: response.status,
            headers: response.headers,
          })
        : response
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not found", {
        status: 404,
        headers: safeHeaders("text/plain; charset=utf-8"),
      })
    }

    return staticResponse(request, url)
  },
})

console.log(`Csound plugin IDE server listening on ${server.url}`)
