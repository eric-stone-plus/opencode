// @ts-nocheck
import { createSignal } from "solid-js"
import * as mod from "./hover-card"

const docs = `### Overview
Hover-triggered card for lightweight previews and metadata.

Use for short summaries; avoid dense interactive controls.

### API
- Required: \`trigger\` element.
- Children render inside the hover card body.

### Variants and states
- None; content and trigger are fully composable.

### Behavior
- Opens on hover/focus over the trigger.

### Accessibility
- Opens on hover or focus after a 700 ms delay and closes 300 ms after the pointer leaves, unless it moves into the trigger, the content, or the safe area between them. Focus leaving the trigger closes it after the same delay unless the new target is inside the content; focus leaving the content does not close it. The wrapper renders the trigger as a non-focusable div (\`tabIndex={-1}\`), so the focus path needs a focusable element inside the trigger.

### Theming/tokens
- Uses \`data-component="hover-card-content"\` and slots for styling.

`

export default {
  title: "UI/HoverCard",
  id: "components-hover-card",
  component: mod.HoverCard,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => (
    <mod.HoverCard trigger={<span style={{ "text-decoration": "underline", cursor: "default" }}>Hover me</span>}>
      <div style={{ display: "grid", gap: "6px" }}>
        <div style={{ "font-weight": 600 }}>Preview</div>
        <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Short supporting text.</div>
      </div>
    </mod.HoverCard>
  ),
}

export const InlineMount = {
  render: () => {
    const [mount, setMount] = createSignal<HTMLDivElement | undefined>(undefined)

    return (
      <div ref={setMount} style={{ padding: "16px", border: "1px dashed var(--border-weak)" }}>
        <mod.HoverCard
          mount={mount()}
          trigger={<span style={{ "text-decoration": "underline", cursor: "default" }}>Hover me</span>}
        >
          <div style={{ display: "grid", gap: "6px" }}>
            <div style={{ "font-weight": 600 }}>Mounted inside</div>
            <div style={{ color: "var(--text-weak)", "font-size": "12px" }}>Uses custom mount node.</div>
          </div>
        </mod.HoverCard>
      </div>
    )
  },
}
