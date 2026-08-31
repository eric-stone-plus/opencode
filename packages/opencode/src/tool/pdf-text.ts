const PDFTEXT_TIMEOUT_MS = 15_000
const PDFTEXT_MAX_CHARS = 200_000

async function run(command: string, args: string[]) {
  const proc = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill(), PDFTEXT_TIMEOUT_MS)
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return
    const text = stdout.replace(/\u0000/g, "").trim()
    if (!text) return
    return text.length > PDFTEXT_MAX_CHARS ? `${text.slice(0, PDFTEXT_MAX_CHARS)}\n\n[truncated]` : text
  } finally {
    clearTimeout(timer)
  }
}

export async function extractPdfText(filepath: string) {
  const pdftotext = await run("pdftotext", ["-layout", "-enc", "UTF-8", "-nopgbrk", filepath, "-"]).catch(() => undefined)
  if (pdftotext) return pdftotext

  const python = await run("python3", [
    "-c",
    "import sys\nfrom pathlib import Path\np=Path(sys.argv[1])\ntext=''\ntry:\n from pypdf import PdfReader\n r=PdfReader(str(p))\n text='\\n'.join((pg.extract_text() or '') for pg in r.pages)\nexcept Exception:\n try:\n  import fitz\n  doc=fitz.open(p)\n  text='\\n'.join(page.get_text() for page in doc)\n except Exception:\n  sys.exit(2)\nprint(text)",
    filepath,
  ]).catch(() => undefined)
  if (python) return python
}
