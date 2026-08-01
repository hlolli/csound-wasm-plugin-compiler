import { expect, test } from "bun:test"

import config from "../vite.config"

test("keeps browser Clang out of Vite dependency optimization", () => {
  expect(config.optimizeDeps?.exclude).toContain("@yowasp/clang")
})
