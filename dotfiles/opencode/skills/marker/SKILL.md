---
name: marker
description: Convert a local PDF to structured Markdown, JSON, or HTML artifacts with a separate local Marker CLI, or pull text from any local PDF (including verifying or grepping a generated PDF text layer) - use this instead of ad-hoc pdftotext.
---

Use `marker(input, output_dir)` with a local PDF and a new workspace output
directory. Defaults are CPU fast mode, Markdown, no OCR, and a 300-second limit.
The tool returns artifact paths and a bounded preview; inspect the primary file
with `read` as needed. Existing output directories are preserved.

- `format` supports `markdown`, `json`, and `html` with Marker.
- `page_range` uses zero-based indices, such as `0,2-4`.
- `ocr: true` requires locally cached OCR weights and may take substantially
  longer. It never enables a cloud LLM. If weights are missing, report the error;
  do not silently upload the document or install a GPU stack.
- `engine: "text"` explicitly chooses `pdftotext -layout` for digital PDFs and
  writes a `.md` text artifact. It does not reconstruct layout/tables like Marker,
  and does not OCR scans. Explain that limitation if using this fallback.
- Conversion runs with host read/edit/bash permissions, a time limit, and cancel
  propagation. Marker runs in a Linux network/PID namespace; no credentials or
  model endpoint overrides are inherited. Partial output is removed on failure.

Marker is installed in its own `uv tool` environment, separate from OpenCode.
Code: Apache-2.0 at `datalab-to/marker` revision
`e7c67f1d239ea6a805cbf4ed6c6b2056d435e22d` (2.0.0). Model weights have separate
terms; installing the CLI does not copy them into the OpenCode repository.
