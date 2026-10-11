import { ModelsDev } from "@opencode-ai/schema/models-dev"

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.opencode.ai"

const raw = process.env.MODELS_DEV_API_JSON
  ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
  : await fetch(`${modelsUrl}/api.json`).then((response) => response.text())
export const modelsData = JSON.stringify(ModelsDev.restrict(JSON.parse(raw) as Record<string, unknown>))

console.log("Loaded models.dev snapshot")
