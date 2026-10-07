import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"
import { Permission } from "@/permission"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { NamedError } from "@opencode-ai/core/util/error"

import { Effect, Layer, Context, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { buildPrompt } from "@opencode-ai/core/session/compaction"
import { SessionCompactionEvent } from "@opencode-ai/schema/session-compaction-event"

export const Event = SessionCompactionEvent

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
export const PRUNED_OUTPUT = "[Old tool result content cleared]"
// Metadata entries larger than this (serialized) are dropped when a part is pruned, so the
// stored row actually shrinks. Small entries the UI relies on (truncated/outputPath, exit
// codes, titles, counts) survive.
const PRUNE_METADATA_ENTRY_LIMIT = 4_000
// Never shown to the model, but rendered by the UI for old edits; keep regardless of size.
const PRUNE_METADATA_KEEP = new Set(["diff", "filediff", "files"])

export function pruneCompletedState(
  state: SessionV1.ToolStateCompleted,
  time = Date.now(),
): SessionV1.ToolStateCompleted {
  const metadata = Object.fromEntries(
    Object.entries(state.metadata ?? {}).filter(([key, value]) => {
      if (value === undefined) return false
      if (PRUNE_METADATA_KEEP.has(key)) return true
      if (typeof value === "string") return value.length <= PRUNE_METADATA_ENTRY_LIMIT
      return (JSON.stringify(value)?.length ?? 0) <= PRUNE_METADATA_ENTRY_LIMIT
    }),
  )
  // Attachments are already withheld from the model once compacted; drop their payload too.
  const { attachments: _, ...rest } = state
  return {
    ...rest,
    output: PRUNED_OUTPUT,
    metadata,
    time: { ...state.time, compacted: time },
  }
}
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 15_000
// Extra summary attempts after the processor's own retries gave up on a transient error.
export const COMPACTION_RETRY_DELAYS = [30_000, 120_000]
export const CONTINUE_INTERACTIVE =
  "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
export const CONTINUE_AUTONOMOUS =
  "Continue with the next steps of the task. Do not stop to ask the user; the session goal and task in context still apply."
type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

const serialize = (message: SessionV1.WithParts) => {
  if (message.info.role === "user") {
    const text = message.parts
      .filter((part): part is SessionV1.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n")
    const files = message.parts.flatMap((part) =>
      part.type === "file" ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`] : [],
    )
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n")
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[Assistant]: ${part.text}`] : []
      if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
      if (part.type !== "tool") return []
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        )
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate([part.state.output, ...attachments].join("\n"))
        return [call, `[Tool result]: ${output}`]
      }
      if (part.state.status === "error") return [call, `[Tool error]: ${part.state.error}`]
      return [call]
    })
    .join("\n")
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    // A summary cut at the output token limit is not a finished summary, and a
    // summary with no text is not a summary at all: accepting either would
    // mark the boundary complete and silently drop the history it replaced.
    if (!msg.info.summary || !msg.info.finish || msg.info.finish === "length" || msg.info.error) return []
    const summary = summaryText(msg)
    if (!summary) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary }]
  })
}

// Latest compaction marker no summary has completed yet.
function pendingCompaction(messages: SessionV1.WithParts[]) {
  const done = new Set(completedCompactions(messages).map((item) => messages[item.userIndex]!.info.id))
  return messages.findLast(
    (msg) => msg.info.role === "user" && msg.parts.some((part) => part.type === "compaction") && !done.has(msg.info.id),
  )
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    // Size each message once and grow the suffix from the end: a goal run is one
    // user turn with hundreds of steps, so re-estimating every suffix is quadratic.
    let total = 0
    let keep: Tail | undefined
    for (let start = input.turn.end - 1; start > input.turn.start; start--) {
      total += yield* input.estimate({ messages: [input.messages[start]!], model: input.model })
      if (total > input.budget) break
      keep = { start, id: input.messages[start]!.info.id }
    }
    return keep
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const status = yield* SessionStatus.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns
      if (limit !== undefined && limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = limit === undefined ? all : all.slice(-limit)

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        // estimate lazily so cost stays proportional to the retained tail, not the whole session
        const size = yield* estimate({
          messages: input.messages.slice(turn.start, turn.end),
          model: input.model,
        })
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (cfg.compaction?.prune === false) return
      yield* Effect.logInfo("pruning")

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        const now = Date.now()
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            // Replace the payload, not just flag it: the part row (and its durable event) shrink.
            yield* session.updatePart({ ...part, state: pruneCompletedState(part.state, now) })
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    // Same gate that hides the question tool (session/llm/request.ts resolveTools):
    // agent rules merged with the session's. auto/goal deny question, and so does
    // `opencode run`; those runs must not be told they may stop and ask.
    const autonomous = Effect.fn("SessionCompaction.autonomous")(function* (name: string, sessionID: SessionID) {
      const agent = yield* agents.get(name).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!agent) return false
      const info = yield* session.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      return Permission.disabled(["question"], Permission.merge(agent.permission, info?.permission ?? [])).has(
        "question",
      )
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      const latest = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!latest || latest.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      // The loop passes the newest user message. When a compaction failed and the user
      // has since sent another message, the pending marker is earlier: anchor the summary
      // there, or filterCompacted never finds the boundary and the full history keeps
      // being sent (and a non-auto compaction would end the turn unanswered).
      const pending = latest.parts.some((part) => part.type === "compaction")
        ? undefined
        : pendingCompaction(input.messages)
      const parent = pending ?? latest
      const parentID = parent.info.id
      const userMessage = parent.info as SessionV1.User
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")
      // The newer real message drives the next turn, so neither replay an older
      // prompt nor add a synthetic continue after it.
      const followup = pending !== undefined
      if (followup) {
        for (const msg of input.messages) {
          if (msg.info.role === "assistant" && msg.info.summary && msg.info.parentID === parentID && msg.info.error)
            yield* session.removeMessage({ sessionID: input.sessionID, messageID: msg.info.id })
        }
      }

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow && !followup) {
        const idx = input.messages.findIndex((m) => m.info.id === parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const marker = compactionPart ? messages.findIndex((m) => m.info.id === parentID) : -1
      const history = marker === -1 ? messages : messages.slice(0, marker)
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const conversation = msgs.map(serialize).filter(Boolean).join("\n\n")
      const nextPrompt =
        compacting.prompt ??
        [
          buildPrompt({
            previousSummary,
            context: [conversation],
          }),
          ...compacting.context,
        ]
          .filter(Boolean)
          .join("\n\n")
      const ctx = yield* InstanceState.context
      const request = [
        nextPrompt,
        ...(compacting.prompt ? ["The following is the conversation history:", conversation] : []),
      ]
        .filter(Boolean)
        .join("\n\n")
      const attempt = Effect.fn("SessionCompaction.attempt")(function* () {
        const msg: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID,
          sessionID: input.sessionID,
          mode: "compaction",
          agent: "compaction",
          variant: userMessage.model.variant,
          summary: true,
          path: {
            cwd: ctx.directory,
            root: ctx.worktree,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
        }
        yield* session.updateMessage(msg)
        const processor = yield* processors.create({
          assistantMessage: msg,
          sessionID: input.sessionID,
          model,
        })
        const result = yield* processor.process({
          user: userMessage,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [{ role: "user", content: [{ type: "text", text: request }] }],
          model,
        })
        return { processor, result }
      })

      let { processor, result } = yield* attempt()
      // A summary that failed on a transient error (5xx, timeout) after the processor's
      // own retries would otherwise stop the loop; long unattended runs then stall.
      // Overflow returns "compact" and aborts are not retryable, so neither loops here.
      for (const [index, wait] of COMPACTION_RETRY_DELAYS.entries()) {
        const error = processor.message.error
        const retry = result === "stop" && error ? SessionRetry.retryable(error, model.providerID) : undefined
        if (!retry) break
        yield* Effect.logWarning("retrying failed compaction", { "session.id": input.sessionID, wait })
        // drop the failed summary so exactly one summary answers this compaction
        yield* session.removeMessage({ sessionID: input.sessionID, messageID: processor.message.id })
        yield* status.set(input.sessionID, {
          type: "retry",
          attempt: index + 1,
          message: `Compaction failed, retrying: ${retry.message}`,
          next: Date.now() + wait,
        })
        yield* Effect.sleep(wait)
        ;({ processor, result } = yield* attempt())
      }

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      // A summary cut at the output token limit, or one that produced no text
      // at all, is not a usable summary. Accepting it would mark the boundary
      // complete and silently drop the history it replaced; retrying hits the
      // same cap, so surface the failure instead and let the run stop.
      const summaryMsg = yield* session
        .findMessage(input.sessionID, (m) => m.info.id === processor.message.id)
        .pipe(Effect.orDie)
      const summary = Option.getOrUndefined(summaryMsg)
      const truncated = processor.message.finish === "length"
      // An all-reasoning summary (parts but no text) is equally unusable. A
      // message with no parts at all cannot happen through the real processor
      // and is left to the completion predicates, which reject it too.
      const empty = summary !== undefined && summary.parts.length > 0 && !summaryText(summary)
      if (!processor.message.error && (truncated || empty)) {
        processor.message.error = new NamedError.Unknown({
          message: truncated
            ? "Compaction summary was cut off at the output token limit. The session was not compacted; send a message to retry."
            : "Compaction produced no summary text. The session was not compacted; send a message to retry.",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        result = "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto && !followup) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              ((yield* autonomous(userMessage.agent, input.sessionID)) ? CONTINUE_AUTONOMOUS : CONTINUE_INTERACTIVE)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      if (processor.message.error) return "stop"
      if (result === "continue") {
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    Session.node,
    Agent.node,
    Plugin.node,
    SessionProcessor.node,
    Provider.node,
    EventV2Bridge.node,
    RuntimeFlags.node,
    SessionStatus.node,
  ],
})

export * as SessionCompaction from "./compaction"
