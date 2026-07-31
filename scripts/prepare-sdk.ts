import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { extractCsoundHeaders } from "../src/compiler/sdk-archive"

const projectRoot = resolve(import.meta.dir, "..")
const inputPath = resolve(
  projectRoot,
  "node_modules/@csound/wasm-bin/lib/csound-plugin-sdk.tar.gz"
)
const outputPath = resolve(
  projectRoot,
  ".cache/csound-headers.json.gz"
)

const compressed = new Uint8Array(await Bun.file(inputPath).arrayBuffer())
const headers = extractCsoundHeaders(Bun.gunzipSync(compressed))
const decoder = new TextDecoder()
const textHeaders: Record<string, string> = {}

for (const [name, contents] of Object.entries(headers)) {
  if (!(contents instanceof Uint8Array)) {
    throw new Error(`Csound header ${name} is not a file`)
  }
  textHeaders[name] = decoder.decode(contents)
}

await mkdir(dirname(outputPath), { recursive: true })
await Bun.write(
  outputPath,
  Bun.gzipSync(new TextEncoder().encode(JSON.stringify(textHeaders)))
)

console.log(`Prepared ${Object.keys(textHeaders).length} Csound headers`)
