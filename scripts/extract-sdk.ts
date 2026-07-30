import { access, mkdir, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const archive = resolve(
  projectRoot,
  "node_modules",
  "@csound",
  "wasm-bin",
  "lib",
  "csound-plugin-sdk.tar.gz"
)
const cacheRoot = resolve(projectRoot, ".cache")
const sdkRoot = resolve(cacheRoot, "csound-plugin-sdk")

try {
  await access(archive, constants.R_OK)
} catch {
  console.error("Csound’s plugin SDK archive is missing. Run bun install first.")
  process.exit(1)
}

await mkdir(cacheRoot, { recursive: true })
await rm(sdkRoot, { recursive: true, force: true })

const extract = Bun.spawn(["tar", "-xzf", archive, "-C", cacheRoot], {
  cwd: projectRoot,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit"
})

const exitCode = await extract.exited
if (exitCode !== 0) {
  console.error("The Csound plugin SDK could not be unpacked.")
  process.exit(exitCode)
}

try {
  await access(resolve(sdkRoot, "include", "csound", "csound.h"), constants.R_OK)
} catch {
  console.error("The archive did not contain the expected Csound headers.")
  process.exit(1)
}

console.log(`Csound plugin SDK ready at ${sdkRoot}`)
