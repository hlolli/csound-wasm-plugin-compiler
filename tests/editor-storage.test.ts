import { describe, expect, test } from "bun:test"

import {
  CSD_SOURCE_STORAGE_KEY,
  CPP_SOURCE_STORAGE_KEY,
  C_SOURCE_STORAGE_KEY,
  editorStorageKeys,
  SOURCE_LANGUAGE_STORAGE_KEY
} from "../src/editors"

describe("editor storage keys", () => {
  test("keeps the root workbench keys stable", () => {
    expect(editorStorageKeys()).toEqual({
      c: C_SOURCE_STORAGE_KEY,
      cpp: CPP_SOURCE_STORAGE_KEY,
      csd: CSD_SOURCE_STORAGE_KEY,
      language: SOURCE_LANGUAGE_STORAGE_KEY
    })
  })

  test("isolates each demo workspace", () => {
    expect(editorStorageKeys("demo.demo1")).toEqual({
      c: "csoundOpcodeWorkbench.demo.demo1.cSource.v1",
      cpp: "csoundOpcodeWorkbench.demo.demo1.cppSource.v1",
      csd: "csoundOpcodeWorkbench.demo.demo1.csdSource.v1",
      language: "csoundOpcodeWorkbench.demo.demo1.sourceLanguage.v1"
    })
  })
})
