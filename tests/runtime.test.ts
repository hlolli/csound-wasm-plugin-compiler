import { describe, expect, mock, test } from "bun:test"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

interface FakeCsoundOptions {
  compileError?: Error
  startError?: Error
  termination?: Promise<void>
}

interface FakeCsound {
  compileCSD: () => Promise<number>
  start: () => Promise<number>
  stop: () => Promise<number>
  terminateInstance: () => Promise<void>
  removeListener: () => void
  on: () => void
  off: () => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeCsound(options: FakeCsoundOptions = {}) {
  let stopCalls = 0
  let terminateCalls = 0

  const csound: FakeCsound = {
    compileCSD: async () => {
      if (options.compileError) throw options.compileError
      return 0
    },
    start: async () => {
      if (options.startError) throw options.startError
      return 0
    },
    stop: async () => {
      stopCalls += 1
      return 0
    },
    terminateInstance: () => {
      terminateCalls += 1
      return options.termination ?? Promise.resolve()
    },
    removeListener: () => undefined,
    on: () => undefined,
    off: () => undefined
  }

  return {
    csound,
    stopCalls: () => stopCalls,
    terminateCalls: () => terminateCalls
  }
}

let currentFactory: () => Promise<FakeCsound | undefined> = async () => undefined

await mock.module("@csound/browser", () => ({
  default: () => currentFactory()
}))

const { CsoundRuntime } = await import("../src/runtime")

function validWasm(): ArrayBuffer {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = performance.now()

  while (!check()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for runtime state")
    }
    await wait(1)
  }
}

describe.serial("CsoundRuntime cleanup", () => {
  test("Stop waits for a pending initialization and closes it once", async () => {
    const initialization = deferred<FakeCsound | undefined>()
    const fake = fakeCsound()
    let factoryCalls = 0
    currentFactory = () => {
      factoryCalls += 1
      return initialization.promise
    }

    const runtime = new CsoundRuntime({ stopTimeoutMs: 500 })
    const startTask = runtime.start(validWasm(), "<CsoundSynthesizer/>")

    await waitFor(() => factoryCalls === 1)

    let stopSettled = false
    const stopTask = runtime.stop().then(() => {
      stopSettled = true
    })

    await wait(10)
    expect(stopSettled).toBe(false)
    expect(runtime.state).toBe("stopping")

    initialization.resolve(fake.csound)
    await Promise.all([startTask, stopTask])

    expect(fake.terminateCalls()).toBe(1)
    expect(runtime.state).toBe("idle")
    expect(runtime.canStop).toBe(false)
  })

  test("a late termination releases the retained instance", async () => {
    const termination = deferred<void>()
    const fake = fakeCsound({ termination: termination.promise })
    currentFactory = async () => fake.csound

    const runtime = new CsoundRuntime({ stopTimeoutMs: 100 })
    await runtime.start(validWasm(), "<CsoundSynthesizer/>")

    expect(runtime.state).toBe("playing")
    await expect(runtime.stop()).rejects.toMatchObject({
      code: "terminate-failed"
    })
    expect(runtime.state).toBe("error")
    expect(runtime.canStop).toBe(true)

    termination.resolve()
    await waitFor(() => runtime.state === "idle")

    expect(fake.terminateCalls()).toBe(1)
    expect(runtime.canStop).toBe(false)
  })

  test("compile proxy errors keep the compile error code", async () => {
    const fake = fakeCsound({
      compileError: new Error("compile worker stopped")
    })
    currentFactory = async () => fake.csound

    const runtime = new CsoundRuntime()
    await expect(
      runtime.start(validWasm(), "<CsoundSynthesizer/>")
    ).rejects.toMatchObject({
      code: "compile-failed"
    })
  })

  test("start proxy errors keep the start error code", async () => {
    const fake = fakeCsound({
      startError: new Error("audio worker stopped")
    })
    currentFactory = async () => fake.csound

    const runtime = new CsoundRuntime()
    await expect(
      runtime.start(validWasm(), "<CsoundSynthesizer/>")
    ).rejects.toMatchObject({
      code: "start-failed"
    })
  })
})
