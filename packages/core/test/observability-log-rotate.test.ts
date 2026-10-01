import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { rotate } from "../src/observability/logging"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "oc-log-rotate-"))

describe("Logging.rotate", () => {
  test("leaves small logs in place", () => {
    const dir = tmp()
    const file = path.join(dir, "opencode.log")
    fs.writeFileSync(file, "small")
    expect(rotate(file, { maxBytes: 10 })).toBe(false)
    expect(fs.readFileSync(file, "utf8")).toBe("small")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("shifts generations and keeps at most `keep` rotated files", () => {
    const dir = tmp()
    const file = path.join(dir, "opencode.log")
    fs.writeFileSync(`${file}.1`, "gen1")
    fs.writeFileSync(`${file}.2`, "gen2")
    fs.writeFileSync(`${file}.3`, "gen3")
    fs.writeFileSync(file, "x".repeat(32))
    expect(rotate(file, { maxBytes: 10, keep: 3 })).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(32))
    expect(fs.readFileSync(`${file}.2`, "utf8")).toBe("gen1")
    expect(fs.readFileSync(`${file}.3`, "utf8")).toBe("gen2")
    expect(fs.existsSync(`${file}.4`)).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test("missing file is a no-op", () => {
    const dir = tmp()
    expect(rotate(path.join(dir, "missing.log"), { maxBytes: 1 })).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
