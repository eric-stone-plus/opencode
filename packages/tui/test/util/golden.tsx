/** @jsxImportSource @opentui/solid */
import { testRender, type JSX } from "@opentui/solid"

// Golden rendering contracts for TUI surfaces the fork cares about. A storybook story renders real
// components but asserts nothing, so it cannot notice when an upstream refactor changes what a panel
// looks like; these helpers render a component at the sizes the fork actually ships in and hand the
// frame to `toMatchSnapshot`.
//
// Sizes: a narrow sidebar-ish frame, the default terminal, a wide terminal, and an ultrawide one.
// A layout that only breaks at one width is exactly what a single-size test misses.
export const GOLDEN_SIZES = [
  { width: 80, height: 24 },
  { width: 100, height: 30 },
  { width: 120, height: 32 },
  { width: 160, height: 40 },
] as const

// Trailing whitespace differs between renderers and widths without meaning anything, so it is
// trimmed; the frame is trimmed at the end for the same reason. Everything else is kept verbatim,
// including the padding and the muted markers, because those are what the contract is about.
export function normalizeFrame(frame: string) {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
}

export async function goldenFrame(component: () => JSX.Element, size: { width: number; height: number }) {
  const app = await testRender(component, { width: size.width, height: size.height })
  try {
    // Two passes: the first lays the tree out, the second captures the settled frame.
    await app.renderOnce()
    await app.renderOnce()
    return normalizeFrame(app.captureCharFrame())
  } finally {
    app.renderer.destroy()
  }
}

export async function goldenFrames(component: () => JSX.Element) {
  const frames: string[] = []
  for (const size of GOLDEN_SIZES) {
    frames.push(`--- ${size.width}x${size.height} ---\n${await goldenFrame(component, size)}`)
  }
  return frames.join("\n\n")
}
