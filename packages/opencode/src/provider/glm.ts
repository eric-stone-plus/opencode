// Capability predicates for the GLM model family. Capability bits only:
// which effort levels a model truly accepts on a given transport face, and
// whether thinking has a face-level default. Session-level semantics (replay,
// sendReasoning) live in the session layer and are deliberately out of scope.

export type GlmFace = "zhipuai" | "anthropic" | "other"

export type GlmSpec = {
  generation: "4.x" | "5.x"
  // Effort levels this model actually accepts on this face.
  efforts: readonly ("low" | "high" | "max")[]
  // "on"/"off" = face-level thinking default, null = no face-level default.
  thinkingDefault: "on" | "off" | null
  // True when the generic effort ladder must be suppressed even though native
  // efforts may exist (all 4.x).
  suppressGenericEfforts: boolean
  // True when the parsed version is not a known release; the spec then
  // describes the latest known generation and consumers may choose to warn.
  unknown: boolean
}

// Maps the SDK package to the transport face. The zhipuai native API is
// consumed through the OpenAI-compatible SDK.
export function glmFaceOf(npm?: string): GlmFace {
  if (npm === "@ai-sdk/openai-compatible") return "zhipuai"
  if (npm === "@ai-sdk/anthropic") return "anthropic"
  return "other"
}

// Version-prefix anchored: only ids starting with glm-<major>.<minor> parse.
// Alias separators (glm-5p2, glm-5-2) and glm-ish non-GLM ids
// (my-glm-tuned-llama) intentionally fail — never guess a generation for them.
const GLM_VERSION = /^glm-(\d+)\.(\d+)/

const KNOWN_VERSIONS = new Set(["4.5", "4.6", "5.2", "5.3"])

export function glmNative(model: { modelID: string; reasoning: boolean }, face: GlmFace): false | GlmSpec {
  if (!model.reasoning || face === "other") return false
  const match = GLM_VERSION.exec(model.modelID.toLowerCase())
  if (!match) return false
  const major = Number(match[1])
  const generation = major >= 5 ? "5.x" : "4.x"
  const unknown = major > 5 || !KNOWN_VERSIONS.has(`${major}.${match[2]}`)
  const thinkingDefault = face === "zhipuai" ? "on" : null
  if (generation === "4.x") {
    return {
      generation,
      // The Anthropic-compatible endpoint suppresses the effort ladder on 4.x.
      efforts: face === "zhipuai" ? ["low", "high", "max"] : [],
      thinkingDefault,
      suppressGenericEfforts: true,
      unknown,
    }
  }
  return {
    generation,
    // TODO: zhipuai-face 5.x ladder is single-sourced from models.dev; verify online.
    efforts: face === "zhipuai" ? ["low", "high", "max"] : ["high", "max"],
    thinkingDefault,
    suppressGenericEfforts: false,
    unknown,
  }
}
