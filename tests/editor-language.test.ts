import { describe, expect, test } from "bun:test"
import { csdLanguage } from "@hlolli/codemirror-lang-csound"

import { DEFAULT_CSD_SOURCE } from "../src/examples"

describe("Csound editor language", () => {
  test("parses the bundled CSD without error nodes", () => {
    const tree = csdLanguage.parser.parse(DEFAULT_CSD_SOURCE)
    const errors: Array<{ from: number; to: number }> = []

    tree.iterate({
      enter(node) {
        if (node.type.isError) {
          errors.push({ from: node.from, to: node.to })
        }
      }
    })

    expect(tree.length).toBe(DEFAULT_CSD_SOURCE.length)
    expect(errors).toEqual([])
  })
})
