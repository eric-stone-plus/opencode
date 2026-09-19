import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

test.skipIf(process.platform !== "linux")(
  "retains wait channels and sleeping states without ptrace frames",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-stack-test-"))
    try {
      await Bun.write(
        path.join(directory, "ps"),
        `#!/bin/sh
printf '%s\\n' \\
  '4242 4242 S futex_wait_queue 00:00:00 worker' \\
  '4242 4243 S tty_write 00:00:00 stdout' \\
  '4242 4244 S 0 00:00:00 sleeping' \\
  '4242 4245 R - 00:00:00 running'
`,
      )
      for (const tool of ["eu-stack", "gdb"]) {
        await Bun.write(path.join(directory, tool), "#!/bin/sh\nexit 1\n")
        await chmod(path.join(directory, tool), 0o755)
      }
      await chmod(path.join(directory, "ps"), 0o755)
      await Bun.write(
        path.join(directory, "capture.ts"),
        `import { captureThreads } from ${JSON.stringify(import.meta.dir + "/stack-capture.ts")}
console.log(JSON.stringify(await captureThreads(4242, 1)))
`,
      )
      const proc = Bun.spawn([process.execPath, path.join(directory, "capture.ts")], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: directory },
      })
      const [output, error, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(error).toBe("")
      expect(code).toBe(0)
      const capture = JSON.parse(output)
      expect(capture.tool).toBe("ps-only")
      expect(capture.threads.map((thread: { state: string }) => thread.state)).toEqual([
        "PARKED",
        "IO_WAIT",
        "PARKED",
        "RUNNING",
      ])
      expect(capture.histogram).toEqual(["1  wchan:futex_wait_queue", "1  wchan:tty_write"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
