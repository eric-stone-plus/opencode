import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { extractPdfText } from "../../src/tool/pdf-text"

const run = async (directory: string, command: string, abort?: "signal" | "effect") => {
  const pidfile = path.join(directory, "extractor.pid")
  const completed = path.join(directory, "completed")
  const fallback = path.join(directory, "fallback")
  const extractor = path.join(directory, "pdftotext")
  const python = path.join(directory, "python3")
  await Bun.write(
    extractor,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nawait Bun.write(${JSON.stringify(pidfile)}, String(process.pid));\n${command}\n`,
  )
  await Bun.write(
    python,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(fallback)}, "started");\nconsole.log("fallback text");\n`,
  )
  await Promise.all([chmod(extractor, 0o755), chmod(python, 0o755)])
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { extractPdfText } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/pdf-text.ts"))};
import { Effect, Fiber } from "effect";
if (${abort === "effect"}) {
  const fiber = Effect.runFork(Effect.promise((signal) => extractPdfText("unused.pdf", signal)));
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await Effect.runPromise(Fiber.interrupt(fiber));
  process.stdin.destroy();
  await Bun.write(Bun.stdout, JSON.stringify({ interrupted: true }));
} else {
const controller = new AbortController();
process.stdin.once("data", () => controller.abort(new DOMException("Cancelled", "AbortError")));
const result = await extractPdfText("unused.pdf", controller.signal).then(
  (text) => ({ text }),
  (error) => ({ error: error.name }),
);
process.stdin.destroy();
await Bun.write(Bun.stdout, JSON.stringify(result));
}`,
    ],
    {
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = new Response(proc.stdout).text()
  const stderr = new Response(proc.stderr).text()
  try {
    if (abort) {
      const deadline = Date.now() + 5000
      while (!(await Bun.file(pidfile).exists())) {
        if (Date.now() >= deadline) throw new Error("extractor never became ready")
        await Bun.sleep(10)
      }
      proc.stdin.write("abort\n")
      proc.stdin.end()
    }
    const code = await proc.exited
    expect(await stderr).toBe("")
    expect(code).toBe(0)
    const pid = Number(await Bun.file(pidfile).text())
    expect(() => process.kill(pid, 0)).toThrow()
    return {
      result: JSON.parse(await stdout) as { text?: string; error?: string; interrupted?: boolean },
      completed: await Bun.file(completed).exists(),
      fallback: await Bun.file(fallback).exists(),
    }
  } finally {
    proc.kill("SIGKILL")
    await proc.exited
    if (await Bun.file(pidfile).exists()) {
      const pid = Number(await Bun.file(pidfile).text())
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
}

test.skipIf(process.platform === "win32")("stops the extractor when its text exceeds the cap", async () => {
  await using tmp = await tmpdir()
  const value = await run(
    tmp.path,
    `for (let i = 0; i < 128; i++) {
  await new Promise((resolve) => process.stdout.write("x".repeat(65_536), resolve));
}
await Bun.write(${JSON.stringify(path.join(tmp.path, "completed"))}, "completed");`,
  )
  expect(value.result.text).toBe("x".repeat(200_000) + "\n\n[truncated]")
  expect(value.completed).toBe(false)
  expect(value.fallback).toBe(false)
})

for (const abort of ["signal", "effect"] as const) {
  test.skipIf(process.platform === "win32")(`cancels through ${abort} without starting the fallback`, async () => {
    await using tmp = await tmpdir()
    const value = await run(tmp.path, `setTimeout(() => process.exit(2), 1000);`, abort)
    expect(value.result).toEqual(abort === "effect" ? { interrupted: true } : { error: "AbortError" })
    expect(value.fallback).toBe(false)
  })
}

test("rejects cancellation before launching an extractor", async () => {
  const signal = AbortSignal.abort(new DOMException("Cancelled", "AbortError"))
  await expect(extractPdfText("unused.pdf", signal)).rejects.toThrow("Cancelled")
})

test.skipIf(process.platform === "win32")(
  "force-stops a timed out extractor without starting the fallback",
  async () => {
    await using tmp = await tmpdir()
    const value = await run(tmp.path, `setTimeout(() => process.exit(2), 18_000);`)
    expect(value.result).toEqual({})
    expect(value.fallback).toBe(false)
  },
  25_000,
)

test.skipIf(process.platform === "win32")("falls back when pdftotext fails normally", async () => {
  await using tmp = await tmpdir()
  const value = await run(tmp.path, "process.exit(2);")
  expect(value.result.text).toBe("fallback text")
  expect(value.fallback).toBe(true)
})

test.skipIf(process.platform === "win32" || !Bun.which("python3"))(
  "discards partial Python output before trying a second backend",
  async () => {
    await using tmp = await tmpdir()
    const extractor = path.join(tmp.path, "pdftotext")
    await Bun.write(extractor, `#!${process.execPath}\nprocess.exit(2);\n`)
    await chmod(extractor, 0o755)
    await Bun.write(
      path.join(tmp.path, "pypdf.py"),
      `class Page:
 def extract_text(self):
  return "first page"

class PdfReader:
 def __init__(self, path):
  pass
 @property
 def pages(self):
  yield Page()
  raise ValueError("broken second page")
`,
    )
    await Bun.write(
      path.join(tmp.path, "fitz.py"),
      `class Page:
 def __init__(self, text):
  self.text = text
 def get_text(self):
  return self.text

class Document:
 def __enter__(self):
  return [Page("first page"), Page("second page")]
 def __exit__(self, *args):
  pass

def open(path):
 return Document()
`,
    )
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { extractPdfText } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tool/pdf-text.ts"))};
await Bun.write(Bun.stdout, JSON.stringify(await extractPdfText("unused.pdf")));`,
      ],
      {
        env: { ...process.env, PATH: tmp.path + path.delimiter + process.env.PATH, PYTHONPATH: tmp.path },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(code).toBe(0)
      expect(stderr).toBe("")
      expect(JSON.parse(stdout)).toBe("first page\nsecond page")
    } finally {
      proc.kill("SIGKILL")
      await proc.exited
    }
  },
)
