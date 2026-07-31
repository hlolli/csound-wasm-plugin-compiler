import { deflate, Inflate } from "pako"

import {
  DEFAULT_CPP_SOURCE_V1,
  DEFAULT_C_SOURCE_V1
} from "./examples"

export const SHARE_HASH_PREFIX = "#pako:"
export const SHARE_URL_WARNING_LENGTH = 64 * 1024

const SHARE_VERSION = 1
const MAX_SHARE_HASH_LENGTH = 1_500_000
const MAX_SHARE_JSON_BYTES = 1024 * 1024
const textDecoder = new TextDecoder("utf-8", { fatal: true })
const textEncoder = new TextEncoder()

export interface ShareWorkspace {
  c: string
  cpp: string
  csd: string
  language: "c" | "cpp"
}

interface SharePayloadV1 {
  v: 1
  language: "c" | "cpp"
  csd: string
  c?: string
  cpp?: string
}

export class ShareLinkError extends Error {
  override name = "ShareLinkError"
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 32 * 1024

  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function fromBase64Url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ShareLinkError("Share link data is not valid")
  }

  const standard = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=")

  let binary: string
  try {
    binary = atob(standard)
  } catch {
    throw new ShareLinkError("Share link data is not valid")
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function inflateWithLimit(compressed: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const inflater = new Inflate({ chunkSize: 32 * 1024 })

  inflater.onData = (chunk) => {
    const bytes = chunk instanceof Uint8Array
      ? chunk
      : new Uint8Array(chunk)
    byteLength += bytes.byteLength

    if (byteLength > MAX_SHARE_JSON_BYTES) {
      throw new ShareLinkError("Share link data is larger than 1 MiB")
    }

    chunks.push(bytes.slice())
  }

  try {
    const finished = inflater.push(compressed, true)
    if (!finished || inflater.err) {
      throw new ShareLinkError("Share link data is not valid")
    }
  } catch (error) {
    if (error instanceof ShareLinkError) throw error
    throw new ShareLinkError("Share link data is not valid")
  }

  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }

  return output
}

function payloadFor(workspace: ShareWorkspace): SharePayloadV1 {
  const payload: SharePayloadV1 = {
    v: SHARE_VERSION,
    language: workspace.language,
    csd: workspace.csd
  }

  if (workspace.c !== DEFAULT_C_SOURCE_V1) payload.c = workspace.c
  if (workspace.cpp !== DEFAULT_CPP_SOURCE_V1) payload.cpp = workspace.cpp

  return payload
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function workspaceFrom(value: unknown): ShareWorkspace {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ShareLinkError("Share link content is not valid")
  }

  const payload = value as Record<string, unknown>
  if (!hasOwn(payload, "v") || payload.v !== SHARE_VERSION) {
    throw new ShareLinkError("Share link version is not supported")
  }
  if (
    !hasOwn(payload, "language") ||
    (payload.language !== "c" && payload.language !== "cpp")
  ) {
    throw new ShareLinkError("Share link language is not valid")
  }
  if (!hasOwn(payload, "csd") || typeof payload.csd !== "string") {
    throw new ShareLinkError("Share link CSD is not valid")
  }
  const hasC = hasOwn(payload, "c")
  const hasCpp = hasOwn(payload, "cpp")
  if (hasC && typeof payload.c !== "string") {
    throw new ShareLinkError("Share link C source is not valid")
  }
  if (hasCpp && typeof payload.cpp !== "string") {
    throw new ShareLinkError("Share link C++ source is not valid")
  }

  return {
    c: hasC ? payload.c as string : DEFAULT_C_SOURCE_V1,
    cpp: hasCpp ? payload.cpp as string : DEFAULT_CPP_SOURCE_V1,
    csd: payload.csd,
    language: payload.language
  }
}

export function encodeShareHash(workspace: ShareWorkspace): string {
  const json = textEncoder.encode(JSON.stringify(payloadFor(workspace)))
  if (json.byteLength > MAX_SHARE_JSON_BYTES) {
    throw new ShareLinkError("Share link data is larger than 1 MiB")
  }

  const encoded = toBase64Url(deflate(json, { level: 9 }))
  const hash = `${SHARE_HASH_PREFIX}${encoded}`
  if (hash.length > MAX_SHARE_HASH_LENGTH) {
    throw new ShareLinkError("Share link is too long")
  }

  return hash
}

export function decodeShareHash(hash: string): ShareWorkspace | null {
  if (!hash.startsWith(SHARE_HASH_PREFIX)) return null
  if (hash.length > MAX_SHARE_HASH_LENGTH) {
    throw new ShareLinkError("Share link is too long")
  }

  const compressed = fromBase64Url(hash.slice(SHARE_HASH_PREFIX.length))
  const bytes = inflateWithLimit(compressed)

  let value: unknown
  try {
    value = JSON.parse(textDecoder.decode(bytes))
  } catch {
    throw new ShareLinkError("Share link content is not valid")
  }

  return workspaceFrom(value)
}

export function createShareUrl(
  workspace: ShareWorkspace,
  currentUrl: string | URL
): string {
  const url = new URL(currentUrl)
  url.hash = encodeShareHash(workspace)
  return url.toString()
}
