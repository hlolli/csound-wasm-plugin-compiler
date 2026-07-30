const children = [
  Bun.spawn(["bun", "run", "dev:server"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  }),
  Bun.spawn(["bun", "run", "dev:web"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
]

let closing = false

const shutdown = async (exitCode = 0) => {
  if (closing) return
  closing = true

  for (const child of children) {
    child.kill("SIGTERM")
  }

  await Promise.allSettled(children.map((child) => child.exited))
  process.exit(exitCode)
}

process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

const firstExit = await Promise.race(
  children.map(async (child) => ({
    child,
    code: await child.exited
  }))
)

if (!closing) {
  const failed = firstExit.code !== 0
  await shutdown(failed ? firstExit.code : 0)
}

export {}
