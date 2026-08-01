import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig, type Plugin } from "vite"

import {
  buildDemoCatalog,
  type DemoFileLoader
} from "./src/demo-catalog"

const projectRoot = dirname(fileURLToPath(import.meta.url))
const demoRoot = resolve(projectRoot, "demos")

function discoverDemoSlugs(): string[] {
  if (!existsSync(demoRoot)) return []

  const demoFiles: Record<string, DemoFileLoader> = {}
  for (const entry of readdirSync(demoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = resolve(demoRoot, entry.name)
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile() || !/\.(?:c|cpp|csd)$/u.test(file.name)) continue
      demoFiles[`../demos/${entry.name}/${file.name}`] = async () => ""
    }
  }

  return buildDemoCatalog(demoFiles, { c: "", cpp: "" })
    .map((demo) => demo.slug)
}

function demoRoutes(): Plugin {
  const slugs = discoverDemoSlugs()
  let outputDirectory = resolve(projectRoot, "dist")

  return {
    name: "opcode-wasm-demo-routes",
    configResolved(config) {
      outputDirectory = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      const routes = new Set(slugs.flatMap((slug) => [
        `/${slug}`,
        `/${slug}/`,
        `/${slug}/index.html`
      ]))

      server.middlewares.use((request, _response, next) => {
        if (!request.url) return next()
        const url = new URL(request.url, "http://127.0.0.1")
        if (routes.has(url.pathname)) {
          request.url = `/index.html${url.search}`
        }
        next()
      })
    },
    closeBundle() {
      const rootIndex = resolve(outputDirectory, "index.html")
      const html = readFileSync(rootIndex, "utf8")
      const nestedHtml = html.replace(
        "<head>",
        '<head>\n    <base href="../">'
      )

      for (const slug of slugs) {
        const routeDirectory = resolve(outputDirectory, slug)
        mkdirSync(routeDirectory, { recursive: true })
        writeFileSync(resolve(routeDirectory, "index.html"), nestedHtml)
      }
    }
  }
}

export default defineConfig({
  base: "./",
  plugins: [demoRoutes()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  preview: {
    host: "127.0.0.1",
    port: 4173
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 3000
  }
})
