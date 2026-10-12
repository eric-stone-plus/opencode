import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import plugin, { run } from "../bootstrap/plugin/local-tools"

// Standalone battery for the V2 local-tools plugin (the port of the V1
// dotfiles/opencode/{tools/*,lib/local-tools.ts} trio). The host is stood in
// for by a double that implements exactly the domains the plugin touches:
// location, permission.assert, and the tool transform. Assertions on `asks`
// pin the permission requests; the real permission flow is covered by
// packages/core/test/plugin/promise-tool-permission.test.ts.

const directories: string[] = []
const asks: Array<{ action: string; resources: readonly string[]; save?: readonly string[]; metadata?: Record<string, unknown> }> = []
let denied: string | undefined

afterEach(async () => {
  denied = undefined
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-local-tools-test-"))
  directories.push(directory)
  return directory
}

const tools = new Map<string, { execute: (input: unknown, context: ReturnType<typeof toolContext>) => Promise<{ content?: unknown }> }>()

const context = {
  location: {
    directory: "",
    workspaceID: undefined,
    project: { id: "test", directory: "", canonical: "" },
  },
  permission: {
    assert: async (input: { action: string; resources: readonly string[]; save?: readonly string[]; metadata?: Record<string, unknown> }) => {
      asks.push(input)
      if (input.action === denied) throw new Error(`Denied ${denied}`)
    },
  },
  tool: {
    transform: async (callback: (editor: { add: (tool: { name: string }) => void }) => void) => {
      callback({
        add: (tool) => {
          tools.set(tool.name, tool as never)
        },
      })
    },
  },
}

await (plugin.setup as (ctx: unknown) => Promise<void>)(context)

async function point(directory: string) {
  context.location.directory = directory
  context.location.project.directory = directory
}

function toolContext() {
  return {
    sessionID: "ses_localtools",
    agent: "build",
    messageID: "msg_localtools",
    id: "call_localtools",
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

function tool(name: string) {
  const found = tools.get(name)
  if (!found) throw new Error(`tool not registered: ${name}`)
  return found
}

function decoded(result: { content?: unknown }) {
  if (typeof result.content !== "string") throw new Error("Expected a string tool result")
  return JSON.parse(result.content)
}

const cell =
  '<mxCell id="a" value="Client" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>'

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

describe("local tools plugin", () => {
  test("planning recovers files, preserves init, and refuses stale changes", async () => {
    const tmp = await temporary()
    await point(tmp)
    const ctx = toolContext()
    const first = decoded(await tool("planning").execute({ action: "init", title: "Test" }, ctx))
    await tool("planning").execute(
      { action: "write", file: "findings.md", content: "Evidence\n", expected_sha256: first.files[1].sha256 },
      ctx,
    )
    await tool("planning").execute({ action: "init", title: "Replacement" }, ctx)
    const resumed = decoded(
      await tool("planning").execute({ action: "read", plan_id: first.plan_id }, { ...ctx, sessionID: "ses_other" }),
    )
    expect(resumed.files[1].content).toBe("Evidence\n")
    await expect(
      tool("planning").execute(
        { action: "write", file: "findings.md", content: "Lost update", expected_sha256: first.files[1].sha256 },
        ctx,
      ),
    ).rejects.toThrow("changed")
  })

  test("permissions deny side effects and symlink escape asks external_directory", async () => {
    const tmp = await temporary()
    const other = await temporary()
    await point(tmp)
    denied = "edit"
    await expect(tool("planning").execute({ action: "init" }, toolContext())).rejects.toThrow("Denied edit")
    expect(await readdir(tmp)).toEqual([])
    denied = undefined
    await symlink(other, path.join(tmp, "outside"))
    denied = "external_directory"
    await expect(
      tool("drawio").execute({ action: "create", path: "outside/diagram.drawio", xml: cell }, toolContext()),
    ).rejects.toThrow("Denied external_directory")
    expect(await readdir(other)).toEqual([])
    expect(asks.at(-1)).toMatchObject({
      action: "external_directory",
      resources: [`${other}/*`],
      save: [`${tmp}/*`],
    })
    denied = undefined
  })

  test("drawio produces editable XML and local SVG, then updates a cell", async () => {
    const tmp = await temporary()
    await point(tmp)
    const ctx = toolContext()
    const created = decoded(await tool("drawio").execute({ action: "create", path: "diagram.drawio", xml: cell }, ctx))
    expect(await readFile(created.path, "utf8")).toContain("mxGraphModel")
    expect(await readFile(created.preview, "utf8")).toContain("Client")
    await tool("drawio").execute(
      {
        action: "edit",
        path: "diagram.drawio",
        expected_sha256: created.sha256,
        operations: [{ operation: "update", cell_id: "a", xml: cell.replace("Client", "Updated") }],
      },
      ctx,
    )
    expect(await readFile(created.path, "utf8")).toContain("Updated")
    await expect(
      tool("drawio").execute({ action: "create", path: "diagram.drawio", xml: cell, expected_sha256: created.sha256 }, ctx),
    ).rejects.toThrow("current expected_sha256")
  })

  test("drawio refuses malformed graph and active XML before creating files", async () => {
    const tmp = await temporary()
    await point(tmp)
    for (const xml of [
      cell + cell,
      cell.replace('parent="1"', 'parent="missing"'),
      '<!DOCTYPE a [<!ENTITY b SYSTEM "file:///etc/passwd">]><root/>',
      cell.replace("Client", "https://example.com/x.png"),
    ]) {
      await expect(tool("drawio").execute({ action: "create", path: "invalid.drawio", xml }, toolContext())).rejects.toThrow()
    }
    expect(await readdir(tmp)).toEqual([])
  })

  test("child work responds to timeout and cancellation", async () => {
    const tmp = await temporary()
    const script = path.join(tmp, "wait.py")
    await writeFile(script, "import time\ntime.sleep(30)\n")
    await expect(run(["python3", script], { cwd: tmp, signal: new AbortController().signal, timeout: 50 })).rejects.toThrow(
      "Timed out",
    )
    const controller = new AbortController()
    const result = run(["python3", script], { cwd: tmp, signal: controller.signal, timeout: 30000 })
    setTimeout(() => controller.abort(), 50)
    await expect(result).rejects.toThrow("Cancelled")
  })

  test.skipIf(!Bun.which("pdftotext"))("text fallback converts a real PDF and preserves existing output", async () => {
    const tmp = await temporary()
    await point(tmp)
    await writeFile(path.join(tmp, "input.pdf"), pdf())
    const ctx = toolContext()
    const start = asks.length
    const args = {
      input: "input.pdf",
      output_dir: "converted",
      engine: "text" as const,
      format: "markdown" as const,
      ocr: false,
      timeout_seconds: 10,
    }
    const output = decoded(await tool("marker").execute(args, ctx))
    expect(await readFile(output.primary, "utf8")).toContain("Local conversion acceptance")
    await expect(tool("marker").execute(args, ctx)).rejects.toThrow("already exists")
    expect((await readdir(tmp)).filter((file) => file.startsWith(".document-convert-"))).toEqual([])
    expect(asks.slice(start).map((request) => request.action)).toContain("shell")
  })
})
