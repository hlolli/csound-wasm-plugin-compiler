import { describe, expect, test } from "bun:test"

import {
  addOpcodeWasmHeader,
  getOpcodeWasmLoaderSize,
  OPCODE_WASM_BUILD_HEADER,
  OPCODE_WASM_LOADER_SECTION_NAME,
  OPCODE_WASM_SECTION_NAME,
} from "../src/compiler/wasm-metadata"

const browserLayout = {
  memoryBaseBytes: 128 * 1024 * 1024,
  hostTableEntries: 3837,
}

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

const importedMemoryAndTableWasm = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  0x02,
  0x1f,
  0x02,
  0x03,
  0x65,
  0x6e,
  0x76,
  0x06,
  0x6d,
  0x65,
  0x6d,
  0x6f,
  0x72,
  0x79,
  0x02,
  0x00,
  0x83,
  0x10,
  0x03,
  0x65,
  0x6e,
  0x76,
  0x05,
  0x74,
  0x61,
  0x62,
  0x6c,
  0x65,
  0x01,
  0x70,
  0x00,
  0x84,
  0x20,
]).buffer

describe("OPCODE.WASM metadata", () => {
  test("adds a readable custom section after the Wasm header", async () => {
    const branded = addOpcodeWasmHeader(minimalWasm, browserLayout)
    const bytes = new Uint8Array(branded)
    const module = await WebAssembly.compile(branded)
    const sections = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_SECTION_NAME,
    )
    const loaderSections = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_LOADER_SECTION_NAME,
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
    expect(loaderSections).toHaveLength(1)
    expect(Array.from(new Uint8Array(loaderSections[0]))).toEqual([
      0,
      0,
      0,
      0,
      0,
    ])
  })

  test("derives loader space from imported memory and table limits", async () => {
    expect(await WebAssembly.compile(importedMemoryAndTableWasm)).toBeTruthy()
    expect(
      getOpcodeWasmLoaderSize(importedMemoryAndTableWasm, browserLayout),
    ).toEqual({
      memoryBytes: 3 * 65_536,
      tableEntries: 263,
    })

    const branded = addOpcodeWasmHeader(
      importedMemoryAndTableWasm,
      browserLayout,
    )
    const module = await WebAssembly.compile(branded)
    const loaderSections = WebAssembly.Module.customSections(
      module,
      OPCODE_WASM_LOADER_SECTION_NAME,
    )

    expect(Array.from(new Uint8Array(loaderSections[0]))).toEqual([
      0x80,
      0x80,
      0x0c,
      0,
      0x87,
      0x02,
      0,
      0,
    ])
  })

  test("rejects data without a WebAssembly header", () => {
    expect(() =>
      addOpcodeWasmHeader(new Uint8Array([1, 2, 3]).buffer, browserLayout),
    ).toThrow("Cannot brand an invalid WebAssembly module")
  })
})
