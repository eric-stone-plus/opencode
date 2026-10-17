import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

export function PromptMetadataRow(props: {
  mode: "normal" | "shell"
  agent?: string
  model: string
  variant?: string
  muted: boolean
  highlight: RGBA
  agentAlpha: number
  modelAlpha: number
  variantAlpha: number
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => {
    if (props.mode === "shell") return { agent: props.agent ?? "Shell", model: "", variant: undefined }
    return promptMetadataLayout({
      width: Math.max(0, dimensions().width - (dimensions().width < 44 ? 9 : 13)),
      terminalWidth: dimensions().width,
      agent: props.agent ?? "",
      model: props.model,
      variant: props.variant,
    })
  })

  return (
    <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
      <Show
        when={(props.mode === "shell" || props.agent) && (layout().agent || layout().model)}
        fallback={<box height={1} />}
      >
        <Show when={layout().agent}>
          {(agent) => <text fg={fade(props.highlight, props.agentAlpha)}>{agent()}</text>}
        </Show>
        <Show when={props.mode === "normal" && layout().model}>
          <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Show when={layout().agent}>
              <text fg={fade(theme.text.muted, props.modelAlpha)}>·</text>
            </Show>
            <text
              flexShrink={1}
              minWidth={0}
              wrapMode="none"
              truncate
              fg={fade(props.muted ? theme.text.muted : theme.text.base, props.modelAlpha)}
            >
              {layout().model}
            </text>
            <Show when={layout().variant}>
              {(variant) => (
                <>
                  <text fg={fade(theme.text.muted, props.variantAlpha)}>·</text>
                  <text
                    fg={fade(theme.text.feedback.warning.base, props.variantAlpha)}
                    attributes={TextAttributes.BOLD}
                  >
                    {variant()}
                  </text>
                </>
              )}
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function fade(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

type Layout = {
  agent?: string
  model: string
  variant?: string
}

function promptMetadataLayout(input: {
  width: number
  terminalWidth: number
  agent: string
  model: string
  variant?: string
}) {
  const agent = input.terminalWidth < 44 ? undefined : input.agent
  const layout = { agent, model: input.model, variant: input.variant }
  if (stringWidth(text(layout)) <= input.width) return layout

  const prefix = agent ? `${agent} · ` : ""
  const suffix = input.variant ? ` · ${input.variant}` : ""
  return {
    agent,
    model: Locale.truncateWidth(
      input.model,
      Math.max(9, input.width - stringWidth(prefix) - stringWidth(suffix)),
    ).replace(/\s+…$/, "…"),
    variant: input.variant,
  }
}

function text(input: Layout) {
  return [
    ...(input.agent ? [input.agent] : []),
    ...(input.model ? [...(input.agent ? ["·"] : []), input.model] : []),
    ...(input.variant ? ["·", input.variant] : []),
  ].join(" ")
}
