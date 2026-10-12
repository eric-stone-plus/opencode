#!/usr/bin/env bun
/**
 * Refreshes the bundled models.dev catalog snapshot at src/models-dev/snapshot.txt.
 * The snapshot is the boot-time floor for the catalog when no cache entry exists
 * and fetching is disabled or unavailable; an opted-in live fetch refreshes on top.
 * Only the vendors this fork supports are embedded (ADR 0005), sorted by provider id
 * so refreshing unchanged registry data rewrites identical bytes.
 */
import { ModelsDev } from "@opencode/schema/models-dev"
import { Schema } from "effect"

const source = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai"
const response = await fetch(`${source}/api.json`)
if (!response.ok) {
  console.error(`Failed to fetch ${source}/api.json: ${response.status} ${response.statusText}`)
  process.exit(1)
}
const registry = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
  JSON.parse(await response.text()),
)
// A floor, not equality: guards against committing an error page or a
// truncated body that still parses as a small object.
const MINIMUM_PROVIDERS = 100
if (Object.keys(registry).length < MINIMUM_PROVIDERS) {
  console.error(`Fetched catalog has fewer than ${MINIMUM_PROVIDERS} providers; refusing to write snapshot`)
  process.exit(1)
}
const restricted = ModelsDev.restrict(registry)
const providerIDs = Object.keys(restricted).toSorted()
if (providerIDs.length === 0) {
  console.error("Fetched catalog has no supported vendor; refusing to write snapshot")
  process.exit(1)
}
const text = JSON.stringify(Object.fromEntries(providerIDs.map((id) => [id, restricted[id]])))
const target = new URL("../src/models-dev/snapshot.txt", import.meta.url)
const bytes = await Bun.write(target, text)
console.log(
  `Wrote ${providerIDs.length} of ${Object.keys(registry).length} providers (${bytes} bytes) to ${Bun.fileURLToPath(target)}`,
)
