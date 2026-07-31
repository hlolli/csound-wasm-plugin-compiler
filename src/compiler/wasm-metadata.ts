export const OPCODE_WASM_SECTION_NAME = "OPCODE.WASM"
export const OPCODE_WASM_BUILD_HEADER = "Built by OPCODE.WASM"

const WASM_HEADER_SIZE = 8
const CUSTOM_SECTION_ID = 0
const textEncoder = new TextEncoder()

function encodeUnsignedLeb128(value: number): Uint8Array {
  const bytes: number[] = []
  let remaining = value

  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining !== 0)

  return Uint8Array.from(bytes)
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

export function addOpcodeWasmHeader(wasm: ArrayBuffer): ArrayBuffer {
  const source = new Uint8Array(wasm)
  if (!hasWasmHeader(source)) {
    throw new Error("Cannot brand an invalid WebAssembly module")
  }

  const name = textEncoder.encode(OPCODE_WASM_SECTION_NAME)
  const header = textEncoder.encode(OPCODE_WASM_BUILD_HEADER)
  const nameLength = encodeUnsignedLeb128(name.byteLength)
  const contentLength = nameLength.byteLength + name.byteLength + header.byteLength
  const sectionLength = encodeUnsignedLeb128(contentLength)
  const sectionSize = 1 + sectionLength.byteLength + contentLength
  const output = new Uint8Array(source.byteLength + sectionSize)

  output.set(source.subarray(0, WASM_HEADER_SIZE), 0)

  let offset = WASM_HEADER_SIZE
  output[offset] = CUSTOM_SECTION_ID
  offset += 1
  output.set(sectionLength, offset)
  offset += sectionLength.byteLength
  output.set(nameLength, offset)
  offset += nameLength.byteLength
  output.set(name, offset)
  offset += name.byteLength
  output.set(header, offset)
  offset += header.byteLength
  output.set(source.subarray(WASM_HEADER_SIZE), offset)

  return output.buffer
}
