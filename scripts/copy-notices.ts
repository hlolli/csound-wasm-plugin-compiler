import { copyFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..")
const outputRoot = resolve(projectRoot, "dist")
const licenseRoot = resolve(outputRoot, "licenses")

await mkdir(licenseRoot, { recursive: true })
await Promise.all([
  copyFile(
    resolve(projectRoot, "THIRD_PARTY_NOTICES.md"),
    resolve(outputRoot, "THIRD_PARTY_NOTICES.md")
  ),
  copyFile(
    resolve(projectRoot, "node_modules/pako/LICENSE"),
    resolve(licenseRoot, "pako-MIT.txt")
  ),
  copyFile(
    resolve(projectRoot, "node_modules/pako/lib/zlib/README"),
    resolve(licenseRoot, "pako-Zlib.txt")
  )
])
