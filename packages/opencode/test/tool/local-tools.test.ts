import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { readFile, readdir, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import planning from "../../../../dotfiles/opencode/tools/planning"
import drawio from "../../../../dotfiles/opencode/tools/drawio"
import marker from "../../../../dotfiles/opencode/tools/marker"
import { run } from "../../../../dotfiles/opencode/lib/local-tools"
import { installLocalTools } from "../../../../script/install-local-tools"
import { tmpdir } from "../fixture/fixture"
import type { ToolResult } from "@opencode-ai/plugin"

function decoded(result: ToolResult) {
  if (typeof result === "string") throw new Error("Expected structured tool result")
  return JSON.parse(result.output)
}

function context(directory: string, denied?: string) {
  const requests: Parameters<ToolContext["ask"]>[0][] = []
  const value: ToolContext = {
    sessionID: "ses_localtest",
    messageID: "msg_localtest",
    agent: "build",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async (input) => {
      requests.push(input)
      if (input.permission === denied) throw new Error(`Denied ${denied}`)
    },
  }
  return { value, requests }
}

const cell = '<mxCell id="a" value="Client" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>'

function pdf() {
  const stream = "BT /F1 24 Tf 60 720 Td (Local conversion acceptance) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  const chunks = ["%PDF-1.4\n"]
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(chunks.join("").length)
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`)
  })
  const xref = chunks.join("").length
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
  offsets.slice(1).forEach((offset) => chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`))
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return chunks.join("")
}

describe("local tools", () => {
  test("planning recovers files, preserves init, and refuses stale changes", async () => {
    await using tmp = await tmpdir()
    const ctx = context(tmp.path)
    const first = await planning.execute({ action: "init", title: "Test" }, ctx.value)
    const data = decoded(first)
    await planning.execute({ action: "write", file: "findings.md", content: "Evidence\n", expected_sha256: data.files[1].sha256 }, ctx.value)
    await planning.execute({ action: "init", title: "Replacement" }, ctx.value)
    const resumed = await planning.execute({ action: "read", plan_id: data.plan_id }, { ...ctx.value, sessionID: "ses_other" })
    expect(decoded(resumed).files[1].content).toBe("Evidence\n")
    await expect(planning.execute({ action: "write", file: "findings.md", content: "Lost update", expected_sha256: data.files[1].sha256 }, ctx.value)).rejects.toThrow("changed")
  })

  test("permissions deny side effects and symlink escape asks external_directory", async () => {
    await using tmp = await tmpdir()
    await using other = await tmpdir()
    await expect(planning.execute({ action: "init" }, context(tmp.path, "edit").value)).rejects.toThrow("Denied edit")
    expect(await readdir(tmp.path)).toEqual([])
    await symlink(other.path, path.join(tmp.path, "outside"))
    const ctx = context(tmp.path, "external_directory")
    await expect(drawio.execute({ action: "create", path: "outside/diagram.drawio", xml: cell }, ctx.value)).rejects.toThrow("Denied external_directory")
    expect(await readdir(other.path)).toEqual([])
  })

  test("drawio produces editable XML and local SVG, then updates a cell", async () => {
    await using tmp = await tmpdir()
    const ctx = context(tmp.path)
    const created = decoded(await drawio.execute({ action: "create", path: "diagram.drawio", xml: cell }, ctx.value))
    expect(await readFile(created.path, "utf8")).toContain("mxGraphModel")
    expect(await readFile(created.preview, "utf8")).toContain("Client")
    await drawio.execute({ action: "edit", path: "diagram.drawio", expected_sha256: created.sha256, operations: [{ operation: "update", cell_id: "a", xml: cell.replace("Client", "Updated") }] }, ctx.value)
    expect(await readFile(created.path, "utf8")).toContain("Updated")
    await expect(drawio.execute({ action: "create", path: "diagram.drawio", xml: cell, expected_sha256: created.sha256 }, ctx.value)).rejects.toThrow("current expected_sha256")
  })

  test("drawio refuses malformed graph and active XML before creating files", async () => {
    await using tmp = await tmpdir()
    for (const xml of [cell + cell, cell.replace('parent="1"', 'parent="missing"'), '<!DOCTYPE a [<!ENTITY b SYSTEM "file:///etc/passwd">]><root/>', cell.replace("Client", "https://example.com/x.png")]) {
      await expect(drawio.execute({ action: "create", path: "invalid.drawio", xml }, context(tmp.path).value)).rejects.toThrow()
    }
    expect(await readdir(tmp.path)).toEqual([])
  })

  test("child work responds to timeout and cancellation", async () => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "wait.py")
    await writeFile(script, "import time\ntime.sleep(30)\n")
    await expect(run(["python3", script], { cwd: tmp.path, signal: new AbortController().signal, timeout: 50 })).rejects.toThrow("Timed out")
    const controller = new AbortController()
    const result = run(["python3", script], { cwd: tmp.path, signal: controller.signal, timeout: 30000 })
    setTimeout(() => controller.abort(), 50)
    await expect(result).rejects.toThrow("Cancelled")
  })

  test.skipIf(!Bun.which("pdftotext"))("text fallback converts a real PDF and preserves existing output", async () => {
    await using tmp = await tmpdir()
    await writeFile(path.join(tmp.path, "input.pdf"), pdf())
    const ctx = context(tmp.path)
    const args = { input: "input.pdf", output_dir: "converted", engine: "text" as const, format: "markdown" as const, ocr: false, timeout_seconds: 10 }
    const output = decoded(await marker.execute(args, ctx.value))
    expect(await readFile(output.primary, "utf8")).toContain("Local conversion acceptance")
    await expect(marker.execute(args, ctx.value)).rejects.toThrow("already exists")
    expect((await readdir(tmp.path)).filter((file) => file.startsWith(".document-convert-"))).toEqual([])
    expect(ctx.requests.map((request) => request.permission)).toContain("bash")
  })

  test("installer is idempotent and preserves locally edited tools", async () => {
    await using tmp = await tmpdir()
    await installLocalTools(tmp.path)
    await installLocalTools(tmp.path)
    await writeFile(path.join(tmp.path, "tools", "planning.ts"), "local customization")
    await expect(installLocalTools(tmp.path)).rejects.toThrow("Locally edited")
    expect(await readFile(path.join(tmp.path, "tools", "planning.ts"), "utf8")).toBe("local customization")
  })
})
