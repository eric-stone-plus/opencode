import { TextAttributes } from "@opentui/core"
import { For, Show, createResource } from "solid-js"
import { useClient } from "../context/client"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"
import { usageModels, usageTotals, zeroCostModels } from "../util/usage"

/**
 * Session usage from `session.stats`, which reads the recorded step usage from the database
 * (not the loaded message window), scoped to this session and its subagents.
 */
export function DialogUsage(props: { sessionID: string }) {
  const client = useClient()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const [stats] = createResource(() => props.sessionID, (sessionID) =>
    client.api.session.stats({ session: sessionID, tools: "summary" }),
  )

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Usage
        </text>
        <text fg={theme.text.muted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <Show
        when={stats()}
        fallback={
          <Spinner color={theme.text.muted}>Loading usage…</Spinner>
        }
      >
        {(data) => (
          <box gap={1}>
            <box>
              <For each={usageTotals(data())}>
                {(row) => (
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.muted} flexShrink={0}>
                      {row.label}
                    </text>
                    <text fg={theme.text.base} wrapMode="word">
                      {row.value}
                    </text>
                  </box>
                )}
              </For>
            </box>
            <Show when={data().models.length > 0}>
              <box gap={0}>
                <text fg={theme.text.muted}>Models</text>
                <For each={usageModels(data())}>
                  {(row) => (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text.base} wrapMode="none">
                        {row.label}
                      </text>
                      <text fg={theme.text.muted} wrapMode="none">
                        {row.detail}
                      </text>
                      <text fg={theme.text.base} wrapMode="none">
                        {row.cost}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
            <Show when={zeroCostModels(data()).length > 0}>
              <text fg={theme.text.muted} wrapMode="word">
                Subscription plans have no per-token prices, so{" "}
                {zeroCostModels(data())
                  .map((entry) => entry.model.id)
                  .join(", ")}{" "}
                record $0 — not a measurement of what was actually billed.
              </text>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}
