import { describe, expect, test } from "bun:test"
import { deflate, inflate } from "pako"

import {
  DEFAULT_CPP_SOURCE_V1,
  DEFAULT_CSD_SOURCE,
  DEFAULT_C_SOURCE_V1
} from "../src/examples"
import {
  createShareUrl,
  decodeShareHash,
  encodeShareHash,
  SHARE_HASH_PREFIX,
  type ShareWorkspace
} from "../src/share"

const defaultWorkspace: ShareWorkspace = {
  c: DEFAULT_C_SOURCE_V1,
  cpp: DEFAULT_CPP_SOURCE_V1,
  csd: DEFAULT_CSD_SOURCE,
  language: "c"
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

function hashForPayload(payload: unknown): string {
  return `${SHARE_HASH_PREFIX}${bytesToBase64Url(
    deflate(JSON.stringify(payload), { level: 9 })
  )}`
}

function payloadFromHash(hash: string): Record<string, unknown> {
  const encoded = hash.slice(SHARE_HASH_PREFIX.length)
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(encodedLength(hash) / 4) * 4, "=")
  const binary = atob(encoded)
  const compressed = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0)
  )
  return JSON.parse(inflate(compressed, { to: "string" }))
}

function encodedLength(hash: string): number {
  return hash.length - SHARE_HASH_PREFIX.length
}

describe("share links", () => {
  test("omits unchanged C and C++ while keeping the CSD and mode", () => {
    const hash = encodeShareHash(defaultWorkspace)

    expect(payloadFromHash(hash)).toEqual({
      v: 1,
      language: "c",
      csd: DEFAULT_CSD_SOURCE
    })
    expect(decodeShareHash(hash)).toEqual(defaultWorkspace)
  })

  test("keeps C++ as the active mode when both sources are unchanged", () => {
    const workspace = { ...defaultWorkspace, language: "cpp" as const }

    expect(decodeShareHash(encodeShareHash(workspace))).toEqual(workspace)
  })

  test("shares changes from both source modes", () => {
    const workspace: ShareWorkspace = {
      c: `${DEFAULT_C_SOURCE_V1}\n/* C edit */`,
      cpp: `${DEFAULT_CPP_SOURCE_V1}\n// C++ edit`,
      csd: DEFAULT_CSD_SOURCE.replace("0.18", "0.25"),
      language: "cpp"
    }
    const hash = encodeShareHash(workspace)

    expect(payloadFromHash(hash)).toEqual({
      v: 1,
      language: "cpp",
      csd: workspace.csd,
      c: workspace.c,
      cpp: workspace.cpp
    })
    expect(decodeShareHash(hash)).toEqual(workspace)
  })

  test("keeps empty source and exact byte changes", () => {
    const variants = [
      "",
      DEFAULT_C_SOURCE_V1.replaceAll("\n", "\r\n"),
      `${DEFAULT_C_SOURCE_V1} `,
      DEFAULT_C_SOURCE_V1.slice(0, -1)
    ]

    for (const c of variants) {
      const hash = encodeShareHash({ ...defaultWorkspace, c })
      expect(payloadFromHash(hash).c).toBe(c)
      expect(decodeShareHash(hash)?.c).toBe(c)
    }
  })

  test("round trips Unicode text", () => {
    const workspace = {
      ...defaultWorkspace,
      cpp: `${DEFAULT_CPP_SOURCE_V1}\nconst char *name = "Σύνθεση 音";`,
      csd: `${DEFAULT_CSD_SOURCE}\n; Halló heimur`
    }

    expect(decodeShareHash(encodeShareHash(workspace))).toEqual(workspace)
  })

  test("uses unpadded URL safe Base64", () => {
    const hash = encodeShareHash(defaultWorkspace)
    const encoded = hash.slice(SHARE_HASH_PREFIX.length)

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(encoded).not.toContain("=")
  })

  test("matches a fixed Mermaid style Pako fixture", () => {
    const workspace = { ...defaultWorkspace, csd: "" }
    const hash = "#pako:eNqrVipTsjLUUcpJzEsvTUxPVbJSSlbSUUouTgGylGoBkaQI2w"

    expect(encodeShareHash(workspace)).toBe(hash)
    expect(decodeShareHash(hash)).toEqual(workspace)
  })

  test("keeps the current deployed path and query", () => {
    const url = createShareUrl(
      defaultWorkspace,
      "https://hlolli.github.io/plugin-compiler/?view=wide#old"
    )
    const parsed = new URL(url)

    expect(parsed.pathname).toBe("/plugin-compiler/")
    expect(parsed.search).toBe("?view=wide")
    expect(parsed.hash.startsWith(SHARE_HASH_PREFIX)).toBe(true)
    expect(decodeShareHash(parsed.hash)).toEqual(defaultWorkspace)
  })

  test("ignores hashes that do not contain a share", () => {
    expect(decodeShareHash("")).toBeNull()
    expect(decodeShareHash("#section")).toBeNull()
  })

  test("rejects malformed and unsupported payloads", () => {
    expect(() => decodeShareHash("#pako:not_base64!"))
      .toThrow("Share link data is not valid")
    expect(() => decodeShareHash("#pako:bm90IHpsaWI"))
      .toThrow("Share link data is not valid")
    expect(() => decodeShareHash(hashForPayload({ v: 2 })))
      .toThrow("Share link version is not supported")
    expect(() => decodeShareHash(hashForPayload({
      v: 1,
      language: "rust",
      csd: ""
    }))).toThrow("Share link language is not valid")
    expect(() => decodeShareHash(hashForPayload({
      v: 1,
      language: "c",
      csd: null
    }))).toThrow("Share link CSD is not valid")
    expect(() => decodeShareHash(hashForPayload({
      v: 1,
      language: "c",
      csd: "",
      c: 3
    }))).toThrow("Share link C source is not valid")
  })

  test("stops compressed payloads that expand past the limit", () => {
    const hash = hashForPayload({
      v: 1,
      language: "c",
      csd: "a".repeat(1024 * 1024)
    })

    expect(() => decodeShareHash(hash))
      .toThrow("Share link data is larger than 1 MiB")
  })
})
