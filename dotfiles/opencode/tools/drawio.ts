import { tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { location, permit, run, save } from "../lib/local-tools"

export default tool({
  description:
    "Create, read, or edit a local editable .drawio diagram and SVG preview. The current model supplies mxCell XML; no external model/API or upload. Use read to obtain XML and sha256 before edit/overwrite. SVG preview approximates basic boxes/connectors; open the .drawio in diagrams.net Desktop or the VS Code Draw.io extension for full editing.",
  args: {
    action: tool.schema.enum(["create", "read", "edit"]),
    path: tool.schema.string().describe("Workspace-relative or absolute .drawio file path"),
    xml: tool.schema.string().max(2_000_000).optional().describe("For create: complete uncompressed mxfile, mxGraphModel, or sibling mxCell elements with unique ids and geometry"),
    expected_sha256: tool.schema.string().regex(/^[0-9a-f]{64}$/).optional().describe("Required when replacing an existing diagram or editing it"),
    operations: tool.schema.array(tool.schema.object({
      operation: tool.schema.enum(["add", "update", "delete"]),
      cell_id: tool.schema.string(),
      xml: tool.schema.string().optional().describe("Full mxCell for add/update; omit for delete"),
    })).max(200).optional(),
  },
  async execute(args, context) {
    const file = await location(context, args.path)
    if (path.extname(file) !== ".drawio") throw new Error("Use a .drawio output path")
    await permit(context, "read", [file])
    const previous = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    const sha = previous === undefined ? undefined : Bun.CryptoHasher.hash("sha256", previous, "hex")
    if (args.action === "read") {
      if (previous === undefined) throw new Error("Diagram does not exist")
      return { output: JSON.stringify({ path: file, sha256: sha, xml: previous }), metadata: { path: file } }
    }
    if (previous !== undefined && args.expected_sha256 !== sha) throw new Error("Read the diagram and pass its current expected_sha256 before replacing it")
    if (args.action === "edit" && (previous === undefined || !args.operations?.length)) throw new Error("edit requires an existing file and operations")
    if (args.action === "create" && !args.xml) throw new Error("create requires xml")
    const svg = await location(context, `${file}.svg`)
    await permit(context, "edit", [file, svg])
    const python = Bun.which("python3")
    if (!python) throw new Error("python3 is required for local XML validation")
    const script = fileURLToPath(new URL("../lib/drawio.py", import.meta.url))
    await context.ask({ permission: "bash", patterns: [`${python} ${script}`], always: [`${python} ${script}`], metadata: { description: "Validate and render local Draw.io XML", argv: [python, script] } })
    const parsed: unknown = JSON.parse(await run([python, script], { cwd: context.directory, signal: context.abort, timeout: 10_000, input: JSON.stringify({ xml: args.action === "edit" ? previous : args.xml, operations: args.action === "edit" ? args.operations : [] }) }))
    if (!parsed || typeof parsed !== "object" || !("xml" in parsed) || typeof parsed.xml !== "string" || !("svg" in parsed) || typeof parsed.svg !== "string" || !("cells" in parsed) || typeof parsed.cells !== "number") throw new Error("Draw.io validator returned an invalid result")
    const result: { xml: string; svg: string; cells: number } = {
      xml: parsed.xml,
      svg: parsed.svg,
      cells: parsed.cells,
    }
    const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (current !== previous) throw new Error("Diagram changed while preparing the edit; read it again")
    await save(file, result.xml, context.abort)
    await save(svg, result.svg, context.abort)
    return {
      title: path.basename(file),
      output: JSON.stringify({ path: file, preview: svg, cells: result.cells, sha256: Bun.CryptoHasher.hash("sha256", result.xml, "hex"), open: "Open the .drawio in diagrams.net Desktop or the VS Code Draw.io extension; the .svg preview opens locally in any browser." }),
      metadata: { path: file, preview: svg },
    }
  },
})
