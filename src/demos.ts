import {
  buildDemoCatalog,
  findDemoForPath,
  type DemoFileLoader
} from "./demo-catalog"
import {
  DEFAULT_CPP_SOURCE,
  DEFAULT_C_SOURCE
} from "./examples"

const demoFiles = import.meta.glob(
  "../demos/*/*.{c,cpp,csd}",
  {
    import: "default",
    query: "?raw"
  }
) as Record<string, DemoFileLoader>

export const DEMOS = buildDemoCatalog(demoFiles, {
  c: DEFAULT_C_SOURCE,
  cpp: DEFAULT_CPP_SOURCE
})

export const ACTIVE_DEMO = findDemoForPath(DEMOS, window.location.pathname)

export const ACTIVE_DEMO_WORKSPACE = ACTIVE_DEMO
  ? await ACTIVE_DEMO.loadWorkspace()
  : undefined
