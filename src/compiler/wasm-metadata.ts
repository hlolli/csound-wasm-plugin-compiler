export const OPCODE_WASM_SECTION_NAME = "OPCODE.WASM"
export const OPCODE_WASM_BUILD_HEADER = "Built by OPCODE.WASM"
export const OPCODE_WASM_LOADER_SECTION_NAME = "dylink"

const WASM_HEADER_SIZE = 8
const WASM_IMPORT_SECTION_ID = 2
const WASM_PAGE_SIZE = 65_536
const CUSTOM_SECTION_ID = 0
const textEncoder = new TextEncoder()

interface BinaryReader {
  bytes: Uint8Array
  offset: number
  end: number
}

export interface OpcodeWasmLayout {
  memoryBaseBytes: number
  hostTableEntries: number
}

export interface OpcodeWasmLoaderSize {
  memoryBytes: number
  tableEntries: number
}

function encodeUnsignedLeb128(value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value

  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining !== 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining !== 0)

  return Uint8Array.from(bytes)
}

function readByte(reader: BinaryReader): number {
  if (reader.offset >= reader.end) {
    throw new Error("Unexpected end of WebAssembly data")
  }

  const byte = reader.bytes[reader.offset]
  reader.offset += 1
  return byte
}

function readUnsignedLeb128(reader: BinaryReader): number {
  let value = 0
  let multiplier = 1

  while (true) {
    const byte = readByte(reader)
    value += (byte & 0x7f) * multiplier

    if (!Number.isSafeInteger(value)) {
      throw new Error("WebAssembly value is too large")
    }

    if ((byte & 0x80) === 0) return value

    multiplier *= 128
    if (!Number.isSafeInteger(multiplier)) {
      throw new Error("WebAssembly value is too large")
    }
  }
}

function skipName(reader: BinaryReader): void {
  const length = readUnsignedLeb128(reader)
  reader.offset += length

  if (reader.offset > reader.end) {
    throw new Error("Unexpected end of WebAssembly name")
  }
}

function readLimitsMinimum(reader: BinaryReader): number {
  const flags = readUnsignedLeb128(reader)
  const minimum = readUnsignedLeb128(reader)

  if ((flags & 1) !== 0) readUnsignedLeb128(reader)

  return minimum
}

function readImportMinimums(source: Uint8Array): {
  memoryPages: number
  tableEntries: number
} {
  const reader: BinaryReader = {
    bytes: source,
    offset: WASM_HEADER_SIZE,
    end: source.byteLength
  }
  let memoryPages = 0
  let tableEntries = 0

  while (reader.offset < reader.end) {
    const sectionId = readByte(reader)
    const sectionSize = readUnsignedLeb128(reader)
    const sectionEnd = reader.offset + sectionSize

    if (sectionEnd > reader.end) {
      throw new Error("Unexpected end of WebAssembly section")
    }

    if (sectionId !== WASM_IMPORT_SECTION_ID) {
      reader.offset = sectionEnd
      continue
    }

    const importReader: BinaryReader = {
      bytes: source,
      offset: reader.offset,
      end: sectionEnd
    }
    const importCount = readUnsignedLeb128(importReader)

    for (let index = 0; index < importCount; index += 1) {
      skipName(importReader)
      skipName(importReader)

      const kind = readByte(importReader)
      if (kind === 0) {
        readUnsignedLeb128(importReader)
      } else if (kind === 1) {
        readByte(importReader)
        tableEntries = Math.max(
          tableEntries,
          readLimitsMinimum(importReader)
        )
      } else if (kind === 2) {
        memoryPages = Math.max(
          memoryPages,
          readLimitsMinimum(importReader)
        )
      } else if (kind === 3) {
        readByte(importReader)
        readByte(importReader)
      } else if (kind === 4) {
        readByte(importReader)
        readUnsignedLeb128(importReader)
      } else {
        throw new Error("Unsupported WebAssembly import")
      }
    }

    return { memoryPages, tableEntries }
  }

  return { memoryPages, tableEntries }
}

function hasWasmHeader(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= WASM_HEADER_SIZE &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x61 &&
    bytes[2] === 0x73 &&
    bytes[3] === 0x6d &&
    bytes[4] === 0x01 &&
    bytes[5] === 0x00 &&
    bytes[6] === 0x00 &&
    bytes[7] === 0x00
  )
}

function customSection(nameText: string, content: Uint8Array): Uint8Array {
  const name = textEncoder.encode(nameText)
  const nameLength = encodeUnsignedLeb128(name.byteLength)
  const contentLength = nameLength.byteLength + name.byteLength + content.byteLength
  const sectionLength = encodeUnsignedLeb128(contentLength)
  const section = new Uint8Array(
    1 + sectionLength.byteLength + contentLength
  )

  let offset = 0
  section[offset] = CUSTOM_SECTION_ID
  offset += 1
  section.set(sectionLength, offset)
  offset += sectionLength.byteLength
  section.set(nameLength, offset)
  offset += nameLength.byteLength
  section.set(name, offset)
  offset += name.byteLength
  section.set(content, offset)

  return section
}

export function getOpcodeWasmLoaderSize(
  wasm: ArrayBuffer,
  layout: OpcodeWasmLayout
): OpcodeWasmLoaderSize {
  const source = new Uint8Array(wasm)
  if (!hasWasmHeader(source)) {
    throw new Error("Cannot read an invalid WebAssembly module")
  }

  const { memoryPages, tableEntries } = readImportMinimums(source)
  const memoryBytes = Math.max(
    0,
    memoryPages * WASM_PAGE_SIZE - layout.memoryBaseBytes
  )

  return {
    memoryBytes,
    tableEntries: Math.max(0, tableEntries - layout.hostTableEntries)
  }
}

export function addOpcodeWasmHeader(
  wasm: ArrayBuffer,
  layout: OpcodeWasmLayout
): ArrayBuffer {
  const source = new Uint8Array(wasm)
  if (!hasWasmHeader(source)) {
    throw new Error("Cannot brand an invalid WebAssembly module")
  }

  const loaderSize = getOpcodeWasmLoaderSize(wasm, layout)
  const buildSection = customSection(
    OPCODE_WASM_SECTION_NAME,
    textEncoder.encode(OPCODE_WASM_BUILD_HEADER)
  )
  const loaderSection = customSection(
    OPCODE_WASM_LOADER_SECTION_NAME,
    Uint8Array.from([
      ...encodeUnsignedLeb128(loaderSize.memoryBytes),
      0,
      ...encodeUnsignedLeb128(loaderSize.tableEntries),
      0,
      0
    ])
  )
  const output = new Uint8Array(
    source.byteLength + buildSection.byteLength + loaderSection.byteLength
  )

  output.set(source.subarray(0, WASM_HEADER_SIZE), 0)

  let offset = WASM_HEADER_SIZE
  output.set(buildSection, offset)
  offset += buildSection.byteLength
  output.set(loaderSection, offset)
  offset += loaderSection.byteLength
  output.set(source.subarray(WASM_HEADER_SIZE), offset)

  return output.buffer
}
