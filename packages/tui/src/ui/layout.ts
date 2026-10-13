export const SESSION_SIDEBAR_WIDTH = 42
const SESSION_CONTENT_MIN_WIDTH = 44

export function clampSessionPaneWidth(width: number, total: number) {
  const half = Math.max(1, Math.floor(total / 2))
  // Preserve the equal split when there is not enough room for both pane minima.
  return Math.max(Math.min(24, half), Math.min(width, Math.max(half, total - SESSION_CONTENT_MIN_WIDTH)))
}
