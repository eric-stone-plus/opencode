import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// V1 left a `todo` table whose foreign key points at the retired `session` table, so
// any new session's todo insert fails with FOREIGN KEY constraint failed. Rebuild the
// table onto session_v2, carrying the stored rows over; databases that never had the
// table get it fresh. Rows whose session no longer exists are dropped rather than
// carried into a table that would reject them.
const migration: DatabaseMigration.Migration = {
  id: "20261013081054_todo_session_state",
  up(tx) {
    return Effect.gen(function* () {
      const legacy = yield* tx.get<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo'`,
      )
      if (!legacy) {
        yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
        return
      }
      yield* tx.run(`ALTER TABLE \`todo\` RENAME TO \`__legacy_todo\`;`)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`todo\` (\`session_id\`, \`content\`, \`status\`, \`priority\`, \`position\`, \`time_created\`, \`time_updated\`)
        SELECT \`session_id\`, \`content\`, \`status\`, \`priority\`, \`position\`, \`time_created\`, \`time_updated\`
        FROM \`__legacy_todo\`
        WHERE EXISTS (SELECT 1 FROM \`session_v2\` WHERE \`session_v2\`.\`id\` = \`__legacy_todo\`.\`session_id\`);
      `)
      yield* tx.run(`DROP TABLE \`__legacy_todo\`;`)
    })
  },
}

export default migration
