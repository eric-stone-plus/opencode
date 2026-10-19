import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// The bootstrap scripts embed two pieces of parsing logic that decide whether a
// seat is accepted: `strip_jsonc` (the JSONC reader used to validate
// opencode.jsonc) and the OCR banner parser (the minimum-version gate). Both
// live inside shell heredocs, so nothing imported them and a regression could
// only be caught by a full install. These tests extract the exact source from
// the scripts and exercise it, so the fixture cannot drift from the product.
const ROOT = path.resolve(import.meta.dir, "..")
const VERIFY = path.join(ROOT, "bootstrap", "verify.sh")
const INSTALL = path.join(ROOT, "bootstrap", "install.sh")

function extractPythonFunction(script: string, name: string): string {
  const text = readFileSync(script, "utf8")
  const start = text.indexOf(`def ${name}(`)
  if (start < 0) throw new Error(`${name} not found in ${script}`)
  const rest = text.slice(start)
  // The next top-level definition or class ends the function. Both scripts keep
  // the helper at module level inside their Python heredoc.
  const next = rest.slice(1).search(/\n(?:def |class )/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

function runStripJsonc(script: string, input: string): unknown {
  const source = extractPythonFunction(script, "strip_jsonc")
  const program = `${source}\nimport json, sys\nsys.stdout.write(json.dumps(json.loads(strip_jsonc(sys.stdin.read()))))\n`
  const proc = Bun.spawnSync({
    cmd: ["python3", "-c", program],
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return JSON.parse(proc.stdout.toString())
}

const JSONC = `{
  // a line comment, with a comma and a brace }
  "a": 1,
  /* a block comment with "quotes" and , commas */
  "url": "https://example.com/a//b",
  "comma": "x,}",
  "escaped": "quote \\" and backslash \\\\",
  "list": [1, 2,],
  "nested": {"x": true,},
}`

const EXPECTED = {
  a: 1,
  url: "https://example.com/a//b",
  comma: "x,}",
  escaped: 'quote " and backslash \\',
  list: [1, 2],
  nested: { x: true },
}

describe("strip_jsonc", () => {
  for (const script of [VERIFY, INSTALL]) {
    test(`parses JSONC in ${path.basename(script)}`, () => {
      expect(runStripJsonc(script, JSONC)).toEqual(EXPECTED)
    })

    test(`keeps comment markers inside strings in ${path.basename(script)}`, () => {
      expect(runStripJsonc(script, '{"a": "// not a comment", "b": "/* not one */"}')).toEqual({
        a: "// not a comment",
        b: "/* not one */",
      })
    })
  }
})

function extractOcrBannerSed(): string {
  const line = readFileSync(VERIFY, "utf8")
    .split("\n")
    .find((candidate) => candidate.includes("ocr_version=$(timeout 30 ocr version"))
  if (!line) throw new Error("ocr_version banner pipeline not found in verify.sh")
  const match = line.match(/\| (sed -nE '[^']*') \| head -n 1/)
  if (!match) throw new Error("sed expression not found in the ocr_version pipeline")
  return match[1]!
}

function parseBanner(output: string): string {
  const sed = extractOcrBannerSed()
  const program = `printf '%s\\n' "$1" | tr '[:upper:]' '[:lower:]' | ${sed} | head -n 1`
  const proc = Bun.spawnSync({
    cmd: ["bash", "-c", program, "bash", output],
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return proc.stdout.toString().trim()
}

describe("ocr banner version", () => {
  test.each([
    ["ocr version 1.13.1", "1.13.1"],
    ["OpenCodeReview 9.9.9", "9.9.9"],
    ["OpenCode Review v1.13.1", "1.13.1"],
    ["OpenCodeReview v1.13.1 (8eb8334) linux/amd64", "1.13.1"],
    ["runtime 2.0.0\nocr version 1.13.1", "1.13.1"],
    ["runtime 9.9.9\nocr version 1.12.0", "1.12.0"],
    ["no version here", ""],
  ])("parses %p", (output, expected) => {
    expect(parseBanner(output)).toBe(expected)
  })
})
