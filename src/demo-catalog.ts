import type { EditorWorkspace, SourceLanguage } from "./editors"

export interface DemoFallbackSources {
  c: string
  cpp: string
}

export type DemoFileLoader = () => Promise<string>

export interface DemoDefinition {
  slug: string
  title: string
  sourceFile: string
  csdFile: string
  language: SourceLanguage
  loadWorkspace: () => Promise<EditorWorkspace>
}

interface DemoSourceFile {
  fileName: string
  language: SourceLanguage
  load: DemoFileLoader
}

interface PendingDemo {
  slug: string
  source?: DemoSourceFile
  csd?: {
    fileName: string
    load: DemoFileLoader
  }
}

const DEMO_PATH = /(?:^|\/)demos\/([^/]+)\/([^/]+)\.(c|cpp|csd)$/u
const DEMO_SLUG = /^[a-z0-9][a-z0-9-]*$/u
const UPPERCASE_TOKENS = new Set(["dsp", "fm", "midi", "wasm", "wg"])

function humanizeStem(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/u, "")
  return stem
    .split(/[-_.\s]+/u)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLocaleLowerCase("en")
      if (lower.length <= 2 || UPPERCASE_TOKENS.has(lower)) {
        return lower.toLocaleUpperCase("en")
      }
      return `${lower[0]?.toLocaleUpperCase("en") ?? ""}${lower.slice(1)}`
    })
    .join(" ")
}

function demoTitle(sourceFile: string, csdFile: string): string {
  const sourceTitle = humanizeStem(sourceFile)
  const csdTitle = humanizeStem(csdFile)
  return sourceTitle === csdTitle
    ? sourceTitle
    : `${sourceTitle} · ${csdTitle}`
}

export function buildDemoCatalog(
  files: Readonly<Record<string, DemoFileLoader>>,
  fallbacks: DemoFallbackSources
): DemoDefinition[] {
  const pending = new Map<string, PendingDemo>()

  for (const [path, load] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right, "en")
  )) {
    const match = DEMO_PATH.exec(path)
    if (!match) {
      throw new Error(`Demo file path is not supported: ${path}`)
    }

    const [, slug = "", stem = "", extension = ""] = match
    if (!DEMO_SLUG.test(slug)) {
      throw new Error(`Demo folder must use lower-case letters, numbers, and dashes: ${slug}`)
    }

    const fileName = `${stem}.${extension}`
    const demo = pending.get(slug) ?? { slug }
    pending.set(slug, demo)

    if (extension === "csd") {
      if (demo.csd) {
        throw new Error(`Demo ${slug} has more than one .csd file`)
      }
      demo.csd = { fileName, load }
      continue
    }

    if (demo.source) {
      throw new Error(`Demo ${slug} has more than one .c or .cpp file`)
    }
    demo.source = {
      fileName,
      language: extension === "cpp" ? "cpp" : "c",
      load
    }
  }

  return [...pending.values()]
    .sort((left, right) => left.slug.localeCompare(right.slug, "en"))
    .map((demo) => {
      if (!demo.source) {
        throw new Error(`Demo ${demo.slug} needs one .c or .cpp file`)
      }
      if (!demo.csd) {
        throw new Error(`Demo ${demo.slug} needs one .csd file`)
      }

      const source = demo.source
      const csd = demo.csd

      return {
        slug: demo.slug,
        title: demoTitle(source.fileName, csd.fileName),
        sourceFile: source.fileName,
        csdFile: csd.fileName,
        language: source.language,
        loadWorkspace: async () => {
          const [sourceContent, csdContent] = await Promise.all([
            source.load(),
            csd.load()
          ])
          return {
            c: source.language === "c" ? sourceContent : fallbacks.c,
            cpp: source.language === "cpp" ? sourceContent : fallbacks.cpp,
            csd: csdContent,
            language: source.language
          }
        }
      }
    })
}

export function findDemoForPath(
  demos: readonly DemoDefinition[],
  pathname: string
): DemoDefinition | undefined {
  const cleanPath = pathname.replace(/\/index\.html$/u, "/")
  const segments = cleanPath.split("/").filter(Boolean)
  const slug = segments.at(-1)
  return demos.find((demo) => demo.slug === slug)
}
