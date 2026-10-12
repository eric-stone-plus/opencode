import { describe, expect } from "bun:test"
import { Message, ToolCallPart, ToolResultPart, type ContentPart } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { Model } from "@opencode/schema/model"
import { Config } from "@opencode/core/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"
import { ForkRuntimePlugin } from "@opencode/core/plugin/fork/runtime"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { ForkPrune } from "@opencode/core/session/fork/prune"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Config.testLayer())

/** A tool output of exactly `tokens` estimated tokens: Token.estimate is characters / 4 for ASCII. */
const output = (tokens: number, label: string) => label.padEnd(tokens * 4, "x")

const exchange = (id: string, tool: string, result: ToolResultPart["result"], extra: Partial<ToolResultPart> = {}) => [
  Message.assistant([ToolCallPart.make({ id, name: tool, input: { id } })]),
  Message.tool({ id, name: tool, result, ...extra }),
]

const read = (id: string, tokens: number) => exchange(id, "read", { type: "text", value: output(tokens, id) })

const results = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "tool-result" ? [{ id: part.id, result: part.result }] : [])),
  )

const cleared = (messages: ReadonlyArray<Message>) =>
  results(messages)
    .filter((entry) => entry.result.type === "text" && entry.result.value === ForkPrune.MARKER)
    .map((entry) => entry.id)

describe("ForkPrune.elide", () => {
  it.effect("leaves a conversation within the protected tail untouched", () =>
    Effect.gen(function* () {
      const messages = [Message.user("go"), ...read("a", 15_000), ...read("b", 15_000)]
      expect(ForkPrune.elide(messages)).toBe(messages)
    }),
  )

  it.effect("does not touch anything until a whole step of output has aged out of the tail", () =>
    Effect.gen(function* () {
      // 40k protected plus 19k older: less than one 20k step, so nothing moves and the prefix stays cacheable.
      const messages = [Message.user("go"), ...read("old", 19_000), ...read("recent", 40_000)]
      expect(ForkPrune.elide(messages)).toBe(messages)
    }),
  )

  it.effect("clears the oldest outputs in whole steps and keeps the newest 40k tokens verbatim", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("go"),
        ...read("a", 10_000),
        ...read("b", 10_000),
        ...read("c", 10_000),
        ...read("d", 30_000),
        ...read("e", 25_000),
      ]
      // 85k in total: the cut is floor((85k - 40k) / 20k) * 20k = 40k. a, b and c end at 10k, 20k and 30k; d would end at 60k.
      const elided = ForkPrune.elide(messages)
      expect(cleared(elided)).toEqual(["a", "b", "c"])
      expect(results(elided).at(-2)?.result).toEqual({ type: "text", value: output(30_000, "d") })
      expect(results(elided).at(-1)?.result).toEqual({ type: "text", value: output(25_000, "e") })
    }),
  )

  it.effect("yields the same view for the same history and a longer prefix once the history grows", () =>
    Effect.gen(function* () {
      const history = [Message.user("go"), ...read("a", 30_000), ...read("b", 30_000), ...read("c", 30_000)]
      expect(cleared(ForkPrune.elide(history))).toEqual(["a"])
      expect(cleared(ForkPrune.elide(history))).toEqual(["a"])
      const grown = [...history, ...read("d", 5_000)]
      // 95k: cut 40k, still only a. Adding another 20k of output moves the cut by one step.
      expect(cleared(ForkPrune.elide(grown))).toEqual(["a"])
      expect(cleared(ForkPrune.elide([...grown, ...read("e", 20_000)]))).toEqual(["a", "b"])
    }),
  )

  it.effect("keeps errors, skill output, hosted results and messages without tool output", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("go"),
        ...exchange("err", "read", { type: "error", value: output(30_000, "err") }),
        ...exchange("skill", "skill", { type: "text", value: output(30_000, "skill") }),
        ...exchange("hosted", "web_search", { type: "text", value: output(30_000, "hosted") }, { providerExecuted: true }),
        ...read("a", 30_000),
        ...read("b", 50_000),
      ]
      const elided = ForkPrune.elide(messages)
      expect(cleared(elided)).toEqual(["a"])
      expect(elided[0]).toBe(messages[0])
      const preserved = ["err", "skill", "hosted", "b"].map((id) => results(elided).find((entry) => entry.id === id))
      expect(preserved).toEqual(["err", "skill", "hosted", "b"].map((id) => results(messages).find((entry) => entry.id === id)))
    }),
  )

  it.effect("clears structured and multi-part results but never a result already cleared", () =>
    Effect.gen(function* () {
      const content: ContentPart[] = [
        { type: "text", text: "assistant words that are not tool output" },
        ToolCallPart.make({ id: "j", name: "grep", input: {} }),
      ]
      const messages = [
        Message.user("go"),
        Message.assistant(content),
        Message.tool({ id: "j", name: "grep", result: { type: "json", value: { rows: "x".repeat(200_000) } } }),
        ...exchange("c", "read", {
          type: "content",
          value: [
            { type: "text", text: output(30_000, "c") },
            { type: "file", uri: "file:///a.png", mime: "image/png" },
          ],
        }),
        ...read("tail", 60_000),
      ]
      const once = ForkPrune.elide(messages)
      expect(cleared(once)).toEqual(["j", "c"])
      expect(once[1]).toBe(messages[1])
      // The marker itself is tiny, so a second pass over the elided view changes nothing.
      expect(ForkPrune.elide(once)).toEqual(once)
    }),
  )

  it.effect("never changes the stored messages", () =>
    Effect.gen(function* () {
      const messages = [Message.user("go"), ...read("a", 30_000), ...read("b", 55_000)]
      const snapshot = structuredClone(messages)
      ForkPrune.elide(messages)
      expect(messages).toEqual(snapshot)
    }),
  )
})

const sessionID = Session.ID.make("ses_prune")

/** Runs the real fork runtime plugin against a config entry list and applies its context hooks to a request. */
const pruned = (entries: Config.Interface["entries"] extends () => Effect.Effect<infer E> ? E : never) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    yield* config.setEntries(entries)
    const hooks: Array<(event: SessionContext) => Effect.Effect<void>> = []
    yield* ForkRuntimePlugin.Plugin.effect(
      host({
        session: {
          hook: (name, callback) => {
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            if (name === "context") hooks.push(callback as unknown as (event: SessionContext) => Effect.Effect<void>)
            return Effect.succeed({ dispose: Effect.void })
          },
        },
        tool: {
          transform: () => Effect.die("unused"),
          reload: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          hook: () => Effect.succeed({ dispose: Effect.void }),
        },
      }),
    )
    const request: SessionContext = {
      sessionID,
      agent: Agent.ID.make("auto"),
      model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") },
      system: [],
      messages: [Message.user("go"), ...read("a", 30_000), ...read("b", 55_000)],
      tools: {},
      options: {},
    }
    yield* Effect.forEach(hooks, (hook) => hook(request))
    return cleared(request.messages)
  })

const document = (compaction?: ConfigCompaction.Info) =>
  new Document({ type: "document", info: new Info(compaction ? { compaction } : {}) })

describe("compaction.prune", () => {
  it.effect("prunes by default", () => pruned([]).pipe(Effect.map((ids) => expect(ids).toEqual(["a"]))))

  it.effect("prunes when the config enables it explicitly", () =>
    pruned([document(new ConfigCompaction.Info({ prune: true }))]).pipe(
      Effect.map((ids) => expect(ids).toEqual(["a"])),
    ),
  )

  it.effect("turns pruning off with prune: false", () =>
    pruned([document(new ConfigCompaction.Info({ prune: false }))]).pipe(
      Effect.map((ids) => expect(ids).toEqual([])),
    ),
  )

  it.effect("lets the highest-priority entry that sets prune decide", () =>
    Effect.gen(function* () {
      const off = document(new ConfigCompaction.Info({ prune: false }))
      const on = document(new ConfigCompaction.Info({ prune: true }))
      const other = document(new ConfigCompaction.Info({ auto: false }))
      expect(yield* pruned([off, on, other])).toEqual(["a"])
      expect(yield* pruned([on, off, other])).toEqual([])
    }),
  )

  it.effect("is read from opencode.jsonc compaction.prune instead of being reported unsupported", () =>
    Effect.sync(() => {
      const result = ConfigNormalize.normalize({ compaction: { auto: true, prune: false, preserve_recent_tokens: 40000 } })
      expect(result.diagnostics).toEqual([])
      expect(result.type === "rejected" ? undefined : result.encoded.compaction).toEqual({
        auto: true,
        prune: false,
        keep: { tokens: 40000 },
      })
      const malformed = ConfigNormalize.normalize({ compaction: { prune: "yes" } })
      expect(malformed.diagnostics.map((item) => [item.kind, item.path])).toEqual([["invalid", ["compaction", "prune"]]])
    }),
  )
})
