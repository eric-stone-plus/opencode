import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { contextUsage, formatContextUsage } from "../../util/session"
import { useTerminalDimensions } from "@opentui/solid"
import { stringWidth } from "../../util/string-width"
import { useConfig } from "../../config"
import { Locale } from "../../util/locale"
import { formatTokenRate, streamingOutputEstimate, timeToFirstToken, tokensPerSecond } from "../../util/token-rate"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function PromptFooter(props: {
  context: Plugin.Context
  sessionID?: string
  mode: "normal" | "shell"
  showDetails: boolean
}) {
  const dimensions = useTerminalDimensions()
  const config = useConfig().data
  const [liveHovered, setLiveHovered] = createSignal(false)
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.session
      .family(props.sessionID)
      .filter((id) => id !== props.sessionID && props.context.data.session.status(id) === "running").length
    return count ? `${count} subagent${count === 1 ? "" : "s"}` : undefined
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.shell
      .list(props.context.location)
      .filter((shell) => shell.metadata.sessionID === props.sessionID).length
    return count ? `${count} shell${count === 1 ? "" : "s"}` : undefined
  })
  const status = createMemo(() => {
    if (!props.sessionID) return []
    const session = props.context.data.session.get(props.sessionID)
    if (!session) return []
    const messages = props.context.data.session.message.list(props.sessionID)
    const usage = contextUsage(
      messages,
      props.context.data.location.model.list(session.location),
      session.revert?.messageID,
    )
    const cost = props.context.data.session.cost(props.sessionID)
    // Generated output (visible + reasoning) over the family the cost cell covers: settled
    // receipts plus a chars/4 estimate of the in-flight step, so the count ticks while the
    // model streams and settles to the receipt. Same estimate as codewhale's strip.
    const own = (id: string) => {
      const info = props.context.data.session.get(id)
      return (info?.tokens?.output ?? 0) + (info?.tokens?.reasoning ?? 0)
    }
    const family = props.context.data.session.family(props.sessionID)
    const settled = session.parentID
      ? own(props.sessionID)
      : (family.length > 0 ? family : [props.sessionID]).reduce((total, id) => total + own(id), 0)
    const generated = settled + streamingOutputEstimate(messages)
    // Speed cells follow the TPS setting; both are omitted until a settled step has measured them.
    const ttft = config.session.tps ? timeToFirstToken(messages) : undefined
    const rate = config.session.tps ? tokensPerSecond(messages) : undefined
    // Cache hit rate over this conversation's own requests (the same scope as the speed
    // cells): reads / (reads + uncached input + writes), omitted until tokens arrive.
    const cacheHit = session.tokens?.cache?.read ?? 0
    const cacheMiss = session.tokens?.input ?? 0
    const cacheWrite = session.tokens?.cache?.write ?? 0
    const cacheTotal = cacheHit + cacheMiss + cacheWrite
    const cache = cacheTotal > 0 ? Math.round((cacheHit * 100) / cacheTotal) : undefined
    return [
      usage ? formatContextUsage(usage.tokens, usage.percent) : undefined,
      cost > 0 ? money.format(cost) : undefined,
      ttft === undefined ? undefined : `TTFT avg ${Locale.duration(Math.round(ttft))}`,
      rate === undefined ? undefined : formatTokenRate(rate),
      cache === undefined ? undefined : `cache ${cache}%`,
      generated > 0 ? `↓ ${Locale.number(generated)}` : undefined,
    ].filter((item): item is string => Boolean(item))
  })
  const live = createMemo(() => Boolean(subagents() || shells()))
  const shortcut = (id: string) => props.context.keymap.shortcuts(id)[0]
  const layout = createMemo(() => {
    const command = shortcut("command.palette.show")
    if (status().length === 0) return { usage: false, shortcuts: dimensions().width >= 44 }
    return promptFooterLayout({
      width: Math.max(0, dimensions().width - 8),
      usage: status(),
      shortcuts: command ? [`${command} commands`] : [],
    })
  })

  return (
    <Switch>
      <Match when={props.mode === "normal"}>
        <Switch>
          <Match when={live() || status().length > 0}>
            <box flexDirection="row" flexShrink={props.showDetails && layout().usage ? 0 : 1} minWidth={0}>
              <Show when={live()}>
                <box
                  flexShrink={0}
                  onMouseOver={() => setLiveHovered(true)}
                  onMouseOut={() => setLiveHovered(false)}
                  onMouseUp={() => props.context.keymap.dispatch("session.child.first")}
                >
                  <text
                    fg={liveHovered() ? props.context.theme.text.base : props.context.theme.text.muted}
                    wrapMode="none"
                  >
                    <Show when={shortcut("session.child.first")}>
                      {(value) => <span style={{ fg: props.context.theme.text.base }}>{value()} </span>}
                    </Show>
                    <Show when={subagents()}>{(value) => <>{value()}</>}</Show>
                    <Show when={subagents() && shells()}> · </Show>
                    <Show when={shells()}>{(value) => <>{value()}</>}</Show>
                  </text>
                </box>
              </Show>
              <Show when={props.showDetails && layout().usage && status().length > 0}>
                <text fg={props.context.theme.text.muted} wrapMode="none" flexShrink={0}>
                  <Show when={live()}> · </Show>
                  {status().join(" · ")}
                </text>
              </Show>
            </box>
          </Match>
          <Match when={props.showDetails && layout().shortcuts}>
            <text fg={props.context.theme.text.base} flexShrink={0}>
              {shortcut("agent.cycle")} <span style={{ fg: props.context.theme.text.muted }}>agents</span>
            </text>
          </Match>
        </Switch>
        <Show when={props.showDetails && layout().shortcuts}>
          <text fg={props.context.theme.text.base} wrapMode="none" flexShrink={0}>
            {shortcut("command.palette.show")} <span style={{ fg: props.context.theme.text.muted }}>commands</span>
          </text>
        </Show>
      </Match>
      <Match when={props.mode === "shell"}>
        <text fg={props.context.theme.text.base} flexShrink={0}>
          esc{" "}
          <span style={{ fg: props.context.theme.text.muted }}>
            {dimensions().width < 44 ? "shell" : "exit shell mode"}
          </span>
        </text>
      </Match>
    </Switch>
  )
}

export default Plugin.define({
  id: "opencode.prompt.footer",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => (
        <PromptFooter context={context} sessionID={props.sessionID} mode={props.mode} showDetails={props.showDetails} />
      ),
    })
  },
})

function promptFooterLayout(input: { width: number; usage: string[]; shortcuts: string[] }) {
  const usage = input.usage.join(" · ")
  const shortcuts = input.shortcuts.join(" · ")
  const available = Math.max(0, input.width - Math.min(28, Math.floor(input.width / 2)))
  if (usage && shortcuts && stringWidth(`${usage} · ${shortcuts}`) <= available) {
    return { usage: true, shortcuts: true }
  }
  if (usage && stringWidth(usage) <= available) return { usage: true, shortcuts: false }
  if (!usage && shortcuts && stringWidth(shortcuts) <= available) return { usage: false, shortcuts: true }
  return { usage: false, shortcuts: false }
}
