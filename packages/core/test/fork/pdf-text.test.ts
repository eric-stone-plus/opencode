import { describe, expect } from "bun:test"
import { chmod, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ForkPdfText } from "@opencode/core/tool/fork/pdf-text"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { it } from "../lib/effect"

const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 50 Td (Fork PDF text) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF
`

const spawner = LayerNode.compile(CrossSpawnSpawner.node)

/** Runs `body` with fake extractors first on PATH, as a directory of executable shell scripts. */
const withFakes = <A, E, R>(
  scripts: Record<string, string>,
  body: (directory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "oc-pdf-fake-"))
      await Promise.all(
        Object.entries(scripts).map(async ([name, script]) => {
          const file = path.join(directory, name)
          await Bun.write(file, `#!/bin/sh\n${script}\n`)
          await chmod(file, 0o755)
        }),
      )
      const previous = process.env.PATH
      process.env.PATH = `${directory}${path.delimiter}${previous}`
      return { directory, previous }
    }),
    ({ directory }) => body(directory),
    ({ directory, previous }) =>
      Effect.promise(async () => {
        if (previous === undefined) delete process.env.PATH
        else process.env.PATH = previous
        await rm(directory, { recursive: true })
      }),
  )

const extract = (file: string) =>
  Effect.gen(function* () {
    return yield* ForkPdfText.extract(yield* ChildProcessSpawner, file)
  }).pipe(Effect.provide(spawner))

describe("ForkPdfText.extract", () => {
  const real = Bun.which("pdftotext") ? it.live : it.live.skip

  real("extracts the text layer of a PDF", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "oc-pdf-real-")))
      const file = path.join(directory, "sample.pdf")
      yield* Effect.promise(() => Bun.write(file, PDF))
      expect(yield* extract(file).pipe(Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true }))))).toBe(
        "Fork PDF text",
      )
    }),
  )

  it.live("returns nothing for a file with no extractable text", () =>
    withFakes({ pdftotext: "exit 1", python3: "exit 1" }, () =>
      extract("unused.pdf").pipe(Effect.map((text) => expect(text).toBeUndefined())),
    ),
  )

  it.live("falls back to python when pdftotext fails normally", () =>
    withFakes({ pdftotext: "exit 2", python3: 'echo "fallback text"' }, () =>
      extract("unused.pdf").pipe(Effect.map((text) => expect(text).toBe("fallback text"))),
    ),
  )

  it.live("uses the second python backend when the first yields nothing", () =>
    withFakes({ pdftotext: "exit 2", python3: 'case "$2" in *pypdf*) exit 1;; esac; echo "from fitz"' }, () =>
      extract("unused.pdf").pipe(Effect.map((text) => expect(text).toBe("from fitz"))),
    ),
  )

  it.live("discards a failed extractor's partial output before trying the next backend", () =>
    withFakes({ pdftotext: 'echo "partial first page"; exit 2', python3: 'echo "complete text"' }, () =>
      extract("unused.pdf").pipe(Effect.map((text) => expect(text).toBe("complete text"))),
    ),
  )

  it.live("caps the text at the character limit and marks the cut", () =>
    withFakes({ pdftotext: `head -c ${ForkPdfText.MAX_CHARS + 5000} /dev/zero | tr '\\0' x` }, () =>
      extract("unused.pdf").pipe(
        Effect.map((text) => expect(text).toBe(`${"x".repeat(ForkPdfText.MAX_CHARS)}\n\n[truncated]`)),
      ),
    ),
  )

  it.live("names the file in the message the read tool shows", () =>
    Effect.sync(() => {
      expect(ForkPdfText.unreadable("docs/spec.pdf")).toContain("PDF has no extractable text layer: docs/spec.pdf")
      expect(ForkPdfText.unreadable("docs/spec.pdf")).toContain("not attached")
    }),
  )
})
