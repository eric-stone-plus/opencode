#!/usr/bin/env bun
/**
 * Watch a running opencode process for "idle but burning CPU".
 *
 *   bun run cpu-probe                        5s ticks, auto stack dump on idle spin
 *   bun run cpu-probe -- --interval 2
 *   bun run cpu-probe -- --no-capture        TSV only, never run sample(1)
 *   bun run cpu-probe -- --exclude 62796     measure a pid but never sample it
 *   bun run cpu-probe -- --duration 3600     stop after an hour
 *
 * A tick counts as idle when ~/.local/share/opencode/log/opencode.log has not
 * moved for --idle-seconds. Idle plus --cpu-threshold percent CPU for --strikes
 * consecutive ticks is the spin, and that is when sample(1) gets captured, so
 * the stack trace exists even when nobody is looking at the terminal.
 *
 * Caveat: every opencode instance on this machine shares that one log file, so
 * the idle gate is global, not per pid. With a second instance busy the probe
 * never fires; run it when only the suspect instance is up, or pass --exclude
 * for the busy one so it still gets measured but is never sampled.
 *
 * sample(1) suspends the target's threads while it walks stacks. ps(1) does
 * not, so measurement is always safe; capture is not.
 *
 * Output (gitignored):
 *   logs/cpu-probe/probe-YYYYMMDD.tsv
 *   logs/cpu-probe/spin-<stamp>-<pid>.txt
 *
 * pgrep(1) is unreliable under sandboxed shells, so process discovery goes
 * through ps(1) instead.
 */
import { $ } from "bun"
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT_DIR = path.join(ROOT, "logs", "cpu-probe")
const OPENCODE_LOG = path.join(homedir(), ".local", "share", "opencode", "log", "opencode.log")
const TARGET = "opencode"
const TIME_TOKEN = /(?:\d+-)?(?:\d+:)?\d+:\d+(?:\.\d+)?/g
const HEADER = [
  "ts",
  "pid",
  "cpu_pct",
  "rss_mb",
  "threads",
  "top_thread_idx",
  "top_thread_pct",
  "log_idle_s",
  "log_bytes",
  "event",
].join("\t")

function strArg(name: string) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

function numArg(name: string, fallback: number) {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const parsed = Number(process.argv[at + 1])
  return Number.isFinite(parsed) ? parsed : fallback
}

const INTERVAL = Math.max(1, numArg("interval", 5))
const CPU_THRESHOLD = numArg("cpu-threshold", 50)
const IDLE_SECONDS = numArg("idle-seconds", 60)
const STRIKES = Math.max(1, numArg("strikes", 3))
const COOLDOWN = numArg("cooldown", 600)
const REPORT_EVERY = Math.max(1, numArg("report", 12))
const DURATION = numArg("duration", 0)
const CAPTURE = !process.argv.includes("--no-capture")
// sample(1) suspends the target's threads while it walks stacks, so pids doing
// real work must stay measurable (ps is read-only) but never sampled.
const EXCLUDE = new Set(
  (strArg("exclude") ?? "")
    .split(",")
    .map((raw) => Number(raw.trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0),
)

// ps(1) prints CPU time as [dd-][hh:]mm:ss[.cc]; reduce left to right so both
// the two-field and three-field forms land on seconds.
function cpuSeconds(token: string) {
  const day = /^(\d+)-/.exec(token)
  const clock = day ? token.slice(day[0].length) : token
  const parts = clock.split(":").map(Number)
  if (parts.length < 2) return Number.NaN
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN
  return (day ? Number(day[1]) * 86400 : 0) + parts.reduce((total, part) => total * 60 + part, 0)
}

function timeTokens(line: string) {
  return (line.match(TIME_TOKEN) ?? []).map(cpuSeconds).filter((value) => Number.isFinite(value))
}

async function sh(args: string[]) {
  const result = await $`${args}`.nothrow().quiet()
  return result.exitCode === 0 ? result.text() : ""
}

async function discoverPids() {
  const text = await sh(["ps", "-axo", "pid=,comm="])
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2)
    .map((fields) => ({ pid: Number(fields[0]), comm: path.basename(fields.slice(1).join(" ")) }))
    .filter((entry) => Number.isFinite(entry.pid) && entry.pid !== process.pid && entry.comm === TARGET)
    .map((entry) => entry.pid)
}

async function processCpu(pid: number) {
  const tokens = timeTokens((await sh(["ps", "-o", "time=", "-p", String(pid)])).trim())
  return tokens.length > 0 ? tokens[tokens.length - 1] : Number.NaN
}

async function processRssMb(pid: number) {
  const kb = Number((await sh(["ps", "-o", "rss=", "-p", String(pid)])).trim())
  return Number.isFinite(kb) ? Math.round(kb / 1024) : -1
}

// ps -M prints the process row first and one row per thread after it, so
// dropping the header leaves every row's own STIME+UTIME.
async function threadCpu(pid: number) {
  const text = await sh(["ps", "-M", String(pid)])
  return text
    .split("\n")
    .slice(1)
    .map((line) => timeTokens(line))
    .filter((tokens) => tokens.length >= 2)
    .map((tokens) => tokens[tokens.length - 2] + tokens[tokens.length - 1])
}

function logState() {
  if (!existsSync(OPENCODE_LOG)) return { bytes: -1, ageSeconds: -1 }
  const st = statSync(OPENCODE_LOG)
  return { bytes: st.size, ageSeconds: Math.max(0, (Date.now() - st.mtimeMs) / 1000) }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function tsvFile() {
  return path.join(OUT_DIR, `probe-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.tsv`)
}

async function captureSpin(pid: number, cpuPct: number, idleFor: number) {
  const file = path.join(OUT_DIR, `spin-${stamp()}-${pid}.txt`)
  const head = [
    "# idle CPU spin capture",
    `# pid=${pid} cpu_pct=${cpuPct.toFixed(1)} log_idle_s=${idleFor.toFixed(0)}`,
    `# captured_at=${new Date().toISOString()}`,
    `# ps -M ${pid}`,
    await sh(["ps", "-M", String(pid)]),
    `# sample ${pid} 3`,
    "",
  ].join("\n")
  const sampled = await $`sample ${pid} 3`.nothrow().quiet()
  writeFileSync(file, `${head}\n${sampled.text()}`)
  return sampled.exitCode === 0 ? file : `${file} (sample exit ${sampled.exitCode})`
}

const prevTotal = new Map<number, { at: number; seconds: number }>()
const prevThreads = new Map<number, { at: number; seconds: number[] }>()
const strikes = new Map<number, number>()
const lastCapture = new Map<number, number>()

async function spinEvent(pid: number, count: number, cpuPct: number, idleFor: number) {
  if (count < STRIKES) return ""
  if (!CAPTURE) return "SPIN"
  if (EXCLUDE.has(pid)) return "SPIN_EXCLUDED"
  if ((Date.now() - (lastCapture.get(pid) ?? 0)) / 1000 < COOLDOWN) return "SPIN_COOLDOWN"
  lastCapture.set(pid, Date.now())
  strikes.set(pid, 0)
  return `SPIN_CAPTURED ${await captureSpin(pid, cpuPct, idleFor)}`
}

async function measure(pid: number, log: { bytes: number; ageSeconds: number }) {
  const now = Date.now()
  const total = await processCpu(pid)
  const threads = await threadCpu(pid)
  const rss = await processRssMb(pid)
  const before = prevTotal.get(pid)
  const beforeThreads = prevThreads.get(pid)
  prevTotal.set(pid, { at: now, seconds: total })
  prevThreads.set(pid, { at: now, seconds: threads })

  const dt = before ? (now - before.at) / 1000 : 0
  const used = before && Number.isFinite(total) && total >= before.seconds ? total - before.seconds : Number.NaN
  const cpuPct = dt > 0 && Number.isFinite(used) ? (used / dt) * 100 : Number.NaN

  // Thread rows shift when Bun retires pool threads, so only the prefix that
  // both snapshots share is comparable.
  const threadDt = beforeThreads ? (now - beforeThreads.at) / 1000 : 0
  const comparable = Math.min(beforeThreads?.seconds.length ?? 0, threads.length)
  const deltas = Array.from({ length: comparable }, (_, index) => threads[index] - (beforeThreads?.seconds[index] ?? 0))
    .map((delta) => (delta < 0 || threadDt <= 0 ? Number.NaN : (delta / threadDt) * 100))
  const topPct = deltas.reduce((best, value) => (Number.isFinite(value) && value > best ? value : best), -1)

  const spinning = Number.isFinite(cpuPct) && cpuPct >= CPU_THRESHOLD && log.ageSeconds >= IDLE_SECONDS
  const count = spinning ? (strikes.get(pid) ?? 0) + 1 : 0
  strikes.set(pid, count)
  const event = await spinEvent(pid, count, cpuPct, log.ageSeconds)

  const cells = [
    new Date(now).toISOString(),
    String(pid),
    Number.isFinite(cpuPct) ? cpuPct.toFixed(1) : "",
    String(rss),
    String(threads.length),
    String(deltas.findIndex((value) => value === topPct)),
    topPct >= 0 ? topPct.toFixed(1) : "",
    log.ageSeconds >= 0 ? log.ageSeconds.toFixed(0) : "",
    String(log.bytes),
    event,
  ]
  const detail =
    `${pid} cpu=${Number.isFinite(cpuPct) ? `${cpuPct.toFixed(0)}%` : "?"} thr=${threads.length}` +
    `${topPct >= 0 ? ` top=${deltas.findIndex((value) => value === topPct)}:${topPct.toFixed(0)}%` : ""}` +
    `${count > 0 ? ` strikes=${count}` : ""}`
  return { line: cells.join("\t"), detail, event }
}

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(tsvFile(), `${HEADER}\n`, { flag: "a" })

let ticks = 0
let stopped = false
const stop = () => {
  stopped = true
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)

console.log(
  `cpu-probe: target=${TARGET} interval=${INTERVAL}s spin= cpu>=${CPU_THRESHOLD}% && log_idle>=${IDLE_SECONDS}s x${STRIKES}` +
    ` capture=${CAPTURE} exclude=${[...EXCLUDE].join(",") || "none"} -> ${OUT_DIR}`,
)

const startedAt = Date.now()
while (!stopped) {
  const tickStart = Date.now()
  const pids = await discoverPids()
  const log = logState()
  const rows = await Promise.all(pids.map((pid) => measure(pid, log)))
  appendFileSync(tsvFile(), rows.map((row) => row.line).join("\n") + (rows.length > 0 ? "\n" : ""))
  rows.filter((row) => row.event).forEach((row) => console.log(row.line))

  const gone = [...prevTotal.keys()].filter((pid) => !pids.includes(pid))
  gone.forEach((pid) => {
    prevTotal.delete(pid)
    prevThreads.delete(pid)
    strikes.delete(pid)
  })
  if (gone.length > 0) {
    const ts = new Date().toISOString()
    appendFileSync(tsvFile(), gone.map((pid) => `${ts}\t${pid}\t\t\t\t\t\t\t\tPID_GONE`).join("\n") + "\n")
    console.log(`cpu-probe: pid ${gone.join(",")} gone`)
  }

  ticks++
  if (ticks % REPORT_EVERY === 0) {
    const detail = rows.length > 0 ? rows.map((row) => row.detail).join(" | ") : "no opencode process"
    console.log(`cpu-probe: tick ${ticks} log_idle=${log.ageSeconds.toFixed(0)}s ${detail}`)
  }

  if (DURATION > 0 && (Date.now() - startedAt) / 1000 >= DURATION) break
  await Bun.sleep(Math.max(200, (INTERVAL - (Date.now() - tickStart) / 1000) * 1000))
}

console.log(`cpu-probe: stopped after ${ticks} ticks -> ${tsvFile()}`)
