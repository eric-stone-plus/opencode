import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011113913_session_compactions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`compactions\` integer DEFAULT 0 NOT NULL;`)
      // Backfill every session's lifetime compaction count from the compaction
      // boundary markers already stored as parts (one user-message part per
      // auto or manual compaction). Without this, long-lived sessions would
      // report 0 until their next compaction.
      yield* tx.run(`
        UPDATE session
        SET compactions = coalesce((
          SELECT count(*)
          FROM part
          WHERE part.session_id = session.id
            AND json_extract(part.data, '$.type') = 'compaction'
        ), 0)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
