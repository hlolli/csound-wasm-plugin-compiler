import { describe, expect, test } from "bun:test"

import {
  addOpcodeWasmHeader,
  OPCODE_WASM_BUILD_HEADER,
  OPCODE_WASM_SECTION_NAME,
} from "../src/compiler/wasm-metadata"

const minimalWasm = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
]).buffer

describe("OPCODE.WASM metadata", () => {
  test("adds a readable custom section after the Wasm header", async () => {
    const branded = addOpcodeWasmHeader(minimalWasm)
    const bytes = new Uint8Array(branded)
    const module = await WebAssembly.compile(branded)
    const sections = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME,
    )

    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
    ])
    expect(bytes[8]).toBe(0)
    expect(sections).toHaveLength(1)
    expect(new TextDecoder().decode(sections[0])).toBe(
      OPCODE_WASM_BUILD_HEADER,
    )
  })

  test("rejects data without a WebAssembly header", () => {
    expect(() => addOpcodeWasmHeader(new Uint8Array([1, 2, 3]).buffer)).toThrow(
      "Cannot brand an invalid WebAssembly module",
    )
  })
})
