import { splitProps, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"

export interface ResizeHandleProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "onResize"> {
  direction: "horizontal" | "vertical"
  edge?: "start" | "end"
  size: number
  min: number
  max: number
  onResize: (size: number) => void
  onCollapse?: () => void
  /** Called while dragging when size crosses `collapseThreshold`. */
  onCollapseChange?: (collapsed: boolean) => void
  collapseThreshold?: number
}

export function ResizeHandle(props: ResizeHandleProps) {
  const i18n = useI18n()
  const [local, rest] = splitProps(props, [
    "direction",
    "edge",
    "size",
    "min",
    "max",
    "onResize",
    "onCollapse",
    "onCollapseChange",
    "collapseThreshold",
    "class",
    "classList",
  ])

  const handleMouseDown = (e: MouseEvent) => {
    if (e.detail > 1) return
    e.preventDefault()
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const start = local.direction === "horizontal" ? e.clientX : e.clientY

    const rtl =
      local.direction === "horizontal" &&
      e.currentTarget instanceof Element &&
      getComputedStyle(e.currentTarget).direction === "rtl"

    const startSize = local.size
    const min = local.min
    const max = local.max
    const threshold = local.collapseThreshold ?? 0
    const onResize = local.onResize
    const onCollapse = local.onCollapse
    const onCollapseChange = local.onCollapseChange
    let current = startSize
    let collapsed = false

    document.body.style.userSelect = "none"
    document.body.style.overflow = "hidden"

    const onMouseMove = (moveEvent: MouseEvent) => {
      const pos = local.direction === "horizontal" ? moveEvent.clientX : moveEvent.clientY

      const delta =
        local.direction === "vertical"
          ? edge === "end"
            ? pos - start
            : start - pos
          : (edge === "start") !== rtl
            ? start - pos
            : pos - start

      current = startSize + delta
      const nextCollapsed = threshold > 0 && current < threshold

      if (nextCollapsed !== collapsed) {
        collapsed = nextCollapsed
        onCollapseChange?.(collapsed)
      }

      onResize(Math.min(max, Math.max(min, current)))
    }

    const onMouseUp = () => {
      document.body.style.userSelect = ""
      document.body.style.overflow = ""
      document.removeEventListener("mousemove", onMouseMove)
      document.removeEventListener("mouseup", onMouseUp)

      if (collapsed) {
        onCollapse?.()

        return
      }

      onCollapseChange?.(false)
    }

    document.addEventListener("mousemove", onMouseMove)
    document.addEventListener("mouseup", onMouseUp)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const edge = local.edge ?? (local.direction === "vertical" ? "start" : "end")
    const rtl =
      local.direction === "horizontal" &&
      event.currentTarget instanceof Element &&
      getComputedStyle(event.currentTarget).direction === "rtl"
    // Positive when the pointer moving forward along the axis grows the panel; the drag path
    // applies the same mapping to `pos - start`, so both stay in step.
    const forward = local.direction === "vertical" ? edge === "end" : (edge === "start") === rtl
    const step = 16
    const posDelta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? step
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -step
          : 0
    const jump = event.key === "Home" ? local.min : event.key === "End" ? local.max : undefined
    if (posDelta === 0 && jump === undefined) return
    event.preventDefault()
    const next = jump ?? local.size + (forward ? posDelta : -posDelta)
    const clamped = Math.min(local.max, Math.max(local.min, next))
    const threshold = local.collapseThreshold ?? 0
    if (threshold > 0 && clamped < threshold) {
      local.onCollapseChange?.(true)
      local.onCollapse?.()

      return
    }
    local.onResize(clamped)
  }

  return (
    <div
      {...rest}
      role="separator"
      aria-orientation={local.direction === "horizontal" ? "vertical" : "horizontal"}
      aria-label={props["aria-label"] ?? i18n.t("ui.resizeHandle.separator")}
      aria-valuemin={local.min}
      aria-valuemax={local.max}
      aria-valuenow={local.size}
      tabIndex={0}
      data-component="resize-handle"
      data-direction={local.direction}
      data-edge={local.edge ?? (local.direction === "vertical" ? "start" : "end")}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  )
}
