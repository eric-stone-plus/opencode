import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Location } from "@opencode-ai/core/location"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  it.effect("projects moved sessions without the transitional context epoch table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      yield* db.run(sql`DROP TABLE session_context_epoch`)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/project/subdir") }),
      })

      expect(yield* db.select({ directory: SessionTable.directory }).from(SessionTable).get()).toEqual({
        directory: "/project/subdir",
      })
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )

  const setupUsageSession = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return db
  })

  const readUsage = Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select({
        cost: SessionTable.cost,
        input: SessionTable.tokens_input,
        output: SessionTable.tokens_output,
        reasoning: SessionTable.tokens_reasoning,
        cacheRead: SessionTable.tokens_cache_read,
        cacheWrite: SessionTable.tokens_cache_write,
        compactions: SessionTable.compactions,
      })
      .from(SessionTable)
      .get()
      .pipe(Effect.orDie)
    return row!
  })

  const stepFinishPart = (partID: string, messageID: string, cost: number, input = 100) =>
    SessionV1.StepFinishPart.make({
      id: SessionV1.PartID.make(partID),
      sessionID,
      messageID: SessionV1.MessageID.make(messageID),
      type: "step-finish",
      reason: "stop",
      cost,
      tokens: { input, output: 10, reasoning: 0, cache: { read: 5, write: 2 } },
    })

  // SessionV1.User carries { providerID, modelID }, unlike the assistant shape.
  const userModel = { providerID: ProviderV2.ID.make("provider"), modelID: ModelV2.ID.make("model") }

  const compactionPart = (partID: string, messageID: string) =>
    SessionV1.CompactionPart.make({
      id: SessionV1.PartID.make(partID),
      sessionID,
      messageID: SessionV1.MessageID.make(messageID),
      type: "compaction",
      auto: true,
    })

  // Part rows foreign-key message rows, so every billed part needs its message
  // projected first (MessageUpdated), as the live processor does.
  const publishAssistantMessage = (messageID: string) =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: SessionV1.Assistant.make({
          id: SessionV1.MessageID.make(messageID),
          sessionID,
          role: "assistant",
          time: { created: 1 },
          parentID: SessionV1.MessageID.make("msg_parent_root"),
          modelID: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          mode: "build",
          agent: "build",
          path: { cwd: "/project", root: "/project" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      })
    })

  it.effect("session totals survive MessageRemoved of a billed message", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      const messageID = SessionV1.MessageID.make("msg_billed")
      yield* publishAssistantMessage("msg_billed")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_billed", "msg_billed", 0.5),
        time: 1,
      })
      expect(yield* readUsage).toMatchObject({ cost: 0.5, input: 100 })

      yield* events.publish(SessionV1.Event.MessageRemoved, { sessionID, messageID })

      expect(yield* readUsage).toMatchObject({ cost: 0.5, input: 100, output: 10 })
    }),
  )

  it.effect("session totals survive PartRemoved of a step-finish part", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      yield* publishAssistantMessage("msg_parent")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_removed", "msg_parent", 0.25),
        time: 1,
      })
      expect(yield* readUsage).toMatchObject({ cost: 0.25, input: 100 })

      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID,
        messageID: SessionV1.MessageID.make("msg_parent"),
        partID: SessionV1.PartID.make("prt_removed"),
      })

      expect(yield* readUsage).toMatchObject({ cost: 0.25, input: 100 })
    }),
  )

  it.effect("PartUpdated rewrite of a step-finish adjusts by delta", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      yield* publishAssistantMessage("msg_rewrite")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_rewrite", "msg_rewrite", 0.3),
        time: 1,
      })
      expect(yield* readUsage).toMatchObject({ cost: 0.3 })

      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_rewrite", "msg_rewrite", 0.5),
        time: 2,
      })
      expect(yield* readUsage).toMatchObject({ cost: 0.5 })

      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_rewrite", "msg_rewrite", 0.2),
        time: 3,
      })
      expect(yield* readUsage).toMatchObject({ cost: 0.2 })
    }),
  )

  it.effect("session totals stay complete across two compaction removal cycles", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      const snapshot: number[] = []
      const record = Effect.gen(function* () {
        snapshot.push((yield* readUsage).cost)
      })

      // Compaction cycle 1: a billed summary message is written, then a failed
      // summary is removed on retry (compaction.ts removeMessage paths).
      yield* publishAssistantMessage("msg_summary_1")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_cycle1", "msg_summary_1", 1, 10),
        time: 1,
      })
      yield* record
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID,
        messageID: SessionV1.MessageID.make("msg_summary_1"),
      })
      yield* record

      // Compaction cycle 2: same story for a second summary.
      yield* publishAssistantMessage("msg_summary_2")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_cycle2", "msg_summary_2", 2, 20),
        time: 2,
      })
      yield* record
      yield* events.publish(SessionV1.Event.MessageRemoved, {
        sessionID,
        messageID: SessionV1.MessageID.make("msg_summary_2"),
      })
      yield* record

      // Post-compaction spend keeps accruing.
      yield* publishAssistantMessage("msg_after")
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: stepFinishPart("prt_after", "msg_after", 3, 30),
        time: 3,
      })
      yield* record

      expect(yield* readUsage).toMatchObject({ cost: 6, input: 60, output: 30 })
      // S1: totals are monotonic across every removal.
      for (let i = 1; i < snapshot.length; i++) expect(snapshot[i]).toBeGreaterThanOrEqual(snapshot[i - 1])
    }),
  )

  it.effect("compaction boundaries are counted once and never subtracted", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      // A user message carries the compaction marker, as the live loop writes it.
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: SessionV1.User.make({
          id: SessionV1.MessageID.make("msg_compact_1"),
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: userModel,
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: compactionPart("prt_compact_1", "msg_compact_1"),
        time: 1,
      })
      expect(yield* readUsage).toMatchObject({ compactions: 1 })

      // The tail_start_id refinement rewrites the same marker; it must not re-count.
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: SessionV1.CompactionPart.make({
          ...compactionPart("prt_compact_1", "msg_compact_1"),
          tail_start_id: SessionV1.MessageID.make("msg_tail"),
        }),
        time: 2,
      })
      expect(yield* readUsage).toMatchObject({ compactions: 1 })

      // A second compaction gets its own marker and its own count.
      yield* events.publish(SessionV1.Event.MessageUpdated, {
        sessionID,
        info: SessionV1.User.make({
          id: SessionV1.MessageID.make("msg_compact_2"),
          sessionID,
          role: "user",
          time: { created: 3 },
          agent: "build",
          model: userModel,
        }),
      })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: compactionPart("prt_compact_2", "msg_compact_2"),
        time: 3,
      })
      expect(yield* readUsage).toMatchObject({ compactions: 2 })

      // Marker removal is not a billing correction — the compaction still ran.
      yield* events.publish(SessionV1.Event.PartRemoved, {
        sessionID,
        messageID: SessionV1.MessageID.make("msg_compact_2"),
        partID: SessionV1.PartID.make("prt_compact_2"),
      })
      expect(yield* readUsage).toMatchObject({ compactions: 2 })
    }),
  )

  it.effect("a v2 compaction-ended event counts when no boundary part exists", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
        text: "summary",
        recent: "recent context",
      })
      expect(yield* readUsage).toMatchObject({ compactions: 1 })
    }),
  )

  it.effect("the counted total reaches the session service payload, not just the row", () =>
    Effect.gen(function* () {
      yield* setupUsageSession
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
        text: "summary",
        recent: "recent context",
      })
      const sessions = yield* SessionV2.Service
      // Exercises fromRow: the number the /usage dialog reads from session.get.
      expect((yield* sessions.get(sessionID)).compactions).toBe(1)
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
