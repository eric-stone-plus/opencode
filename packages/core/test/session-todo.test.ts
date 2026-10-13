import { describe, expect } from "bun:test"
import { Deferred, Effect } from "effect"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionTodo } from "@opencode/core/session/todo"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const nodes = AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionTodo.node]))
const it = testEffect(nodes)

const sessionID = Session.ID.make("ses_todo")

const createSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todo-test",
      directory: "/project",
      title: "todo test",
      version: "test",
      agent: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  it.effect("replaces the stored list and publishes todo.updated", () =>
    Effect.gen(function* () {
      yield* createSession
      const todo = yield* SessionTodo.Service
      const bus = yield* Bus.Service
      const seen = yield* Deferred.make<ReadonlyArray<SessionTodo.Info>>()
      const unsubscribe = yield* bus.listen((event) =>
        event.type === SessionTodo.Event.Updated.type
          ? Deferred.succeed(seen, (event.data as { readonly todos: ReadonlyArray<SessionTodo.Info> }).todos).pipe(
              Effect.asVoid,
            )
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todo.update({
        sessionID,
        todos: [
          { content: "first", status: "in_progress", priority: "high" },
          { content: "second", status: "pending", priority: "low" },
        ],
      })
      expect(yield* Deferred.await(seen)).toEqual([
        { content: "first", status: "in_progress", priority: "high" },
        { content: "second", status: "pending", priority: "low" },
      ])
      expect(yield* todo.get(sessionID)).toEqual([
        { content: "first", status: "in_progress", priority: "high" },
        { content: "second", status: "pending", priority: "low" },
      ])

      // A second write replaces the whole list, positions renumbering from zero.
      yield* todo.update({ sessionID, todos: [{ content: "only", status: "pending", priority: "medium" }] })
      expect(yield* todo.get(sessionID)).toEqual([{ content: "only", status: "pending", priority: "medium" }])

      yield* todo.update({ sessionID, todos: [] })
      expect(yield* todo.get(sessionID)).toEqual([])
    }),
  )
})
