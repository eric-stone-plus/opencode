// Restart recovery: a process that died mid-run leaves assistant messages
// without time.completed and tool parts stuck in pending/running. Nothing will
// ever finish them, so the UI shows them in progress forever. The first process
// to own a directory after a restart marks them interrupted the same way
// SessionProcessor cleanup() does. Runs are never resumed automatically; a new
// user message continues from the saved history.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, inArray, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { InstanceState } from "@/effect/instance-state"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { EventV2Bridge } from "@/event-v2-bridge"
import { isRecord } from "@/util/record"
import type { MessageID, PartID, SessionID } from "./schema"

export const INTERRUPTED_MESSAGE = "Interrupted: opencode stopped while this response was in progress"
export const INTERRUPTED_TOOL = "Tool execution aborted"

// Process start. Anything created later belongs to this process and is never swept.
const START = Math.floor(performance.timeOrigin)

export type Result = { owner: boolean; messages: number; parts: number }

export interface Interface {
  /**
   * Claims the current instance directory for this process and, if claimed,
   * sweeps runs left by earlier processes. Runs once per instance; the claim is
   * released when the instance is disposed.
   */
  readonly init: () => Effect.Effect<Result>
  /** Marks runs in `directory` created before `before` as interrupted. */
  readonly sweep: (directory: string, before: number) => Effect.Effect<{ messages: number; parts: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRecovery") {}

type Owner = { pid: number; hostname: string; boot: number; token: string }

// The token distinguishes this process from a restarted process that inherits
// the same PID before the old owner file has been removed.
const OWNER_TOKEN = randomUUID()

function bootTime() {
  return Date.now() - Math.round(os.uptime() * 1000)
}

function alive(owner: Owner) {
  // Another host or a previous boot cannot be checked; a different boot means
  // the pid file outlived a reboot.
  if (owner.hostname !== os.hostname()) return true
  if (Math.abs(owner.boot - bootTime()) > 120_000) return false
  if (owner.pid === process.pid) return false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return isRecord(error) && error.code === "EPERM"
  }
}

export function ownerFile(directory: string) {
  return path.join(Global.Path.state, "session-owner", `${Hash.fast(directory)}.json`)
}

// A process may sweep a directory only while no other live process serves it,
// so concurrent `opencode` processes never interrupt each other's runs.
async function claim(directory: string) {
  const file = ownerFile(directory)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const self: Owner = { pid: process.pid, hostname: os.hostname(), boot: bootTime(), token: OWNER_TOKEN }
  for (let attempt = 0; attempt < 3; attempt++) {
    const written = await fs
      .writeFile(file, JSON.stringify({ ...self, directory }), { flag: "wx" })
      .then(() => true)
      .catch((error) => {
        if (isRecord(error) && error.code === "EEXIST") return false
        throw error
      })
    if (written) return true
    const current = await fs
      .readFile(file, "utf8")
      .then((raw) => JSON.parse(raw) as Owner)
      .catch(() => undefined)
    if (current?.pid === process.pid && current.hostname === self.hostname && current.token === self.token) return true
    if (current && alive(current)) return false
    await fs.rm(file, { force: true })
  }
  return false
}

async function unclaim(directory: string) {
  const file = ownerFile(directory)
  const current = await fs
    .readFile(file, "utf8")
    .then((raw) => JSON.parse(raw) as Owner)
    .catch(() => undefined)
  if (current?.pid === process.pid && current.hostname === os.hostname() && current.token === OWNER_TOKEN)
    await fs.rm(file, { force: true })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    const sweep = Effect.fn("SessionRecovery.sweep")(function* (directory: string, before: number) {
      const messages = yield* db
        .select({ id: MessageTable.id, session_id: MessageTable.session_id, data: MessageTable.data })
        .from(MessageTable)
        .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
        .where(
          and(
            eq(SessionTable.directory, directory),
            lt(MessageTable.time_created, before),
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_extract(${MessageTable.data}, '$.time.completed') IS NULL`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const open = new Set<string>(messages.map((row) => row.id))

      // Keyed on the open set, not on the directory: a stuck tool part only ever
      // belongs to a message that never completed (finishing a message finalizes
      // its parts), and filtering by directory instead forces a full scan of the
      // part table plus two json_extract per row — seconds of cold-cache IO on a
      // large history to find nothing.
      const tools =
        open.size === 0
          ? []
          : yield* db
              .select({
                id: PartTable.id,
                message_id: PartTable.message_id,
                session_id: PartTable.session_id,
                data: PartTable.data,
              })
              .from(PartTable)
              .where(
                and(
                  inArray(PartTable.message_id, [...open] as MessageID[]),
                  lt(PartTable.time_created, before),
                  sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
                  sql`json_extract(${PartTable.data}, '$.state.status') IN ('pending', 'running')`,
                ),
              )
              .all()
              .pipe(Effect.orDie)
      const fragments =
        open.size === 0
          ? []
          : yield* db
              .select({
                id: PartTable.id,
                message_id: PartTable.message_id,
                session_id: PartTable.session_id,
                data: PartTable.data,
              })
              .from(PartTable)
              .where(
                and(
                  inArray(PartTable.message_id, [...open] as MessageID[]),
                  sql`json_extract(${PartTable.data}, '$.type') IN ('text', 'reasoning')`,
                ),
              )
              .all()
              .pipe(Effect.orDie)

      const now = Date.now()
      let parts = 0
      for (const row of tools) {
        const part = {
          ...row.data,
          id: row.id,
          messageID: row.message_id,
          sessionID: row.session_id,
        } as SessionV1.ToolPart
        if (part.state.status !== "pending" && part.state.status !== "running") continue
        const metadata = part.state.status === "running" && isRecord(part.state.metadata) ? part.state.metadata : {}
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: {
            ...part,
            state: {
              status: "error",
              input: part.state.input,
              error: INTERRUPTED_TOOL,
              metadata: { ...metadata, interrupted: true },
              time: { start: part.state.status === "running" ? part.state.time.start : now, end: now },
            },
          },
          time: now,
        })
        parts++
      }

      for (const row of fragments) {
        const part = { ...row.data, id: row.id, messageID: row.message_id, sessionID: row.session_id } as
          | SessionV1.TextPart
          | SessionV1.ReasoningPart
        // Streamed deltas are not persisted, so a part cut off by the crash is
        // usually empty. Empty parts only produce invalid empty content blocks
        // when the history is replayed.
        const signed = part.type === "reasoning" && isRecord(part.metadata) && Object.keys(part.metadata).length > 0
        if (part.text.trim() === "" && !signed) {
          yield* events.publish(SessionV1.Event.PartRemoved, {
            sessionID: part.sessionID as SessionID,
            messageID: part.messageID as MessageID,
            partID: part.id as PartID,
          })
          parts++
          continue
        }
        if (part.time?.end !== undefined) continue
        yield* events.publish(SessionV1.Event.PartUpdated, {
          sessionID: part.sessionID,
          part: { ...part, time: { start: part.time?.start ?? now, end: now } },
          time: now,
        })
        parts++
      }

      for (const row of messages) {
        const info = { ...row.data, id: row.id, sessionID: row.session_id } as SessionV1.Assistant
        yield* events.publish(SessionV1.Event.MessageUpdated, {
          sessionID: info.sessionID,
          info: {
            ...info,
            error: info.error ?? new SessionV1.AbortedError({ message: INTERRUPTED_MESSAGE }).toObject(),
            time: { ...info.time, completed: now },
          },
        })
      }

      if (messages.length > 0 || parts > 0)
        yield* Effect.logWarning("marked runs interrupted by a previous process as aborted", {
          directory,
          messages: messages.length,
          parts,
        })
      return { messages: messages.length, parts }
    })

    const state = yield* InstanceState.make<Result>(
      Effect.fn("SessionRecovery.state")(function* (ctx) {
        const owner = yield* Effect.promise(() => claim(ctx.directory).catch(() => false))
        if (!owner) return { owner, messages: 0, parts: 0 }
        yield* Effect.addFinalizer(() => Effect.promise(() => unclaim(ctx.directory).catch(() => undefined)))
        return { owner, ...(yield* sweep(ctx.directory, START)) }
      }),
    )

    return Service.of({ init: () => InstanceState.get(state), sweep })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, EventV2Bridge.node] })

export * as SessionRecovery from "./recovery"
