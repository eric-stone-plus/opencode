import { tool } from "@opencode-ai/plugin"
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { location, permit, run } from "../lib/local-tools"

export default tool({
  description:
    "Convert a local PDF to workspace Markdown, JSON, or HTML with the separately installed Marker CLI. Conversion has no network access or cloud LLM. Default CPU fast mode reads digital PDF text; local OCR is opt-in and needs cached OCR weights. engine=text explicitly uses pdftotext for a lightweight text-only Markdown fallback. Output directory must be new; cancellation/timeout removes partial output.",
  args: {
    input: tool.schema.string().describe("Local PDF path; URLs are not supported"),
    output_dir: tool.schema.string().describe("New workspace-relative or absolute directory for conversion artifacts"),
    engine: tool.schema.enum(["marker", "text"]).default("marker"),
    format: tool.schema.enum(["markdown", "json", "html"]).default("markdown"),
    ocr: tool.schema.boolean().default(false),
    page_range: tool.schema.string().regex(/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/).optional().describe("Marker page indices, starting at zero, e.g. 0,2-4"),
    timeout_seconds: tool.schema.number().int().min(1).max(1800).default(300),
  },
  async execute(args, context) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(args.input)) throw new Error("Only local PDFs are supported")
    if (args.engine === "text" && (args.format !== "markdown" || args.ocr || args.page_range)) throw new Error("text mode supports Markdown only, without OCR/page_range")
    const input = await location(context, args.input)
    const output = await location(context, args.output_dir)
    await permit(context, "read", [input])
    if (!(await stat(input)).isFile() || path.extname(input).toLowerCase() !== ".pdf") throw new Error("Input must be a local PDF file")
    if ((await stat(input)).size > 200 * 1024 * 1024) throw new Error("Input exceeds 200 MiB; split the PDF first")
    await permit(context, "edit", [output])
    if (await Bun.file(output).exists() || await stat(output).then(() => true).catch(() => false)) throw new Error("output_dir already exists; choose a new directory")
    const binary = Bun.which(args.engine === "marker" ? "marker_single" : "pdftotext")
    if (!binary) throw new Error(args.engine === "marker" ? "Marker is not installed. Run the documented isolated Marker setup; use engine=text for an explicit text-only fallback." : "pdftotext is not installed")
    const sandbox = args.engine === "marker" ? Bun.which("bwrap") : undefined
    if (args.engine === "marker" && (!sandbox || process.platform !== "linux")) throw new Error("Marker requires Linux bubblewrap for local-only conversion; use engine=text or configure a separately reviewed local runner")
    const command = args.engine === "marker" ? [binary, input, "--output_format", args.format, "--mode", "fast"] : [binary, "-layout", input, "-"]
    await context.ask({
      permission: "bash",
      patterns: [command.join(" ")],
      always: [`${binary} *`],
      metadata: { argv: command, input, output, timeout_seconds: args.timeout_seconds, network: "disabled", ocr: args.ocr },
    })
    context.abort.throwIfAborted()
    await mkdir(path.dirname(output), { recursive: true })
    const temporary = await mkdtemp(path.join(path.dirname(output), ".document-convert-"))
    try {
      const artifact = path.join(temporary, "artifacts")
      await mkdir(artifact)
      if (args.engine === "text") {
        const text = await run(command, { cwd: temporary, signal: context.abort, timeout: args.timeout_seconds * 1000 })
        await writeFile(path.join(artifact, `${path.basename(input, path.extname(input))}.md`), text, { mode: 0o600 })
      } else {
        const config = path.join(temporary, "marker.json")
        const home = path.join(temporary, "home")
        await mkdir(home)
        const font = [
          "/usr/share/fonts/google-noto-vf/NotoSans[wght].ttf",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ].find((file) => Bun.file(file).size > 0)
        if (!font) throw new Error("A local Noto Sans or DejaVu Sans font is required; no font is downloaded during conversion")
        await writeFile(config, JSON.stringify({ use_llm: false, disable_ocr: !args.ocr, extract_images: false, disable_tqdm: true, pdftext_workers: 1 }), { mode: 0o600 })
        const argv = [sandbox!, "--unshare-net", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--bind", temporary, temporary, "--tmpfs", "/tmp", "--proc", "/proc", "--dev", "/dev", "--chdir", temporary, "--", await realpath(binary), input, "--output_dir", artifact, "--output_format", args.format, "--mode", "fast", "--disable_multiprocessing", "--disable_image_extraction", "--config_json", config, ...(args.page_range ? ["--page_range", args.page_range] : [])]
        // Empty credentials and endpoint overrides cannot leak into Marker.
        // Model caches are read-only; all conversion-time downloads fail closed.
        await run(argv, {
          cwd: temporary,
          signal: context.abort,
          timeout: args.timeout_seconds * 1000,
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
      const files = entries.filter((entry) => entry.isFile()).map((entry) => path.relative(artifact, path.join(entry.parentPath, entry.name)))
      const extension = args.format === "markdown" ? ".md" : `.${args.format}`
      const primary = files.find((file) => file.endsWith(extension) && !file.endsWith("_meta.json"))
      if (!primary) throw new Error("Converter produced no primary artifact")
      context.abort.throwIfAborted()
      await rename(artifact, output)
      return {
        title: `Converted ${path.basename(input)}`,
        output: JSON.stringify({ engine: args.engine, directory: output, files: files.map((file) => path.join(output, file)), primary: path.join(output, primary), preview: (await readFile(path.join(output, primary), "utf8")).slice(0, 12_000), network: "disabled", ocr: args.ocr }),
        metadata: { directory: output, primary: path.join(output, primary) },
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  },
})
