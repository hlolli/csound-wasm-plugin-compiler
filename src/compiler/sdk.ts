import type { Tree } from "@yowasp/clang"

import headersUrl from "../../.cache/csound-headers.json.gz?url"

async function fetchHeaders(): Promise<Record<string, string>> {
  const response = await fetch(headersUrl)
  if (!response.ok) {
    throw new Error(`Could not load the Csound headers · HTTP ${response.status}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b
  const contents = isGzip
    ? await new Response(
        new Blob([bytes]).stream().pipeThrough(
          new DecompressionStream("gzip")
        )
      ).text()
    : new TextDecoder().decode(bytes)

  const headers = JSON.parse(contents) as Record<string, string>
  if (!headers["csound.h"] || !headers["csdl.h"] || !headers["modload.h"]) {
    throw new Error("The Csound header set is incomplete")
  }
  return headers
}

export async function loadCsoundHeaders(): Promise<Tree> {
  return fetchHeaders()
}
