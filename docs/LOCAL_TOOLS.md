# Local planning, diagrams, and document conversion

The three tools ship as the V2 plugin `bootstrap/plugin/local-tools.ts`
(installed to `~/.config/opencode/plugin/local-tools.ts` by `bootstrap/install.sh`
step 7; presence is audited by `bootstrap/verify.sh`). Its support files — the
drawio XML validator and the three skill files — are deployed separately:

```bash
bun run script/install-local-tools.ts
```

A hash manifest makes later installs refuse locally modified managed files.
Open a new OpenCode process to load the extensions; an already running host may
retain its cached registry. No provider/model settings or API keys are changed.

| Tool | Use | Output |
| --- | --- | --- |
| `planning` | Persist/recover long-task notes; reuse `plan_id` across sessions | `.planning/<plan_id>/{task_plan,findings,progress}.md` |
| `drawio` | Current model creates/edits XML locally; edits use cell IDs and SHA-256 | Editable `.drawio` plus basic `.drawio.svg` preview |
| `marker` | Local PDF conversion through a separate CPU CLI; explicit text fallback | New workspace directory with Markdown/JSON/HTML artifacts |

All tools gate through the host's permission service (`ctx.permission.assert`),
the same blocking gate the built-in tools use: file access requests read/edit
permission, paths outside the session location request `external_directory`
permission, and subprocesses request shell permission. Subprocesses receive
timeout/cancel signals. The user's permission policy remains authoritative.

## Planning and the existing goal

`planning` does not create another goal owner. `/goal`, the existing session goal
file, goal reminders, and completion rules remain unchanged. The skill has the
model initialize/read a selected workspace journal, record progress, and recover
the journal plus the current git diff after compaction or restart. A different
session must pass the original `plan_id` explicitly. Files are never overwritten
by initialization; writes require a hash from the preceding read. No new hooks,
autonomous loops, transcript scraping, or session-storage migrations are added.

## Editable local diagrams

The model supplies uncompressed mxCell XML in the same session. A stdlib Python
helper validates unique IDs, parent/source/target references, finite geometry,
and inactive local content before saving. ID-based operations update an existing
diagram only when the file hash still matches. XML parsing does not resolve
external entities. Remote images/URLs, compressed/multipage files, scriptable
content, and vendor-specific icon libraries are outside this small integration.

Open the `.drawio` in **diagrams.net Desktop** or the **Draw.io Integration** VS
Code extension. The sibling SVG opens locally in a browser; it is a basic layout
preview, not the full Draw.io rendering engine. No document is uploaded and the
Next.js app, Electron shell, telemetry, provider layer, and extra API-key UI are
not bundled into OpenCode.

## Marker setup and offline conversion

Marker runs in a separate `uv tool` environment. Install the reviewed CPU version:

```bash
uv tool install --python 3.12 --torch-backend cpu 'marker-pdf==2.0.0'
marker_single --help
```

The tool requires Linux `bubblewrap` (`bwrap`), Python, and a local Noto Sans or
DejaVu Sans font. Marker gets a read-only filesystem view plus one writable
scratch directory, a fresh network/PID namespace, a temporary home, no inherited
credentials or endpoint overrides, and offline model flags. The PID namespace
also retires Marker's detached local inference workers on exit/cancel. Output
is moved to the requested new directory only after conversion succeeds.

Prepare model weights separately before using Marker; conversion never downloads
them. CPU fast digital-PDF mode needs the `datalab-to/surya_layout2` weights in the
normal Hugging Face cache. OCR is off by default; `ocr: true` additionally needs
the OCR model and locally supported inference backend. The optional cloud LLM
path is disabled. Missing caches fail with an actionable error, not a hidden
upload or engine substitution. For a lightweight digital-PDF extraction without
models, explicitly select `engine: "text"` (Poppler `pdftotext -layout`, Markdown
only); this does not reconstruct Marker tables/layout or OCR image-only pages.

## Upstream review and license boundary

| Source | Reviewed revision | Decision |
| --- | --- | --- |
| [planning-with-files](https://github.com/OthmanAdi/planning-with-files) | `dab9d16fbd9314448b319d112e99f497d7638d89` | MIT; borrow three-file persistence/recovery, author a host-native skill; do not import hooks/loop ownership |
| [next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io) | `a45e5b6796ad8ee681ad357bf05446c11ef85fbf` | Apache-2.0; borrow editable XML/cell operations, implement a small local adapter; no source code or app copied |
| [Marker](https://github.com/datalab-to/marker) | `e7c67f1d239ea6a805cbf4ed6c6b2056d435e22d` (2.0.0) | Apache-2.0 code; subprocess integration only; weights have separate `MODEL_LICENSE` terms and are not vendored |

The fork contains independently written integration code and skills; upstream
projects remain separate installations. Weight licenses must be evaluated for
redistribution or uses outside the owner's local setup.

## Verification

Standalone battery for the tools plugin (from the repo root):

```bash
cd script && bun test local-tools.test.ts
```

The plugin file is covered by `bootstrap/plugin/tsconfig.json`
(`../../packages/plugin/node_modules/.bin/tsgo --noEmit -p bootstrap/plugin/tsconfig.json`),
and the permission gate it calls is pinned by
`packages/core/test/plugin/promise-tool-permission.test.ts`. Tests cover
recovery, nonoverwriting initialization, stale-edit refusal, permission
denials, real XML validation/edits, invalid graph refusal, child cancellation and
timeout, and real Poppler conversion. Marker itself is verified separately after
the isolated CLI/models are installed; stub results are never reported as a real
Marker conversion. Full browser/editor rendering and GPU/scanned-PDF OCR are
separate checks.
