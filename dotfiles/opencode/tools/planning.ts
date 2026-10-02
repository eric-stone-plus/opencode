import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { location, permit, save } from "../lib/local-tools"

const files = ["task_plan.md", "findings.md", "progress.md"] as const

export default tool({
  description:
    "Keep or recover three planning files in a workspace .planning directory. The existing session goal remains authoritative. Use init once, read after compaction/resume, and write with the SHA-256 returned by read. This never sets, clears, or completes a goal.",
  args: {
    action: tool.schema.enum(["init", "read", "write"]),
    workspace: tool.schema.string().optional().describe("Workspace directory; defaults to the current session directory"),
    plan_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/).optional().describe("Reuse a returned plan_id when resuming in a different session; defaults to this session ID"),
    title: tool.schema.string().max(300).optional(),
    file: tool.schema.enum(files).optional(),
    content: tool.schema.string().max(100_000).optional(),
    expected_sha256: tool.schema.string().regex(/^[0-9a-f]{64}$/).optional(),
  },
  async execute(args, context) {
    const id = args.plan_id ?? context.sessionID
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id)) throw new Error("Invalid plan_id")
    const root = await location(context, path.join(args.workspace ?? ".", ".planning", id))
    const paths = files.map((file) => path.join(root, file))
    if (args.action === "init") {
      await permit(context, "edit", paths)
      await mkdir(root, { recursive: true })
      const content = [
        `# ${args.title ?? "Task plan"}\n\nThe existing OpenCode session goal is authoritative. This file records execution notes, not another goal or continuation controller.\n\n## Phases\n- [ ] Define acceptance checks\n- [ ] Implement and verify\n\n## Next step\nRecord the next concrete action.\n`,
        "# Findings\n\nRecord evidence, source paths, decisions, and unresolved questions.\n",
        "# Progress\n\nRecord completed work, verification results, failures, and the next recovery step.\n",
      ]
      for (const [index, file] of paths.entries()) {
        context.abort.throwIfAborted()
        await writeFile(file, content[index], { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        })
      }
    }
    if (args.action === "write") {
      if (!args.file || args.content === undefined || !args.expected_sha256) {
        throw new Error("write requires file, content, and expected_sha256 from read")
      }
      const file = await location(context, path.join(root, args.file))
      await permit(context, "read", [file])
      if (Bun.CryptoHasher.hash("sha256", await readFile(file), "hex") !== args.expected_sha256) {
        throw new Error("Planning file changed; read it again before writing")
      }
      await permit(context, "edit", [file])
      if (Bun.CryptoHasher.hash("sha256", await readFile(file), "hex") !== args.expected_sha256) {
        throw new Error("Planning file changed while waiting for permission; read it again")
      }
      await save(file, args.content, context.abort)
    }
    await permit(context, "read", paths)
    const content = await Promise.all(paths.map(async (file) => {
      const target = await location(context, file)
      const bytes = await readFile(target)
      return {
        path: target,
        sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
        content: bytes.toString().slice(0, 48_000),
        truncated: bytes.length > 48_000,
      }
    }))
    return { title: `Plan ${id}`, output: JSON.stringify({ plan_id: id, directory: root, files: content }), metadata: { directory: root } }
  },
})
