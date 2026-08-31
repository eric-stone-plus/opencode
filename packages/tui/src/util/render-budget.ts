import type { CliRenderer } from "@opentui/core"

/** Codex-style idle: don't keep a 60fps loop after the agent stops. */
export const IDLE_FPS = 8
export const BUSY_FPS = 30

export function applyRenderBudget(renderer: Pick<CliRenderer, "targetFps" | "maxFps">, busy: boolean) {
  const fps = busy ? BUSY_FPS : IDLE_FPS
  if (renderer.targetFps === fps && renderer.maxFps === fps) return
  renderer.targetFps = fps
  renderer.maxFps = fps
}
