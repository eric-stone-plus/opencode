import { describe, expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/core/schema"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionStats } from "@opencode/core/session/stats"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)
const projectID = Project.ID.make("stats-project")
const otherProjectID = Project.ID.make("stats-other-project")
const sessionID = Session.ID.make("ses_stats_root")
const childID = Session.ID.make("ses_stats_child")
const forkID = Session.ID.make("ses_stats_fork")
const usageOnlyID = Session.ID.make("ses_stats_usage_only")
const otherSessionID = Session.ID.make("ses_stats_other")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

describe("SessionStats", () => {
  it.effect("aggregates activity and tool reliability without reading message payloads outside the range", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values([
          { id: projectID, worktree: AbsolutePath.make("/stats"), name: "stats", sandboxes: [] },
          { id: otherProjectID, worktree: AbsolutePath.make("/other"), name: "other", sandboxes: [] },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          { id: sessionID, project_id: projectID, slug: "root", directory: "/stats", version: "test" },
          {
            id: childID,
            project_id: projectID,
            parent_id: sessionID,
            slug: "child",
            directory: "/stats",
            version: "test",
          },
          {
            id: forkID,
            project_id: projectID,
            fork_session_id: sessionID,
            slug: "fork",
            directory: "/stats",
            version: "test",
            time_created: Date.UTC(2026, 0, 4),
          },
          { id: usageOnlyID, project_id: projectID, slug: "usage", directory: "/stats", version: "test" },
          { id: otherSessionID, project_id: otherProjectID, slug: "other", directory: "/other", version: "test" },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          messageRow(
            sessionID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_user"),
              type: "user",
              text: "hello",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            sessionID,
            2,
            assistant("msg_stats_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_read",
                name: "read",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "ok" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  ran: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1, 250)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_edit",
                name: "edit",
                state: SessionMessage.ToolStateError.make({
                  status: "error",
                  input: {},
                  error: { type: "tool", message: "failed" },
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 2)),
                },
              }),
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_pending",
                name: "pending",
                state: SessionMessage.ToolStateRunning.make({ status: "running", input: {}, metadata: {} }),
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)) },
              }),
            ]),
          ),
          messageRow(childID, 1, assistant("msg_stats_child", Date.UTC(2026, 0, 3, 10), [], "large", 2)),
          messageRow(
            forkID,
            1,
            SessionMessage.User.make({
              id: SessionMessage.ID.make("msg_stats_fork_copied_user"),
              type: "user",
              text: "copied",
              time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
            }),
          ),
          messageRow(
            forkID,
            2,
            assistant("msg_stats_fork_copied_assistant", Date.UTC(2026, 0, 2, 10), [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_copied",
                name: "copied",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: {},
                  content: [{ type: "text", text: "copied" }],
                }),
                time: {
                  created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10)),
                  completed: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 10, 0, 1)),
                },
              }),
            ]),
          ),
          messageRow(forkID, 3, assistant("msg_stats_fork_new", Date.UTC(2026, 0, 5, 10), [], "fork-new")),
          messageRow(sessionID, 3, assistant("msg_stats_outside", Date.UTC(2025, 11, 31, 10), [])),
          messageRow(usageOnlyID, 1, assistant("msg_stats_usage_only", Date.UTC(2025, 11, 30, 10), [])),
          messageRow(otherSessionID, 1, assistant("msg_stats_other", Date.UTC(2020, 0, 1, 10), [])),
        ])
        .run()
        .pipe(Effect.orDie)
      // Publish through the real Bus so the stored event type is whatever the
      // writer persists rather than a string the test assumes.
      const bus = yield* Bus.Service
      yield* TestClock.setTime(Date.UTC(2026, 0, 2, 10, 0, 3))
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID,
        source: "title",
        cost: Money.USD.make(0.5),
        tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 1, write: 1 } },
      })
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID: usageOnlyID,
        source: "compaction",
        cost: Money.USD.make(0.25),
        tokens: { input: 2, output: 2, reasoning: 2, cache: { read: 2, write: 2 } },
      })

      const stats = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "detail",
      })

      expect(stats.sessions).toBe(2)
      expect(stats.subagents).toBe(1)
      expect(stats.prompts).toBe(1)
      expect(stats.steps).toBe(3)
      expect(stats.tokens).toEqual({ input: 42, output: 22, reasoning: 10, cache: { read: 18, write: 6 } })
      expect(stats.cost).toBe(Money.USD.make(6.25))
      expect(stats.tools).toMatchObject({
        mode: "detail",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })
      expect(stats.activity).toEqual([
        { date: "2026-01-02", steps: 1 },
        { date: "2026-01-03", steps: 1 },
        { date: "2026-01-05", steps: 1 },
      ])
      expect(stats.streak).toBe(2)
      expect(stats.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(stats.tools.mode).toBe("detail")
      if (stats.tools.mode !== "detail") throw new Error("Expected detailed tool statistics")
      expect(stats.tools.usage).toMatchObject([
        { name: "read", calls: 1, succeeded: 1, failed: 0, durationP50: 250 },
        { name: "edit", calls: 1, succeeded: 0, failed: 1, durationP50: 2_000 },
        { name: "pending", calls: 1, succeeded: 0, failed: 0, unfinished: 1 },
      ])

      const summary = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
      })
      expect(summary.models.map((model) => String(model.model.id))).toEqual(["large", "sonnet", "fork-new"])
      expect(summary.tools).toEqual({
        mode: "summary",
        totals: { calls: 3, succeeded: 1, failed: 1, unfinished: 1 },
      })

      const withoutTools = yield* SessionStats.get({
        from: Date.UTC(2026, 0, 1),
        to: Date.UTC(2026, 1, 1),
        timezone: "UTC",
        tools: "none",
      })
      expect(withoutTools.tools).toEqual({ mode: "none" })

      const project = yield* SessionStats.get({ projectID, timezone: "UTC", tools: "none" })
      expect(DateTime.toEpochMillis(project.range.from)).toBe(Date.UTC(2025, 11, 30, 10))

      const error = yield* Effect.flip(
        SessionStats.get({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1), tools: "none" }),
      )
      expect(error).toEqual(
        new SessionStats.InvalidRangeError({ from: Date.UTC(2026, 1, 1), to: Date.UTC(2026, 0, 1) }),
      )

      const future = yield* Effect.flip(SessionStats.get({ from: Number.MAX_SAFE_INTEGER, tools: "none" }))
      expect(future._tag).toBe("SessionStats.InvalidRangeError")
    }),
  )
})

describe("SessionStats compactions and session scope", () => {
  it.effect("counts completed compactions and attributes their spend to the model that ran them", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const scopedProject = Project.ID.make("stats-compaction-project")
      const root = Session.ID.make("ses_stats_compaction_root")
      const child = Session.ID.make("ses_stats_compaction_child")
      const grandchild = Session.ID.make("ses_stats_compaction_grandchild")
      const sibling = Session.ID.make("ses_stats_compaction_sibling")
      yield* db
        .insert(ProjectTable)
        .values({ id: scopedProject, worktree: AbsolutePath.make("/compaction"), name: "compaction", sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values([
          { id: root, project_id: scopedProject, slug: "root", directory: "/compaction", version: "test" },
          {
            id: child,
            project_id: scopedProject,
            parent_id: root,
            slug: "child",
            directory: "/compaction",
            version: "test",
          },
          {
            id: grandchild,
            project_id: scopedProject,
            parent_id: child,
            slug: "grandchild",
            directory: "/compaction",
            version: "test",
          },
          { id: sibling, project_id: scopedProject, slug: "sibling", directory: "/compaction", version: "test" },
        ])
        .run()
        .pipe(Effect.orDie)
      const day = Date.UTC(2026, 2, 2, 10)
      yield* db
        .insert(SessionMessageTable)
        .values([
          messageRow(root, 1, assistant("msg_cmp_root_step", day, [], "sonnet")),
          messageRow(root, 2, compaction("msg_cmp_root_a", day + 1_000, "completed", "haiku", 0.25, 100)),
          messageRow(root, 3, compaction("msg_cmp_root_b", day + 2_000, "completed", "sonnet", 0.5, 200)),
          messageRow(root, 4, compaction("msg_cmp_root_failed", day + 3_000, "failed")),
          messageRow(root, 5, compaction("msg_cmp_root_running", day + 4_000, "running")),
          messageRow(child, 1, assistant("msg_cmp_child_step", day + 5_000, [], "sonnet")),
          messageRow(child, 2, compaction("msg_cmp_child", day + 6_000, "completed", "haiku", 0.125, 50)),
          messageRow(grandchild, 1, assistant("msg_cmp_grandchild_step", day + 7_000, [], "large", 2)),
          messageRow(sibling, 1, assistant("msg_cmp_sibling_step", day + 8_000, [], "sonnet")),
          messageRow(sibling, 2, compaction("msg_cmp_sibling", day + 9_000, "completed", "sonnet", 4, 400)),
        ])
        .run()
        .pipe(Effect.orDie)
      // Compaction spend reaches the totals through usage events, exactly once, and a failed compaction bills too.
      const bus = yield* Bus.Service
      yield* TestClock.setTime(day + 10_000)
      const spend = (sessionID: Session.ID, cost: number, scale: number) =>
        bus.publish(SessionEvent.UsageRecorded, {
          sessionID,
          source: "compaction",
          cost: Money.USD.make(cost),
          tokens: { input: scale, output: scale, reasoning: scale, cache: { read: scale, write: scale } },
        })
      yield* spend(root, 0.25, 20)
      yield* spend(root, 0.5, 40)
      yield* spend(root, 0.0625, 2)
      yield* spend(child, 0.125, 10)
      yield* spend(sibling, 4, 80)

      const range = { from: day - 1_000, to: day + 60_000, timezone: "UTC", tools: "none" } as const
      const all = yield* SessionStats.get({ ...range, projectID: scopedProject })
      expect(all.compactions).toBe(4)
      expect(all.steps).toBe(4)
      expect(all.cost).toBe(Money.USD.make(1.5 + 1.5 + 3 + 1.5 + 0.25 + 0.5 + 0.0625 + 0.125 + 4))
      const bySonnet = all.models.find((item) => item.model.id === "sonnet")
      const byHaiku = all.models.find((item) => item.model.id === "haiku")
      expect(byHaiku).toMatchObject({ steps: 0, compactions: 2, cost: Money.USD.make(0.375) })
      expect(bySonnet).toMatchObject({ steps: 3, compactions: 2 })
      expect(bySonnet?.cost).toBe(Money.USD.make(1.5 + 1.5 + 1.5 + 0.5 + 4))
      expect(bySonnet?.tokens.input).toBe(10 * 3 + 200 + 400)

      // The whole tree of the root, nothing from the sibling session.
      const tree = yield* SessionStats.get({ ...range, projectID: scopedProject, sessionID: root })
      expect(tree.sessions).toBe(1)
      expect(tree.subagents).toBe(2)
      expect(tree.steps).toBe(3)
      expect(tree.compactions).toBe(3)
      expect(tree.cost).toBe(Money.USD.make(1.5 + 1.5 + 3 + 0.25 + 0.5 + 0.0625 + 0.125))
      expect(tree.models.map((item) => String(item.model.id)).toSorted()).toEqual(["haiku", "large", "sonnet"])

      // A subagent's own report covers it and its descendants only.
      const leaf = yield* SessionStats.get({ ...range, sessionID: child })
      expect(leaf.steps).toBe(2)
      expect(leaf.compactions).toBe(1)
      expect(leaf.cost).toBe(Money.USD.make(1.5 + 3 + 0.125))

      const none = yield* SessionStats.get({ ...range, sessionID: Session.ID.make("ses_stats_missing") })
      expect(none).toMatchObject({ sessions: 0, steps: 0, compactions: 0, cost: 0 })
    }),
  )
})

function compaction(
  id: string,
  created: number,
  status: "completed" | "failed" | "running",
  model = "sonnet",
  cost = 0,
  scale = 0,
) {
  const base = {
    id: SessionMessage.ID.make(id),
    type: "compaction" as const,
    time: { created: DateTime.makeUnsafe(created) },
  }
  if (status === "running")
    return SessionMessage.CompactionRunning.make({ ...base, status, reason: "auto", summary: "", recent: "" })
  if (status === "failed")
    return SessionMessage.CompactionFailed.make({
      ...base,
      status,
      reason: "auto",
      error: { type: "compaction.failed", message: "failed" },
    })
  return SessionMessage.CompactionCompleted.make({
    ...base,
    status,
    reason: "auto",
    model: { id: Model.ID.make(model), providerID: Provider.ID.make("anthropic") },
    summary: "summary",
    recent: "",
    cost: Money.USD.make(cost),
    tokens: { input: scale, output: scale, reasoning: scale, cache: { read: scale, write: scale } },
  })
}

function assistant(
  id: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  model = "sonnet",
  scale = 1,
) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make(model), providerID: Provider.ID.make("anthropic") },
    content,
    cost: Money.USD.make(1.5 * scale),
    tokens: { input: 10 * scale, output: 5 * scale, reasoning: 2 * scale, cache: { read: 4 * scale, write: scale } },
    time: { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created + 2_000) },
  })
}

function messageRow(
  sessionID: Session.ID,
  seq: number,
  message: SessionMessage.Info,
): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), session_id: sessionID, type, seq, time_created: encoded.time.created, data }
}
