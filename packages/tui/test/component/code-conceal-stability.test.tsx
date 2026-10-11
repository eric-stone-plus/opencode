/** @jsxImportSource @opentui/solid */
// Regression: CoT / reasoning-stream horizontal twitch (A..B..A column flip).
//
// Root cause (diagnosing-bugs): the patched CodeRenderable streaming branch in
// @opentui/core writes the RAW markdown on every delta
// (patches/@opentui%2Fcore@0.4.5.patch, `set content`), while every highlight
// resolution writes the CONCEALED styled text
// (treeSitterToTextChunks(..., { enabled: this._conceal })) which deletes
// `**`/`#`/backtick markers (assets/markdown{,_inline}/highlights.scm
// `(#set! conceal "")`). Successive frames therefore alternate between two
// different horizontal layouts of the same stable characters.
//
// RED criterion (the user's symptom): a settled anchor must never REVISIT a
// (row, col) position it already left (A..B..A = the twitch). A single one-way
// settle (raw layout -> concealed layout when the first highlight lands, or
// when a `**span**` closes late) is allowed — that is inherent to async
// highlighting and is not the reported bug. Style-only and never-resolving
// streams must be fully stable (zero moves) and must keep content visible
// (anti-freeze guard from 3c570a14be).
//
// Deterministic: no real timers. Each flush()/renderOnce() pair is one
// simulated frame; highlight resolution (MockTreeSitterClient) is injected at
// explicit frame boundaries.
//
// Run: cd packages/tui && bun test test/component/code-conceal-stability.test.tsx

import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { RGBA, SyntaxStyle } from "@opentui/core"
import { MockTreeSitterClient } from "@opentui/core/testing"
import { reasoningSummary } from "../../src/context/thinking"

// ---------------------------------------------------------------------------
// Frame analysis: exact cell columns via the renderer char grid.
//
// captureCharFrame() decodes one character per non-continuation cell, so
// decoded-line char index -> cell column maps 1:1 through the
// non-continuation cells of the char buffer (double-width chars = 2 cells).
// ---------------------------------------------------------------------------

const CHAR_FLAG_CONTINUATION = 3221225472 | 0 // from @opentui/core getSpanLines

interface App {
  flush: () => Promise<void>
  renderOnce: () => Promise<void>
  captureCharFrame: () => string
  renderer: {
    currentRenderBuffer: { width: number; height: number; buffers: { char: Uint32Array } }
    destroy: () => void
  }
}

function cellColOf(app: App, row: number, charIdx: number): number {
  const buf = app.renderer.currentRenderBuffer
  const { char } = buf.buffers
  let seen = 0
  for (let x = 0; x < buf.width; x++) {
    const cp = char[row * buf.width + x]!
    if ((cp & CHAR_FLAG_CONTINUATION) === CHAR_FLAG_CONTINUATION) continue
    if (seen === charIdx) return x
    seen++
  }
  return -1
}

interface Pos {
  frame: number
  row: number
  col: number
}

function anchorPositions(app: App, frameIdx: number, anchor: string): Pos[] {
  const lines = app.captureCharFrame().split("\n")
  const out: Pos[] = []
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!
    let idx = line.indexOf(anchor)
    while (idx >= 0) {
      out.push({ frame: frameIdx, row, col: cellColOf(app, row, idx) })
      idx = line.indexOf(anchor, idx + 1)
    }
  }
  return out
}

interface Violation {
  anchor: string
  kind: "revisit" | "wrap-revisit" | "drift" | "presence-flicker"
  detail: string
}

/**
 * No-revisit criterion:
 *  - a (row,col) position left for a different one must never be occupied
 *    again (A..B..A = the twitch; one-way settle A->B is allowed);
 *  - an anchor must not disappear and come back with unchanged surrounding
 *    text (presence flicker);
 *  - when `requireNoMoves`, any movement at all is a violation (style-only and
 *    never-resolving streams have width-stable layouts by construction);
 *  - when `maxMoves` is set, more than that many moves is drift.
 */
function analyze(
  label: string,
  anchors: string[],
  hist: Record<string, Pos[]>,
  opts: { requireNoMoves?: boolean; maxMoves?: number } = {},
): { label: string; sequences: Record<string, string[]>; violations: Violation[] } {
  const sequences: Record<string, string[]> = {}
  const violations: Violation[] = []
  for (const anchor of anchors) {
    const seq = hist[anchor] ?? []
    sequences[anchor] = seq.map((p) => `f${p.frame}@r${p.row}c${p.col}`)
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1]!
      const cur = seq[i]!
      if (cur.frame > prev.frame + 1) {
        violations.push({
          anchor,
          kind: "presence-flicker",
          detail: `absent frames ${prev.frame + 1}..${cur.frame - 1} between f${prev.frame} and f${cur.frame}`,
        })
      }
    }
    const seen = new Map<string, number>()
    let moves = 0
    for (let i = 0; i < seq.length; i++) {
      const p = seq[i]!
      const key = `${p.row}:${p.col}`
      if (i > 0) {
        const q = seq[i - 1]!
        const moved = p.col !== q.col || p.row !== q.row
        if (moved) moves++
        const revisit = seen.has(key) && key !== `${q.row}:${q.col}`
        if (revisit) {
          violations.push({
            anchor,
            kind: p.row !== q.row ? "wrap-revisit" : "revisit",
            detail: `f${q.frame}@r${q.row}c${q.col} -> f${p.frame}@r${p.row}c${p.col} revisits r${p.row}c${p.col} (A..B..A)`,
          })
        } else if (moved && opts.requireNoMoves) {
          violations.push({
            anchor,
            kind: "drift",
            detail: `f${q.frame}@r${q.row}c${q.col} -> f${p.frame}@r${p.row}c${p.col} in a width-stable scenario`,
          })
        }
      }
      if (!seen.has(key)) seen.set(key, i)
    }
    if (opts.maxMoves !== undefined && moves > opts.maxMoves) {
      violations.push({
        anchor,
        kind: "drift",
        detail: `${moves} moves > allowed ${opts.maxMoves}: ${sequences[anchor]!.join(" ")}`,
      })
    }
  }
  return { label, sequences, violations }
}

function expectStable(
  r: { label: string; sequences: Record<string, string[]>; violations: Violation[] },
  expectedViolations = 0,
) {
  if (r.violations.length !== expectedViolations) {
    console.log(`\n=== ${r.label} ===`)
    for (const [anchor, seq] of Object.entries(r.sequences)) console.log(`  ${anchor}: ${seq.join(" ")}`)
    for (const v of r.violations) console.log(`   ! [${v.kind}] ${v.anchor}: ${v.detail}`)
  }
  expect(r.violations.length).toBe(expectedViolations)
}

// ---------------------------------------------------------------------------
// Highlight fixtures matching production capture semantics:
// assets/markdown_inline/highlights.scm conceals emphasis delimiters with
// `(#set! conceal "")`; injection-derived delimiters carry `isInjection`,
// which suppresses the follow-space eat in treeSitterToTextChunks.
// Offsets are computed against the code element's CURRENT content.
// ---------------------------------------------------------------------------

type HL = [number, number, string, Record<string, unknown>]

function concealMarkdownHighlights(text: string): HL[] {
  const hs: HL[] = []
  const bold = /\*\*[^*\n]+\*\*/g
  for (let m: RegExpExecArray | null; (m = bold.exec(text)); ) {
    hs.push([m.index, m.index + 2, "conceal", { conceal: "", isInjection: true }])
    hs.push([m.index + m[0].length - 2, m.index + m[0].length, "conceal", { conceal: "", isInjection: true }])
  }
  return hs
}

function styleOnlyHighlights(text: string): HL[] {
  const hs: HL[] = []
  const word = /[A-Za-z_][A-Za-z_0-9]*/g
  for (let m: RegExpExecArray | null; (m = word.exec(text)); ) {
    hs.push([m.index, m.index + m[0].length, "keyword", {}])
  }
  return hs
}

// ---------------------------------------------------------------------------
// Stream driver. interleave: "delta-render-resolve-render" = one highlight
// round-trip per delta (worst-case cadence for the flip); "never" = highlights
// never land (anti-freeze guard).
// ---------------------------------------------------------------------------

type Interleave = "delta-render-resolve-render" | "never"
type MockKind = "conceal-markdown" | "style-only" | "empty"

interface ScenarioOpts {
  label: string
  width: number
  height: number
  fullText: string
  chunks: string[]
  interleave: Interleave
  mockKind: MockKind
  anchors: string[]
  viaSummary?: boolean
}

async function runScenario(
  opts: ScenarioOpts,
  analyzeOpts: { requireNoMoves?: boolean; maxMoves?: number } = {},
) {
  const mock = new MockTreeSitterClient()
  const style = SyntaxStyle.fromStyles({})
  const [raw, setRaw] = createSignal("")
  const codeContent = () => {
    const text = raw()
    return opts.viaSummary ? reasoningSummary(text.trim()).body : text
  }
  const app = (await testRender(
    () => (
      <box width={opts.width} height={opts.height}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          treeSitterClient={mock}
          syntaxStyle={style}
          content={codeContent()}
          conceal={true}
          fg={RGBA.fromInts(128, 128, 128)}
        />
      </box>
    ),
    { width: opts.width, height: opts.height, useThread: false },
  )) as unknown as App

  const hist: Record<string, Pos[]> = {}
  for (const a of opts.anchors) hist[a] = []
  let frame = 0
  const capture = () => {
    for (const a of opts.anchors) hist[a]!.push(...anchorPositions(app, frame, a))
    frame++
  }
  const applyMock = () => {
    const text = codeContent()
    if (opts.mockKind === "conceal-markdown") mock.setMockResult({ highlights: concealMarkdownHighlights(text) as never })
    else if (opts.mockKind === "style-only") mock.setMockResult({ highlights: styleOnlyHighlights(text) as never })
    else mock.setMockResult({ highlights: [] })
  }
  try {
    await app.flush()
    capture()
    let acc = ""
    for (const chunk of opts.chunks) {
      acc += chunk
      setRaw(acc)
      await app.flush()
      await app.renderOnce()
      capture()
      if (opts.interleave === "delta-render-resolve-render") {
        applyMock()
        mock.resolveAllHighlightOnce()
        await app.flush()
        await app.renderOnce()
        capture()
      }
    }
  } finally {
    await mock.destroy().catch(() => {})
    app.renderer.destroy()
  }
  return analyze(opts.label, opts.anchors, hist, analyzeOpts)
}

// ---------------------------------------------------------------------------
// 1. f-min: minimal conceal flip. `**` markers are deleted by the conceal
//    pass, so the settled anchor S moves right/left with the marker width.
//    The bug: every delta rewrites the RAW text (S back at raw col), every
//    resolve writes the CONCEALED text (S at concealed col) -> A..B..A.
// ---------------------------------------------------------------------------

test("f-min: conceal markers must not flip settled columns across delta/resolve cycles", async () => {
  const r = await runScenario({
    label: "f-min",
    width: 80,
    height: 24,
    fullText: "**b** Sz",
    chunks: ["**b** S", "z"],
    interleave: "delta-render-resolve-render",
    mockKind: "conceal-markdown",
    anchors: ["S", "b"],
  })
  // One-way settle (raw -> concealed when the first highlight lands) allowed,
  // but the A..B..A revisit of the bug must not appear.
  expectStable(r)
}, 30000)

// ---------------------------------------------------------------------------
// 2. Span-close one-way settle (breakA): an unclosed `**` shows raw until the
//    closing `**` arrives and the highlight pass conceals it. That settle is
//    one-way; the bug additionally bounces back to the raw column on every
//    later delta.
// ---------------------------------------------------------------------------

test("span close settles one-way and never revisits the raw column", async () => {
  const r = await runScenario({
    label: "span-close",
    width: 80,
    height: 24,
    fullText: "x **b CZ** more",
    chunks: ["x **b C", "Z**", " more"],
    interleave: "delta-render-resolve-render",
    mockKind: "conceal-markdown",
    anchors: ["C", "x"],
  })
  expectStable(r)
  // x sits before every marker: its column must be fully stable. Sequence
  // entries are `f<frame>@r<row>c<col>`; strip the frame index and compare
  // positions only.
  const xSeq = r.sequences["x"]!
  expect(new Set(xSeq.map((s) => s.replace(/^f\d+/, ""))).size).toBe(1)
}, 30000)

// ---------------------------------------------------------------------------
// 3. Style-only highlights: no conceal, identical visible text on both write
//    paths -> zero movement, before and after the fix (ablation control).
// ---------------------------------------------------------------------------

test("style-only highlights never move columns", async () => {
  const r = await runScenario(
    {
      label: "style-only",
      width: 80,
      height: 24,
      fullText: "Alpha bravo STY1 charlie STY2 delta",
      chunks: ["Alpha bravo STY1", " charlie STY2", " delta"],
      interleave: "delta-render-resolve-render",
      mockKind: "style-only",
      anchors: ["STY1", "STY2"],
    },
    { requireNoMoves: true },
  )
  expectStable(r)
  expect(r.sequences["STY1"]!.length).toBeGreaterThan(0)
  expect(r.sequences["STY2"]!.length).toBeGreaterThan(0)
}, 30000)

// ---------------------------------------------------------------------------
// 4. Never-resolving highlights: content must stay visible (anti-freeze, the
//    property 3c570a14be bought) and the raw-consistent layout must be stable.
// ---------------------------------------------------------------------------

test("never-resolving highlights keep content visible and stable", async () => {
  const r = await runScenario(
    {
      label: "never-resolve",
      width: 80,
      height: 24,
      fullText: "Alpha NEVER1 bravo NEVER2 charlie end",
      chunks: ["Alpha NEVER1 bravo", " NEVER2 charlie", " end"],
      interleave: "never",
      mockKind: "empty",
      anchors: ["NEVER1", "NEVER2"],
    },
    { requireNoMoves: true },
  )
  expectStable(r)
  // anti-freeze: content must be on screen even though nothing resolved
  expect(r.sequences["NEVER1"]!.length).toBeGreaterThan(0)
  expect(r.sequences["NEVER2"]!.length).toBeGreaterThan(0)
}, 30000)

// ---------------------------------------------------------------------------
// 5. Wrap boundary: the marker-width flip moves a word across a line wrap.
//    Raw `**b** S` needs 6 columns and wraps at width 6; the concealed `b S`
//    fits on one line. The bug alternates the word between rows.
// ---------------------------------------------------------------------------

test("wrap-boundary word never flips rows/columns across cycles", async () => {
  const r = await runScenario({
    label: "wrap-boundary",
    width: 6,
    height: 8,
    fullText: "**b** S z",
    chunks: ["**b** S", " z"],
    interleave: "delta-render-resolve-render",
    mockKind: "conceal-markdown",
    anchors: ["S"],
  })
  expectStable(r)
}, 30000)

// ---------------------------------------------------------------------------
// 6. Real pipeline shape: content through reasoningSummary (as ReasoningPart
//    does at packages/tui/src/routes/session/index.tsx:1548-1613), title
//    completes first, then the body streams with a closed `**span**`.
//    Exercises the non-prefix body rewrite guard in the fix.
// ---------------------------------------------------------------------------

test("reasoningSummary body stream settles without column revisits", async () => {
  const r = await runScenario({
    label: "via-summary",
    width: 80,
    height: 24,
    fullText: "**T**\n\nAlpha **b** BRV1 tail",
    chunks: ["**T**", "\n", "\n", "Alpha **b** BRV1", " tail"],
    interleave: "delta-render-resolve-render",
    mockKind: "conceal-markdown",
    anchors: ["BRV1", "Alpha"],
  })
  expectStable(r)
}, 30000)
