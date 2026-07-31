import { describe, expect, test } from "bun:test"
import type { CsoundObj, PublicEvents } from "@csound/browser"

import {
  AUDIO_EXPORT_FILE_NAME,
  AudioRenderError,
  CsoundAudioRenderer,
  prepareOfflineCsd,
  readWavInfo
} from "../src/audio-render"

function makeWav(options: {
  channels: number
  sampleRate: number
  bitDepth: number
  frames: number
}): ArrayBuffer {
  const bytesPerSample = options.bitDepth / 8
  const dataSize = options.frames * options.channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  const writeName = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index)
    }
  }

  writeName(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeName(8, "WAVE")
  writeName(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, options.channels, true)
  view.setUint32(24, options.sampleRate, true)
  view.setUint32(
    28,
    options.sampleRate * options.channels * bytesPerSample,
    true
  )
  view.setUint16(32, options.channels * bytesPerSample, true)
  view.setUint16(34, options.bitDepth, true)
  writeName(36, "data")
  view.setUint32(40, dataSize, true)
  return buffer
}

function validWasm(): ArrayBuffer {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00
  ]).buffer
}

function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const checkAgain = () => {
      if (check()) {
        resolve()
        return
      }
      if (performance.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for audio render state"))
        return
      }
      setTimeout(checkAgain, 1)
    }
    checkAgain()
  })
}

function fakeRendererCsound(options: {
  endRender?: boolean
  message?: string
  messages?: string[]
  terminate?: () => Promise<void>
  wav?: Uint8Array
} = {}) {
  const listeners = new Map<PublicEvents, Set<(...args: unknown[]) => void>>()
  const calls: string[] = []
  let terminateCalls = 0

  const emit = (event: PublicEvents) => {
    for (const listener of listeners.get(event) ?? []) listener()
  }
  const csound = {
    compileCSD: async () => {
      calls.push("compile")
      return 0
    },
    start: async () => {
      calls.push("start")
      queueMicrotask(() => {
        for (const message of [
          ...(options.message ? [options.message] : []),
          ...(options.messages ?? [])
        ]) {
          for (const listener of listeners.get("message") ?? []) {
            listener(message)
          }
        }
        if (options.endRender !== false) emit("renderEnded")
      })
      return 0
    },
    stop: async () => {
      calls.push("stop")
      emit("renderEnded")
      return 0
    },
    reset: async () => {
      calls.push("reset")
      return 0
    },
    terminateInstance: () => {
      calls.push("terminate")
      terminateCalls += 1
      return options.terminate?.() ?? Promise.resolve()
    },
    removeListener: (event: PublicEvents, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
    },
    on: (event: PublicEvents, listener: (...args: unknown[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    },
    off: (event: PublicEvents, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
    },
    fs: {
      readFile: async () => {
        calls.push("read")
        return options.wav ?? new Uint8Array(makeWav({
          channels: 2,
          sampleRate: 48_000,
          bitDepth: 16,
          frames: 48_000
        }))
      }
    }
  } as unknown as CsoundObj

  return {
    csound,
    calls,
    terminateCalls: () => terminateCalls
  }
}

describe("audio export CSD", () => {
  test("changes real-time output to a WAV file", () => {
    const csd = `<CsoundSynthesizer>
<CsOptions>
-odac -iadc -d -m128 --sample-accurate
</CsOptions>
</CsoundSynthesizer>`
    const result = prepareOfflineCsd(csd)

    expect(result).toContain(`-W -o${AUDIO_EXPORT_FILE_NAME}`)
    expect(result).toContain("-d -m128 --sample-accurate")
    expect(result).not.toContain("-odac")
    expect(result).not.toContain("-iadc")
  })

  test("replaces an existing file output and no-sound flag", () => {
    const csd = `<CsoundSynthesizer>
<CsOptions>-o old.aiff --output=other.wav -n -A -d</CsOptions>
</CsoundSynthesizer>`
    const result = prepareOfflineCsd(csd, "new.wav")

    expect(result).toContain("-W -onew.wav\n-d")
    expect(result).not.toContain("old.aiff")
    expect(result).not.toContain("other.wav")
    expect(result).not.toContain(" -n ")
    expect(result).not.toContain(" -A ")
  })

  test("adds CsOptions when the document has none", () => {
    const result = prepareOfflineCsd(
      "<CsoundSynthesizer>\n<CsInstruments/>\n</CsoundSynthesizer>"
    )

    expect(result).toContain(
      `<CsOptions>\n-W -o${AUDIO_EXPORT_FILE_NAME}\n</CsOptions>`
    )
  })

  test("keeps comments from hiding the forced WAV options", () => {
    const csd = `<CsoundSynthesizer>
<CsOptions>
; use the DAC while editing
-odac -d ; quiet display
</CsOptions>
</CsoundSynthesizer>`
    const result = prepareOfflineCsd(csd)
    const options = result.match(/<CsOptions>([\s\S]*?)<\/CsOptions>/)?.[1]

    expect(options?.trimStart().startsWith(
      `-W -o${AUDIO_EXPORT_FILE_NAME}`
    )).toBe(true)
    expect(options).toContain("; use the DAC while editing")
    expect(options).toContain("-d ; quiet display")
    expect(options).not.toContain("-odac")
  })

  test("puts forced output before the end of option marker", () => {
    const csd = `<CsoundSynthesizer>
<CsOptions>-d -- score.sco</CsOptions>
</CsoundSynthesizer>`
    const result = prepareOfflineCsd(csd)
    const options = result.match(/<CsOptions>([\s\S]*?)<\/CsOptions>/)?.[1] ?? ""

    expect(options.indexOf(`-W -o${AUDIO_EXPORT_FILE_NAME}`)).toBeLessThan(
      options.indexOf("--")
    )
    expect(options).toContain("-d -- score.sco")
  })

  test("rejects text that is not a CSD", () => {
    expect(() => prepareOfflineCsd("instr 1\nendin")).toThrow(
      AudioRenderError
    )
  })
})

describe("WAV metadata", () => {
  test("reads channel, sample, depth, and duration data", () => {
    const info = readWavInfo(makeWav({
      channels: 2,
      sampleRate: 48_000,
      bitDepth: 16,
      frames: 96_000
    }))

    expect(info).toEqual({
      channels: 2,
      sampleRate: 48_000,
      bitDepth: 16,
      durationSeconds: 2
    })
  })

  test("rejects a non-WAV buffer", () => {
    expect(() => readWavInfo(new ArrayBuffer(44))).toThrow(AudioRenderError)
  })
})

describe("Csound audio renderer", () => {
  test("resets Csound before reading the final WAV", async () => {
    const fake = fakeRendererCsound()
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => fake.csound
    })

    const result = await renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )

    expect(result.durationSeconds).toBe(1)
    expect(fake.calls.indexOf("reset")).toBeLessThan(fake.calls.indexOf("read"))
    expect(fake.calls.at(-1)).toBe("terminate")
    expect(renderer.canStop).toBe(false)
  })

  test("Stop rejects an infinite render and closes its worker", async () => {
    const fake = fakeRendererCsound({ endRender: false })
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => fake.csound,
      renderTimeoutMs: 5_000
    })
    const renderTask = renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )

    await waitFor(() => renderer.state === "rendering")
    await renderer.stop()
    await expect(renderTask).rejects.toMatchObject({ name: "AbortError" })
    expect(fake.terminateCalls()).toBe(1)
    expect(renderer.state).toBe("idle")
    expect(renderer.canStop).toBe(false)
  })

  test("times out an infinite render", async () => {
    const fake = fakeRendererCsound({ endRender: false })
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => fake.csound,
      renderTimeoutMs: 50
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({ code: "render-failed" })
    expect(fake.terminateCalls()).toBe(1)
    expect(renderer.state).toBe("error")
  })

  test("applies the render limit while Csound compiles", async () => {
    const fake = fakeRendererCsound()
    const csound = fake.csound as CsoundObj
    csound.compileCSD = async () => new Promise<number>(() => undefined)
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => csound,
      renderTimeoutMs: 50
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({
      code: "render-failed",
      message: expect.stringContaining("exceeded")
    })
    expect(fake.terminateCalls()).toBe(1)
  })

  test("closes a renderer that finishes loading after the render limit", async () => {
    let finishLoading!: (csound: CsoundObj) => void
    const loading = new Promise<CsoundObj>((resolve) => {
      finishLoading = resolve
    })
    const fake = fakeRendererCsound()
    const renderer = new CsoundAudioRenderer({
      createCsound: () => loading,
      renderTimeoutMs: 50
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({
      code: "render-failed",
      message: expect.stringContaining("exceeded")
    })

    finishLoading(fake.csound)
    await waitFor(() => fake.terminateCalls() === 1 && !renderer.canStop)
  })

  test("applies the render limit while reading the WAV", async () => {
    const fake = fakeRendererCsound()
    const csound = fake.csound as CsoundObj
    csound.fs.readFile = async () => new Promise<Uint8Array>(() => undefined)
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => csound,
      renderTimeoutMs: 50
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({
      code: "render-failed",
      message: expect.stringContaining("exceeded")
    })
    expect(fake.terminateCalls()).toBe(1)
  })

  test("rejects a missing worker file", async () => {
    const fake = fakeRendererCsound({ wav: undefined })
    const csound = fake.csound as CsoundObj
    csound.fs.readFile = async () => undefined as unknown as Uint8Array
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => csound
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({ code: "render-failed" })
  })

  test("rejects Csound performance errors", async () => {
    const fake = fakeRendererCsound({
      message: "PERF ERROR in instr 1: plugin failed"
    })
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => fake.csound
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({
      code: "render-failed",
      message: expect.stringContaining("PERF ERROR")
    })
  })

  test("keeps the first performance error after long Csound output", async () => {
    const fake = fakeRendererCsound({
      messages: [
        "PERF ERROR in instr 1: plugin failed",
        ...Array.from({ length: 25 }, (_, index) => `later message ${index}`)
      ]
    })
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => fake.csound
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({
      code: "render-failed",
      message: expect.stringContaining("PERF ERROR")
    })
  })

  test("keeps a timed out worker close reachable", async () => {
    let finishClose!: () => void
    const closeTask = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    const fake = fakeRendererCsound({ terminate: () => closeTask })
    const renderer = new CsoundAudioRenderer({
      createCsound: async () => fake.csound,
      stopTimeoutMs: 200
    })

    await expect(renderer.render(
      validWasm(),
      "<CsoundSynthesizer><CsOptions>-odac</CsOptions></CsoundSynthesizer>"
    )).rejects.toMatchObject({ code: "stop-failed" })
    expect(renderer.canStop).toBe(true)

    finishClose()
    await waitFor(() => !renderer.canStop)
    expect(fake.terminateCalls()).toBe(1)
  })
})
