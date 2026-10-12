import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Local planning, diagram, and document-conversion tools, ported from the V1
// tool files (dotfiles/opencode/{tools/{drawio,marker,planning}.ts,lib/local-tools.ts}).
// V2 does not scan ~/.config/opencode/tools/, so this single plugin registers
// the three tools on the host registry instead.
//
// Permission parity with the built-in tools runs through `ctx.permission.assert`
// (the blocking gate added for plugin tools): file access asks read/edit,
// escaping the location asks external_directory, and each spawned subprocess
// asks shell. The drawio validator is the sibling Python file installed at
// ~/.config/opencode/lib/drawio.py (repo copy: dotfiles/opencode/lib/drawio.py;
// deployed by script/install-local-tools.ts, --home aware).
//
// Runtime imports: node builtins + type-only plugin imports, so the file loads
// standalone in script/local-tools.test.ts.

type ToolRequest = { readonly action: string; readonly resources: ReadonlyArray<string>; readonly save?: ReadonlyArray<string>; readonly metadata?: Record<string, unknown> }

export default {
  id: "local-tools",
  async setup(ctx) {
    const root = () => realpath(ctx.location.directory)
    // Mirrors packages/core/src/file-access.ts: resources inside the location are
    // relative paths, outside they stay absolute, and "always" saves the project
    // root wildcard.
    const resource = (base: string, file: string) => {
      const relative = path.relative(base, file)
      if (relative === "") return "."
      return relative.startsWith("..") ? file.replaceAll("\\", "/") : relative.replaceAll("\\", "/")
    }
    const identity = (tool: ToolContext) => ({
      sessionID: tool.sessionID,
      agent: tool.agent,
      source: { type: "tool" as const, messageID: tool.messageID, id: tool.id },
    })
    const require = async (tool: ToolContext, request: ToolRequest) => {
      await ctx.permission.assert({ ...identity(tool), ...request })
      tool.signal.throwIfAborted()
    }

    // Resolve one path argument against the location, refusing to leave it without
    // the external_directory ask. Resolution walks to the nearest existing parent
    // so create-style actions can target a not-yet-existing file.
    const location = async (tool: ToolContext, value: string) => {
      const target = path.resolve(ctx.location.directory, value)
      const parent = await realpath(target).catch(async () => {
        if (target === path.dirname(target)) throw new Error(`Cannot resolve ${target}`)
        return path.join(await existingParent(path.dirname(target)), path.basename(target))
      })
      const base = await root()
      if (parent !== base && !parent.startsWith(`${base}${path.sep}`)) {
        const directory = path.dirname(parent)
        const project = ctx.location.project.directory
        await require(tool, {
          action: "external_directory",
          resources: [`${directory.replaceAll("\\", "/")}/*`],
          save: [`${project.replaceAll("\\", "/")}/*`],
          metadata: { path: parent },
        })
      }
      return parent
    }

    const permit = (tool: ToolContext, permission: "read" | "edit", files: readonly string[]) =>
      (async () => {
        const base = await root()
        await require(tool, {
          action: permission,
          resources: files.map((file) => resource(base, file)),
          save: ["*"],
          metadata: { files },
        })
      })()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "planning",
        options: { codemode: false },
        description:
          "Keep or recover three planning files in a workspace .planning directory. The existing session goal remains authoritative. Use init once, read after compaction/resume, and write with the SHA-256 returned by read. This never sets, clears, or completes a goal.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["init", "read", "write"] },
            workspace: {
              type: "string",
              description: "Workspace directory; defaults to the current session directory",
            },
            plan_id: {
              type: "string",
              description: "Reuse a returned plan_id when resuming in a different session; defaults to this session ID",
            },
            title: { type: "string" },
            file: { type: "string", enum: ["task_plan.md", "findings.md", "progress.md"] },
            content: { type: "string" },
            expected_sha256: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const args = input as {
            action: "init" | "read" | "write"
            workspace?: string
            plan_id?: string
            title?: string
            file?: "task_plan.md" | "findings.md" | "progress.md"
            content?: string
            expected_sha256?: string
          }
          const files = ["task_plan.md", "findings.md", "progress.md"] as const
          const id = args.plan_id ?? tool.sessionID
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id)) throw new Error("Invalid plan_id")
          const base = await location(tool, path.join(args.workspace ?? ".", ".planning", id))
          const paths = files.map((file) => path.join(base, file))
          if (args.action === "init") {
            await permit(tool, "edit", paths)
            await mkdir(base, { recursive: true })
            const content = [
              `# ${args.title ?? "Task plan"}\n\nThe existing OpenCode session goal is authoritative. This file records execution notes, not another goal or continuation controller.\n\n## Phases\n- [ ] Define acceptance checks\n- [ ] Implement and verify\n\n## Next step\nRecord the next concrete action.\n`,
              "# Findings\n\nRecord evidence, source paths, decisions, and unresolved questions.\n",
              "# Progress\n\nRecord completed work, verification results, failures, and the next recovery step.\n",
            ]
            for (const [index, file] of paths.entries()) {
              tool.signal.throwIfAborted()
              await writeFile(file, content[index], { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "EEXIST") throw error
              })
            }
          }
          if (args.action === "write") {
            if (!args.file || args.content === undefined || !args.expected_sha256) {
              throw new Error("write requires file, content, and expected_sha256 from read")
            }
            const file = await location(tool, path.join(base, args.file))
            await permit(tool, "read", [file])
            if (Bun.CryptoHasher.hash("sha256", await readFile(file), "hex") !== args.expected_sha256) {
              throw new Error("Planning file changed; read it again before writing")
            }
            await permit(tool, "edit", [file])
            if (Bun.CryptoHasher.hash("sha256", await readFile(file), "hex") !== args.expected_sha256) {
              throw new Error("Planning file changed while waiting for permission; read it again")
            }
            await save(file, args.content, tool.signal)
          }
          await permit(tool, "read", paths)
          const content = await Promise.all(
            paths.map(async (file) => {
              const target = await location(tool, file)
              const bytes = await readFile(target)
              return {
                path: target,
                sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
                content: bytes.toString().slice(0, 48_000),
                truncated: bytes.length > 48_000,
              }
            }),
          )
          return {
            content: JSON.stringify({ plan_id: id, directory: base, files: content }),
            metadata: { directory: base },
          }
        },
      })

      editor.add({
        name: "drawio",
        options: { codemode: false },
        description:
          "Create, read, or edit a local editable .drawio diagram and SVG preview. The current model supplies mxCell XML; no external model/API or upload. Use read to obtain XML and sha256 before edit/overwrite. SVG preview approximates basic boxes/connectors; open the .drawio in diagrams.net Desktop or the VS Code Draw.io extension for full editing.",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "read", "edit"] },
            path: { type: "string", description: "Workspace-relative or absolute .drawio file path" },
            xml: {
              type: "string",
              description:
                "For create: complete uncompressed mxfile, mxGraphModel, or sibling mxCell elements with unique ids and geometry",
            },
            expected_sha256: {
              type: "string",
              description: "Required when replacing an existing diagram or editing it",
            },
            operations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  operation: { type: "string", enum: ["add", "update", "delete"] },
                  cell_id: { type: "string" },
                  xml: { type: "string", description: "Full mxCell for add/update; omit for delete" },
                },
                required: ["operation", "cell_id"],
                additionalProperties: false,
              },
            },
          },
          required: ["action", "path"],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const args = input as {
            action: "create" | "read" | "edit"
            path: string
            xml?: string
            expected_sha256?: string
            operations?: Array<{ operation: "add" | "update" | "delete"; cell_id: string; xml?: string }>
          }
          const file = await location(tool, args.path)
          if (path.extname(file) !== ".drawio") throw new Error("Use a .drawio output path")
          await permit(tool, "read", [file])
          const previous = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error
            return undefined
          })
          const sha = previous === undefined ? undefined : Bun.CryptoHasher.hash("sha256", previous, "hex")
          if (args.action === "read") {
            if (previous === undefined) throw new Error("Diagram does not exist")
            return { content: JSON.stringify({ path: file, sha256: sha, xml: previous }), metadata: { path: file } }
          }
          if (previous !== undefined && args.expected_sha256 !== sha)
            throw new Error("Read the diagram and pass its current expected_sha256 before replacing it")
          if (args.action === "edit" && (previous === undefined || !args.operations?.length))
            throw new Error("edit requires an existing file and operations")
          if (args.action === "create" && !args.xml) throw new Error("create requires xml")
          const svg = await location(tool, `${file}.svg`)
          await permit(tool, "edit", [file, svg])
          const python = Bun.which("python3")
          if (!python) throw new Error("python3 is required for local XML validation")
          const script = drawioScript()
          await require(tool, {
            action: "shell",
            resources: [`${python} ${script}`],
            save: [`${python} ${script}`],
            metadata: { description: "Validate and render local Draw.io XML", argv: [python, script] },
          })
          const parsed: unknown = JSON.parse(
            await run([python, script], {
              cwd: ctx.location.directory,
              signal: tool.signal,
              timeout: 10_000,
              input: JSON.stringify({
                xml: args.action === "edit" ? previous : args.xml,
                operations: args.action === "edit" ? args.operations : [],
              }),
            }),
          )
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("xml" in parsed) ||
            typeof parsed.xml !== "string" ||
            !("svg" in parsed) ||
            typeof parsed.svg !== "string" ||
            !("cells" in parsed) ||
            typeof parsed.cells !== "number"
          )
            throw new Error("Draw.io validator returned an invalid result")
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
          await save(file, result.xml, tool.signal)
          await save(svg, result.svg, tool.signal)
          return {
            content: JSON.stringify({
              path: file,
              preview: svg,
              cells: result.cells,
              sha256: Bun.CryptoHasher.hash("sha256", result.xml, "hex"),
              open: "Open the .drawio in diagrams.net Desktop or the VS Code Draw.io extension; the .svg preview opens locally in any browser.",
            }),
            metadata: { path: file, preview: svg },
          }
        },
      })

      editor.add({
        name: "marker",
        options: { codemode: false },
        description:
          "Convert a local PDF to workspace Markdown, JSON, or HTML with the separately installed Marker CLI. Conversion has no network access or cloud LLM. Default CPU fast mode reads digital PDF text; local OCR is opt-in and needs cached OCR weights. engine=text explicitly uses pdftotext for a lightweight text-only Markdown fallback. Output directory must be new; cancellation/timeout removes partial output.",
        input: {
          type: "object",
          properties: {
            input: { type: "string", description: "Local PDF path; URLs are not supported" },
            output_dir: {
              type: "string",
              description: "New workspace-relative or absolute directory for conversion artifacts",
            },
            engine: { type: "string", enum: ["marker", "text"] },
            format: { type: "string", enum: ["markdown", "json", "html"] },
            ocr: { type: "boolean" },
            page_range: {
              type: "string",
              description: "Marker page indices, starting at zero, e.g. 0,2-4",
            },
            timeout_seconds: { type: "integer", minimum: 1, maximum: 1800 },
          },
          required: ["input", "output_dir"],
          additionalProperties: false,
        },
        execute: async (input, tool) => {
          const args = input as {
            input: string
            output_dir: string
            engine?: "marker" | "text"
            format?: "markdown" | "json" | "html"
            ocr?: boolean
            page_range?: string
            timeout_seconds?: number
          }
          const engine = args.engine ?? "marker"
          const format = args.format ?? "markdown"
          const ocr = args.ocr ?? false
          if (/^[a-z][a-z\d+.-]*:\/\//i.test(args.input)) throw new Error("Only local PDFs are supported")
          if (engine === "text" && (format !== "markdown" || ocr || args.page_range))
            throw new Error("text mode supports Markdown only, without OCR/page_range")
          const inputFile = await location(tool, args.input)
          const output = await location(tool, args.output_dir)
          await permit(tool, "read", [inputFile])
          if (!(await stat(inputFile)).isFile() || path.extname(inputFile).toLowerCase() !== ".pdf")
            throw new Error("Input must be a local PDF file")
          if ((await stat(inputFile)).size > 200 * 1024 * 1024)
            throw new Error("Input exceeds 200 MiB; split the PDF first")
          await permit(tool, "edit", [output])
          if ((await Bun.file(output).exists()) || (await stat(output).then(() => true).catch(() => false)))
            throw new Error("output_dir already exists; choose a new directory")
          const binary = Bun.which(engine === "marker" ? "marker_single" : "pdftotext")
          if (!binary)
            throw new Error(
              engine === "marker"
                ? "Marker is not installed. Run the documented isolated Marker setup; use engine=text for an explicit text-only fallback."
                : "pdftotext is not installed",
            )
          const sandbox = engine === "marker" ? Bun.which("bwrap") : undefined
          if (engine === "marker" && (!sandbox || process.platform !== "linux"))
            throw new Error(
              "Marker requires Linux bubblewrap for local-only conversion; use engine=text or configure a separately reviewed local runner",
            )
          const command = engine === "marker" ? [binary, inputFile, "--output_format", format, "--mode", "fast"] : [binary, "-layout", inputFile, "-"]
          await require(tool, {
            action: "shell",
            resources: [command.join(" ")],
            save: [`${binary} *`],
            metadata: {
              argv: command,
              input: inputFile,
              output,
              timeout_seconds: args.timeout_seconds ?? 300,
              network: "disabled",
              ocr,
            },
          })
          tool.signal.throwIfAborted()
          await mkdir(path.dirname(output), { recursive: true })
          const temporary = await mkdtemp(path.join(path.dirname(output), ".document-convert-"))
          try {
            const artifact = path.join(temporary, "artifacts")
            await mkdir(artifact)
            if (engine === "text") {
              const text = await run(command, {
                cwd: temporary,
                signal: tool.signal,
                timeout: timeoutMs(args.timeout_seconds),
              })
              await writeFile(path.join(artifact, `${path.basename(inputFile, path.extname(inputFile))}.md`), text, {
                mode: 0o600,
              })
            } else {
              const config = path.join(temporary, "marker.json")
              const home = path.join(temporary, "home")
              await mkdir(home)
              const font = [
                "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
              ].find((file) => Bun.file(file).size > 0)
              if (!font)
                throw new Error("A local Noto Sans or DejaVu Sans font is required; no font is downloaded during conversion")
              await writeFile(
                config,
                JSON.stringify({
                  use_llm: false,
                  disable_ocr: !ocr,
                  extract_images: false,
                  disable_tqdm: true,
                  pdftext_workers: 1,
                }),
                { mode: 0o600 },
              )
              const argv = [
                sandbox!,
                "--unshare-net",
                "--unshare-pid",
                "--die-with-parent",
                "--ro-bind",
                "/",
                "/",
                "--bind",
                temporary,
                temporary,
                "--tmpfs",
                "/tmp",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--chdir",
                temporary,
                "--",
                await realpath(binary),
                inputFile,
                "--output_dir",
                artifact,
                "--output_format",
                format,
                "--mode",
                "fast",
                "--disable_multiprocessing",
                "--disable_image_extraction",
                "--config_json",
                config,
                ...(args.page_range ? ["--page_range", args.page_range] : []),
              ]
              // Empty credentials and endpoint overrides cannot leak into Marker.
              // Model caches are read-only; all conversion-time downloads fail closed.
              await run(argv, {
                cwd: temporary,
                signal: tool.signal,
                timeout: timeoutMs(args.timeout_seconds),
                env: {
                  HOME: home,
                  PATH: process.env.PATH,
                  LANG: "C.UTF-8",
                  PYTHONUNBUFFERED: "1",
                  HF_HUB_OFFLINE: "1",
                  HF_HUB_DISABLE_TELEMETRY: "1",
                  TRANSFORMERS_OFFLINE: "1",
                  TORCH_DEVICE: "cpu",
                  OMP_NUM_THREADS: "4",
                  XDG_CACHE_HOME: path.join(temporary, "cache"),
                  HF_HOME: path.join(homedir(), ".cache", "huggingface"),
                  MODEL_CACHE_DIR: path.join(homedir(), ".cache", "datalab", "models"),
                  FONT_PATH: font,
                },
              })
            }
            const entries = await readdir(artifact, { recursive: true, withFileTypes: true })
            const files = entries
              .filter((entry) => entry.isFile())
              .map((entry) => path.relative(artifact, path.join(entry.parentPath, entry.name)))
            const extension = format === "markdown" ? ".md" : `.${format}`
            const primary = files.find((file) => file.endsWith(extension) && !file.endsWith("_meta.json"))
            if (!primary) throw new Error("Converter produced no primary artifact")
            tool.signal.throwIfAborted()
            await rename(artifact, output)
            return {
              content: JSON.stringify({
                engine,
                directory: output,
                files: files.map((file) => path.join(output, file)),
                primary: path.join(output, primary),
                preview: (await readFile(path.join(output, primary), "utf8")).slice(0, 12_000),
                network: "disabled",
                ocr,
              }),
              metadata: { directory: output, primary: path.join(output, primary) },
            }
          } finally {
            await rm(temporary, { recursive: true, force: true })
          }
        },
      })
    })
  },
} satisfies Plugin.Plugin

async function existingParent(value: string): Promise<string> {
  return realpath(value).catch(async () => {
    if (value === path.dirname(value)) throw new Error(`Cannot resolve ${value}`)
    return path.join(await existingParent(path.dirname(value)), path.basename(value))
  })
}

/** Own a numeric process group; timeout/cancel tears down its descendants too. Exported for script/local-tools.test.ts. */
export function run(
  argv: string[],
  options: { cwd: string; signal: AbortSignal; timeout: number; input?: string; env?: NodeJS.ProcessEnv },
): Promise<string> {
  // Reject NaN/Infinity/negative timeouts at the door: setTimeout coerces NaN
  // to 1 ms (instant SIGTERM of the child) and Bun prints TimeoutNaNWarning
  // straight to fd 2, garbling the alt-screen TUI.
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) {
    throw new Error(`run(): timeout must be a positive finite number of milliseconds, got ${options.timeout}`)
  }
  options.signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    const state = { bytes: 0, reason: "", settled: false, forced: undefined as ReturnType<typeof setTimeout> | undefined }
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        if (process.platform === "win32") child.kill(value)
        else process.kill(-child.pid, value)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
      }
    }
    const stop = (reason: string) => {
      if (state.reason) return
      state.reason = reason
      signal("SIGTERM")
      state.forced = setTimeout(() => signal("SIGKILL"), 500)
    }
    const timeout = setTimeout(() => stop(`Timed out after ${options.timeout} ms`), options.timeout)
    const abort = () => stop("Cancelled")
    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) abort()
    const capture = (target: Buffer[], chunk: Buffer) => {
      state.bytes += chunk.length
      if (state.bytes > 4 * 1024 * 1024) return stop("Process output exceeded 4 MiB")
      target.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => capture(output, chunk))
    child.stderr.on("data", (chunk: Buffer) => capture(errors, chunk))
    child.stdin.on("error", () => {})
    child.stdin.end(options.input)
    const finish = (error?: Error) => {
      if (state.settled) return
      state.settled = true
      clearTimeout(timeout)
      if (state.forced) clearTimeout(state.forced)
      options.signal.removeEventListener("abort", abort)
      // A successful parent may leave a worker behind. This group belongs only
      // to this tool call, never the OpenCode/TUI process group.
      signal("SIGKILL")
      if (error) return reject(error)
      resolve(Buffer.concat(output).toString())
    }
    child.once("error", (error) => finish(error))
    child.once("close", (code) => {
      const detail = Buffer.concat(errors).toString().slice(-6000)
      finish(state.reason || code !== 0 ? new Error(`${state.reason || `Process exited ${code}`}\n${detail}`) : undefined)
    })
  })
}

async function save(file: string, content: string, signal: AbortSignal) {
  signal.throwIfAborted()
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${crypto.randomUUID()}`
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    signal.throwIfAborted()
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

// Coerce the default ourselves: a missing schema default must never reach
// setTimeout as NaN.
function timeoutMs(seconds: number | undefined): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 300
  return Math.floor(value) * 1000
}

// Installed layout: ~/.config/opencode/plugin/local-tools.ts ->
// ~/.config/opencode/lib/drawio.py. Repo layout (tests): bootstrap/plugin/ ->
// dotfiles/opencode/lib/drawio.py.
function drawioScript() {
  const candidates = [
    fileURLToPath(new URL("../lib/drawio.py", import.meta.url)),
    fileURLToPath(new URL("../../dotfiles/opencode/lib/drawio.py", import.meta.url)),
  ]
  const found = candidates.find((file) => existsSync(file))
  if (!found)
    throw new Error(`drawio validator not found; run bootstrap/install.sh (looked at: ${candidates.join(", ")})`)
  return found
}
