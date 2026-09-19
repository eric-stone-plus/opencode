import type { CliRenderer } from "@opentui/core"

/** Codex-style idle: don't keep a 60fps loop after the agent stops. */
export const IDLE_FPS = 8
export const BUSY_FPS = 30

type Renderer = Pick<CliRenderer, "targetFps" | "maxFps">
const budgets = new WeakMap<Renderer, { busy: boolean; animations: Set<symbol> }>()

function budget(renderer: Renderer) {
  const current = budgets.get(renderer)
  if (current) return current
  const next = { busy: false, animations: new Set<symbol>() }
  budgets.set(renderer, next)
  return next
}

export function applyRenderBudget(renderer: Renderer, busy: boolean) {
  budget(renderer).busy = busy
  update(renderer)
}

export function requestAnimationBudget(renderer: Renderer) {
  const current = budget(renderer)
  const id = Symbol()
  current.animations.add(id)
  update(renderer)
  return () => {
    if (!current.animations.delete(id)) return
    update(renderer)
  }
}

function update(renderer: Renderer) {
  const current = budget(renderer)
  const fps = current.busy || current.animations.size > 0 ? BUSY_FPS : IDLE_FPS
  if (renderer.targetFps === fps && renderer.maxFps === fps) return
  renderer.targetFps = fps
  renderer.maxFps = fps
}
