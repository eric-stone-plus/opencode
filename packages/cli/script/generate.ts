const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai"

const raw = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  : await fetch(`${modelsUrl}/api.json`).then((response) => response.text())
// Strip OpenCode Zen free models ("opencode", "opencode-go"); harness-only fork.
const models = JSON.parse(raw) as Record<string, unknown>
delete models.opencode
delete models["opencode-go"]
export const modelsData = JSON.stringify(models)

console.log("Loaded models.dev snapshot")
