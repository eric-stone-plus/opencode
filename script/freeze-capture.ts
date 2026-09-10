#!/usr/bin/env bun
/**
 * Snapshot a frozen opencode TUI before killing it.
 *
 *   bun run freeze-capture                     find the opencode pid, sample 5s
 *   bun run freeze-capture -- --pid 61429
 *   bun run freeze-capture -- --seconds 10
 *
 * Writes logs/freeze/<stamp>/ (gitignored) and prints the headline. Threads are
 * sorted into three states because "blocked" alone hides the interesting case:
 *
 *   IO_WAIT  parked inside write/pwrite/ioctl on the tty. The renderer drains
 *            stdout through pwrite, so a terminal that stopped reading shows up
 *            here. This is the freeze signature, not a CPU spin.
 *   RUNNING  on-CPU, i.e. the render loop actually spinning.
 *   PARKED   futex/condvar/kevent waits. Normal for idle Bun pool and GC
 *            threads.
 *
 * Bun compiles the JS into the binary, so JS frames arrive as unsymbolicated
 * ??? and only the Zig stdlib / opentui / libsystem frames are readable. The
 * raw sample-<pid>.txt in the output directory is the authoritative capture.
 */
import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT_ROOT = path.join(ROOT, "logs", "freeze")
const PROBE_DIR = path.join(ROOT, "logs", "cpu-probe")
const OPENCODE_LOG = path.join(homedir(), ".local", "share", "opencode", "log", "opencode.log")
const TARGET = "opencode"

const PARKING = [
  "kevent64",
  "kevent",
  "kevent_id",
  "kevent_qos",
  "mach_msg2_trap",
  "mach_msg_trap",
  "mach_msg_overwrite_trap",
  "semaphore_wait_trap",
  "semaphore_timedwait_trap",
  "__psynch_cvwait",
  "__psynch_mutexwait",
  "__psynch_rw_rdwait",
  "__psynch_rw_wrwait",
  "__ulock_wait",
  "__ulock_wait2",
  "__workq_kernreturn",
  "__semwait_signal",
  "syscall_thread_switch",
  "swtch",
  "swtch_pri",
  "poll",
  "select",
]

const TTY_IO = ["pwrite", "pwritev", "write", "writev", "ioctl", "read", "readv", "recvmsg", "sendmsg", "fsync"]

function strArg(name: string) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

function numArg(name: string, fallback: number) {
  const raw = strArg(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const SECONDS = Math.max(1, numArg("seconds", 5))
const PID_ARG = strArg("pid")

async function sh(args: string[]) {
  const result = await $`${args}`.nothrow().quiet()
  return { ok: result.exitCode === 0, text: result.text() }
}

function save(outDir: string, name: string, body: string) {
  writeFileSync(path.join(outDir, name), body.endsWith("\n") ? body : `${body}\n`)
}

async function saveCmd(outDir: string, name: string, args: string[]) {
  const result = await sh(args)
  save(outDir, name, `$ ${args.join(" ")}\n# exit=${result.ok ? 0 : 1}\n${result.text}`)
}

// pgrep(1) is unreliable under sandboxed shells, so discovery goes through ps(1).
async function discoverPids() {
  const { text } = await sh(["ps", "-axo", "pid=,comm="])
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2)
    .map((fields) => ({ pid: Number(fields[0]), comm: path.basename(fields.slice(1).join(" ")) }))
    .filter((entry) => Number.isFinite(entry.pid) && entry.pid !== process.pid && entry.comm === TARGET)
    .map((entry) => entry.pid)
}

// sample(1) prints the call graph root-first, then a "Total number in stack"
// tally and a "Sort by top of stack" histogram. Only the first section is a
// per-thread tree; the other two are flat symbol lists.
function threadBlocks(text: string) {
  const graph = text.split(/^Total number in stack/m)[0] ?? ""
  return graph
    .split("\n")
    .reduce<{ name: string; frames: string[] }[]>((blocks, line) => {
      const head = /^\s*\d+\s+(Thread_\d+)\s*(.*)$/.exec(line)
      if (head) return [...blocks, { name: `${head[1]} ${head[2].trim()}`.trim(), frames: [] }]
      if (blocks.length === 0) return blocks
      const frame = /\d+\s+(\S.*?)\s+\(in\s+([^)]+)\)/.exec(line)
      if (!frame) return blocks
      const symbol = frame[1].trim()
      if (symbol.startsWith("???")) return blocks
      blocks[blocks.length - 1].frames.push(`${symbol} (${frame[2].trim()})`)
      return blocks
    }, [])
}

function classify(frames: string[]) {
  const symbols = frames.map((frame) => frame.split(" (")[0] ?? "")
  if (symbols.some((symbol) => TTY_IO.includes(symbol))) return "IO_WAIT"
  if (symbols.some((symbol) => PARKING.includes(symbol))) return "PARKED"
  return "RUNNING"
}

function topOfStack(text: string) {
  const section = text.split(/^Sort by top of stack/m)[1] ?? ""
  return (section.split(/^Binary Images:/m)[0] ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
}

async function tail(file: string, lines: number) {
  if (!existsSync(file)) return `(missing: ${file})`
  return (await Bun.file(file).text()).split("\n").slice(-lines).join("\n")
}

const pids = PID_ARG ? [Number(PID_ARG)].filter((pid) => Number.isFinite(pid)) : await discoverPids()
if (pids.length === 0) {
  console.error(`freeze-capture: no ${TARGET} process found (pass --pid <n>)`)
  process.exit(1)
}

const started = new Date()
const outDir = path.join(OUT_ROOT, started.toISOString().replace(/[:.]/g, "-"))
mkdirSync(outDir, { recursive: true })
console.log(`freeze-capture: pid=${pids.join(",")} seconds=${SECONDS} -> ${outDir}`)

const summary = [
  `freeze-capture ${started.toISOString()}`,
  `pids=${pids.join(",")}`,
  "states: IO_WAIT = parked in tty write (freeze signature) | RUNNING = on-CPU | PARKED = normal wait",
  "",
]

for (const pid of pids) {
  const ps = await sh(["ps", "-o", "pid=,ppid=,etime=,time=,%cpu=,rss=,state=,tty=,command=", "-p", String(pid)])
  const fields = ps.text.trim().split(/\s+/)
  save(outDir, `ps-${pid}.txt`, ps.text)
  await saveCmd(outDir, `lstart-${pid}.txt`, ["ps", "-o", "lstart=", "-p", String(pid)])
  await saveCmd(outDir, `ps-M-${pid}.txt`, ["ps", "-M", String(pid)])
  await saveCmd(outDir, `stdio-${pid}.txt`, ["lsof", "-a", "-p", String(pid), "-d", "0,1,2"])
  await saveCmd(outDir, `top-${pid}.txt`, [
    "top",
    "-l",
    "3",
    "-pid",
    String(pid),
    "-stats",
    "pid,cpu,th,mem,pstate,time,command",
  ])

  const sample = await $`sample ${pid} ${SECONDS}`.nothrow().quiet()
  const sampleText = sample.text()
  save(outDir, `sample-${pid}.txt`, sampleText)

  const lsof = await sh(["lsof", "-p", String(pid)])
  const fds = lsof.text.split("\n")
  save(outDir, `lsof-${pid}.txt`, `# total fds: ${fds.length}\n${fds.slice(0, 3000).join("\n")}`)

  const threads = threadBlocks(sampleText).map((block) => ({ ...block, state: classify(block.frames) }))
  const ioWait = threads.filter((thread) => thread.state === "IO_WAIT")
  const running = threads.filter((thread) => thread.state === "RUNNING")

  summary.push(
    `pid ${pid}: ${ps.text.trim().split("\n")[0] ?? "(ps failed)"}`,
    `  cpu=${fields[4] ?? "?"}% cputime=${fields[3] ?? "?"} elapsed=${fields[2] ?? "?"} rss_kb=${fields[5] ?? "?"} state=${fields[6] ?? "?"} tty=${fields[7] ?? "?"}`,
    `  threads=${threads.length} IO_WAIT=${ioWait.length} RUNNING=${running.length} PARKED=${threads.length - ioWait.length - running.length}`,
    `  lsof fds=${fds.length}`,
    "",
    "  IO_WAIT threads (tty backpressure — the usual freeze):",
  )
  summary.push(...(ioWait.length > 0 ? [] : ["    none"]))
  ioWait.slice(0, 6).forEach((thread) => {
    summary.push(`    ${thread.name}`)
    thread.frames.slice(-10).forEach((frame) => summary.push(`      ${frame}`))
  })
  summary.push("", "  RUNNING threads (on-CPU spin):")
  summary.push(...(running.length > 0 ? [] : ["    none"]))
  running.slice(0, 6).forEach((thread) => {
    summary.push(`    ${thread.name}`)
    thread.frames.slice(-10).forEach((frame) => summary.push(`      ${frame}`))
  })
  summary.push("", "  sample(1) top-of-stack histogram:")
  topOfStack(sampleText)
    .slice(0, 20)
    .forEach((line) => summary.push(`    ${line}`))
  summary.push("")
}

await saveCmd(outDir, "vm_stat.txt", ["vm_stat"])
await saveCmd(outDir, "memory_pressure.txt", ["memory_pressure"])
await saveCmd(outDir, "loadavg.txt", ["sysctl", "vm.loadavg", "vm.swapusage", "kern.boottime"])
await saveCmd(outDir, "uname.txt", ["uname", "-a"])
save(outDir, "opencode-log-tail.txt", await tail(OPENCODE_LOG, 5000))

const logAge = existsSync(OPENCODE_LOG)
  ? Math.max(0, (Date.now() - statSync(OPENCODE_LOG).mtimeMs) / 1000).toFixed(0)
  : "n/a"
summary.push(`opencode.log idle for ${logAge}s at capture time`)

const probes = existsSync(PROBE_DIR)
  ? readdirSync(PROBE_DIR)
      .filter((name) => name.startsWith("probe-") && name.endsWith(".tsv"))
      .sort()
  : []
const newest = probes.length > 0 ? path.join(PROBE_DIR, probes[probes.length - 1]) : undefined
if (newest) save(outDir, "cpu-probe-tail.tsv", await tail(newest, 500))
const spins = existsSync(PROBE_DIR) ? readdirSync(PROBE_DIR).filter((name) => name.startsWith("spin-")).length : 0
summary.push(
  newest
    ? `cpu-probe tsv=${newest} spin captures=${spins}`
    : "no cpu-probe data (start one with: bun run cpu-probe)",
)

save(outDir, "SUMMARY.txt", `${summary.join("\n")}\n\nfiles:\n${readdirSync(outDir).sort().map((name) => `  ${name}`).join("\n")}`)
console.log(summary.join("\n"))
console.log(`\nfreeze-capture: wrote ${path.join(outDir, "SUMMARY.txt")}`)
