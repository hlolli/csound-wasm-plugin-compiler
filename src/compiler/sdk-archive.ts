import type { Tree } from "@yowasp/clang"

const TAR_BLOCK_BYTES = 512
const HEADER_PREFIX = "csound-plugin-sdk/include/csound/"

function readTarText(bytes: Uint8Array, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end))
}

function readTarSize(bytes: Uint8Array, offset: number): number {
  const value = readTarText(bytes, offset, 12).trim()
  return value ? Number.parseInt(value, 8) : 0
}

export function extractCsoundHeaders(archive: Uint8Array): Tree {
  const headers: Tree = {}
  let offset = 0

  while (offset + TAR_BLOCK_BYTES <= archive.byteLength) {
    const name = readTarText(archive, offset, 100)
    if (!name) break

    const size = readTarSize(archive, offset + 124)
    const type = archive[offset + 156]
    const contentStart = offset + TAR_BLOCK_BYTES

    if (
      type !== 53 &&
      name.startsWith(HEADER_PREFIX) &&
      !name.slice(HEADER_PREFIX.length).includes("/")
    ) {
      const headerName = name.slice(HEADER_PREFIX.length)
      headers[headerName] = new Uint8Array(
        archive.subarray(contentStart, contentStart + size)
      )
    }

    offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES
  }

  if (!headers["csound.h"] || !headers["csdl.h"] || !headers["modload.h"]) {
    throw new Error("The Csound header archive is incomplete")
  }

  return headers
}
