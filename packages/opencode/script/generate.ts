import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
const models = JSON.parse(
  process.env.MODELS_DEV_API_JSON
    ? await Bun.file(process.env.MODELS_DEV_API_JSON).text()
    : await fetch(`${modelsUrl}/api.json`).then((x) => x.text()),
) as Record<string, unknown>
// Strip OpenCode Zen free models ("opencode", "opencode-go"); harness-only fork.
delete models.opencode
delete models["opencode-go"]
export const modelsData = JSON.stringify(models)
console.log("Loaded models.dev snapshot")
