import { resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import {
  buildDemoCatalog,
  findDemoForPath
} from "../src/demo-catalog"

const fallbacks = {
  c: "default c",
  cpp: "default cpp"
}

describe("demo catalog", () => {
  test("builds demo1 from its C and CSD files", async () => {
    const root = resolve(import.meta.dir, "..")
    const cPath = resolve(root, "demos/demo1/wg-piano.c")
    const csdPath = resolve(root, "demos/demo1/aeolian-harp.csd")
    const demos = buildDemoCatalog({
      "../demos/demo1/wg-piano.c": () => Bun.file(cPath).text(),
      "../demos/demo1/aeolian-harp.csd": () => Bun.file(csdPath).text()
    }, fallbacks)

    expect(demos).toHaveLength(1)
    expect(demos[0]).toEqual(expect.objectContaining({
      slug: "demo1",
      title: "WG Piano · Aeolian Harp",
      sourceFile: "wg-piano.c",
      csdFile: "aeolian-harp.csd"
    }))
    const workspace = await demos[0]?.loadWorkspace()
    expect(workspace?.language).toBe("c")
    expect(workspace?.c).toContain("hlolli_wg_piano")
    expect(workspace?.cpp).toBe(fallbacks.cpp)
    expect(workspace?.csd).toContain("Chopin: Etude in A-flat major")
  })

  test("uses the matching source mode and finds a nested route", async () => {
    const demos = buildDemoCatalog({
      "../demos/filter-bank/filter-bank.cpp": async () => "cpp source",
      "../demos/filter-bank/noise-study.csd": async () => "csd source"
    }, fallbacks)

    expect(await demos[0]?.loadWorkspace()).toEqual({
      c: fallbacks.c,
      cpp: "cpp source",
      csd: "csd source",
      language: "cpp"
    })
    expect(findDemoForPath(demos, "/plugin-compiler/filter-bank/")).toBe(demos[0])
    expect(findDemoForPath(demos, "/plugin-compiler/filter-bank/index.html")).toBe(demos[0])
    expect(findDemoForPath(demos, "/plugin-compiler/")).toBeUndefined()
  })

  test("rejects incomplete and duplicate demo files", () => {
    expect(() => buildDemoCatalog({
      "../demos/no-score/plugin.c": async () => "source"
    }, fallbacks)).toThrow("needs one .csd file")

    expect(() => buildDemoCatalog({
      "../demos/two-sources/one.c": async () => "source one",
      "../demos/two-sources/two.cpp": async () => "source two",
      "../demos/two-sources/test.csd": async () => "score"
    }, fallbacks)).toThrow("more than one .c or .cpp file")
  })
})
