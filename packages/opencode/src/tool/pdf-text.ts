const PDFTEXT_TIMEOUT_MS = 15_000
const PDFTEXT_MAX_CHARS = 200_000

async function run(command: string, args: string[], signal: AbortSignal) {
  signal.throwIfAborted()
  const proc = Bun.spawn([command, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    // piped stderr is never read here; a chatty child would deadlock past the 64KB pipe buffer
    stderr: "ignore",
  })
  const reader = proc.stdout.getReader()
  const stop = () => {
    // Extractors do not own durable work. SIGKILL also bounds tools that ignore SIGTERM.
    proc.kill("SIGKILL")
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  const decoder = new TextDecoder()
  let text = ""
  let truncated = false
  try {
    while (true) {
      const part = await reader.read()
      const chunk = (part.done ? decoder.decode() : decoder.decode(part.value, { stream: true })).replace(/\u0000/g, "")
      const remaining = PDFTEXT_MAX_CHARS - text.length
      text += chunk.slice(0, remaining)
      if (chunk.length > remaining) {
        truncated = true
        stop()
        break
      }
      if (part.done) break
    }
    const code = await proc.exited
    signal.throwIfAborted()
    if (!truncated && code !== 0) return
    const output = text.trim()
    if (!output) return
    return truncated ? `${output}\n\n[truncated]` : output
  } finally {
    signal.removeEventListener("abort", stop)
    stop()
    await proc.exited
  }
}

export async function extractPdfText(filepath: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  // A single deadline covers all attempts, so timing out cannot start another extractor.
  const deadline = AbortSignal.timeout(PDFTEXT_TIMEOUT_MS)
  const aborted = signal ? AbortSignal.any([signal, deadline]) : deadline
  const pdftotext = await run("pdftotext", ["-layout", "-enc", "UTF-8", "-nopgbrk", filepath, "-"], aborted).catch(
    () => undefined,
  )
  signal?.throwIfAborted()
  if (pdftotext) return pdftotext
  if (aborted.aborted) return

  // Each backend gets its own output buffer: a later-page error must not mix a
  // partial first extraction with a second extraction that starts at page one.
  for (const script of [
    "import sys\nfrom pypdf import PdfReader\nfor page in PdfReader(sys.argv[1]).pages:\n print(page.extract_text() or '', flush=True)",
    "import sys, fitz\nwith fitz.open(sys.argv[1]) as doc:\n for page in doc:\n  print(page.get_text(), flush=True)",
  ]) {
    const python = await run("python3", ["-c", script, filepath], aborted).catch(() => undefined)
    signal?.throwIfAborted()
    if (python) return python
    if (aborted.aborted) return
  }
}
