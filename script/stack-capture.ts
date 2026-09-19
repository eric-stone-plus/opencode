/**
 * Platform stack capture shared by cpu-probe and freeze-capture.
 *
 * macOS: sample(1) — suspends the target's threads while it walks stacks.
 * Linux: eu-stack(1) (elfutils), falling back to gdb(1), plus an always-on
 * ps -L thread table. Both attach tools stop the target briefly, so the same
 * "never capture a busy session" rule from sample(1) applies.
 *
 * Linux attach needs ptrace access: fine when kernel.yama.ptrace_scope=0;
 * with scope=1 only the process parent may attach, and capture degrades to
 * the ps/wchan thread table (state still classifiable, no userspace frames).
 */
import { $ } from "bun"

export type ThreadState = "IO_WAIT" | "RUNNING" | "PARKED"

export interface ThreadSnap {
  name: string
  state: ThreadState
  frames: string[]
  wchan?: string
}

export interface Capture {
  tool: string
  raw: string
  threads: ThreadSnap[]
  histogram: string[]
}

async function sh(args: string[]) {
  const result = await $`${args}`.nothrow().quiet()
  return { ok: result.exitCode === 0, text: result.text() }
}

// One row per thread: ps -M on macOS, ps -L on Linux.
export function threadTableArgs(pid: number) {
  if (process.platform === "darwin") return ["ps", "-M", String(pid)]
  return ["ps", "-L", "-o", "pid=,tid=,state=,wchan:32=,time=,comm=", "-p", String(pid)]
}

export async function captureThreads(pid: number, seconds: number): Promise<Capture> {
  if (process.platform === "darwin") return captureMac(pid, seconds)
  return captureLinux(pid)
}

// ---------- macOS ----------

const MAC_PARKING = [
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

const MAC_TTY_IO = ["pwrite", "pwritev", "write", "writev", "ioctl", "read", "readv", "recvmsg", "sendmsg", "fsync"]

// sample(1) prints the call graph root-first, then a "Total number in stack"
// tally and a "Sort by top of stack" histogram. Only the first section is a
// per-thread tree; the other two are flat symbol lists.
function macThreadBlocks(text: string) {
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

function macClassify(frames: string[]): ThreadState {
  const symbols = frames.map((frame) => frame.split(" (")[0] ?? "")
  if (symbols.some((symbol) => MAC_TTY_IO.includes(symbol))) return "IO_WAIT"
  if (symbols.some((symbol) => MAC_PARKING.includes(symbol))) return "PARKED"
  return "RUNNING"
}

function macHistogram(text: string) {
  const section = text.split(/^Sort by top of stack/m)[1] ?? ""
  return (section.split(/^Binary Images:/m)[0] ?? "").split("\n").map((line) => line.trim()).filter(Boolean)
}

async function captureMac(pid: number, seconds: number): Promise<Capture> {
  const result = await $`sample ${pid} ${seconds}`.nothrow().quiet()
  const raw = `$ sample ${pid} ${seconds}\n# exit=${result.exitCode}\n${result.text()}`
  const threads = macThreadBlocks(result.text()).map((block) => ({ ...block, state: macClassify(block.frames) }))
  return { tool: "sample", raw, threads, histogram: macHistogram(result.text()) }
}

// ---------- Linux ----------

// Tokens must not match inside longer symbols ("read" inside "pthread_cond_…"
// classifies every condvar wait as tty IO), so each is wrapped in a boundary
// regex: the neighbour may be anything but a lowercase letter. Leading
// underscores stay legal, so "__read" and "futex_do_wait" still match.
const boundary = (token: string) => new RegExp(`(?:^|[^a-z])${token}(?:[^a-z]|$)`, "i")

const LINUX_TTY_IO = [
  "pwritev2?",
  "pwrite64",
  "pwrite",
  "writev",
  "write",
  "preadv2?",
  "pread64",
  "pread",
  "readv",
  "read",
  "ioctl",
  "recvmsg",
  "sendmsg",
  "fsync",
  "tty_write",
  "tty_ioctl",
  "pipe_read",
  "pipe_write",
].map(boundary)

const LINUX_PARKING = [
  "futex",
  "epoll",
  "poll",
  "p?select6?",
  "nanosleep",
  "hrtimer",
  "wait_queue",
  "wait_woken",
  "kworker",
  "cond_wait",
  "pthread_cond",
  "rcu_gp",
].map(boundary)

function linuxClassify(hints: string[], state: string): ThreadState {
  const hay = hints.filter(Boolean)
  if (hay.some((hint) => LINUX_TTY_IO.some((token) => token.test(hint)))) return "IO_WAIT"
  if (hay.some((hint) => LINUX_PARKING.some((token) => token.test(hint)))) return "PARKED"
  // Without ptrace access Linux often reports only wchan=0. The ps state
  // still distinguishes a runnable thread from one sleeping or stopped.
  return state === "R" ? "RUNNING" : "PARKED"
}

interface LinuxThreadRow {
  tid: number
  state: string
  wchan: string
  time: string
  comm: string
}

async function linuxThreadTable(pid: number) {
  const result = await sh(threadTableArgs(pid))
  const rows = result.text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 5 && Number.isFinite(Number(fields[1])))
    .map(
      (fields): LinuxThreadRow => ({
        tid: Number(fields[1]),
        state: fields[2],
        wchan: fields[3] === "-" || fields[3] === "0" ? "" : fields[3],
        time: fields[4],
        comm: fields.slice(5).join(" "),
      }),
    )
  return { text: result.text, rows }
}

// eu-stack prints "#<n>  0x<addr> <symbol>" and leaves the symbol off when the
// binary has no DWARF (bun compiles JS in, so most frames land there).
function parseEuStack(text: string) {
  const frames = new Map<number, string[]>()
  let tid: number | undefined
  for (const line of text.split("\n")) {
    const head = /^TID (\d+):/.exec(line)
    if (head) {
      tid = Number(head[1])
      frames.set(tid, [])
      continue
    }
    if (tid === undefined) continue
    const frame = /^#\d+\s+0x[0-9a-f]+\s*(\S.*)?$/.exec(line)
    if (frame?.[1] && !frame[1].startsWith("??")) frames.get(tid)?.push(frame[1].trim())
  }
  return frames
}

// gdb thread apply all bt:
//   Thread 5 (Thread 0x7f1a... (LWP 30563)):
//   #0  0x00007f1a... in __futex_abstimed_wait_common () from /lib64/libc.so.6
function parseGdb(text: string) {
  const frames = new Map<number, string[]>()
  let tid: number | undefined
  for (const line of text.split("\n")) {
    const head = /^Thread \d+ \(Thread .*LWP (\d+)\)/.exec(line)
    if (head) {
      tid = Number(head[1])
      frames.set(tid, [])
      continue
    }
    if (tid === undefined) continue
    const frame = /^#\d+\s+(?:0x[0-9a-f]+\s+in\s+)?(\S.*)$/.exec(line)
    if (frame && !frame[1].startsWith("??")) frames.get(tid)?.push(frame[1].trim())
  }
  return frames
}

async function captureLinux(pid: number): Promise<Capture> {
  const table = await linuxThreadTable(pid)

  // eu-stack exits non-zero on DWARF-less binaries but still prints every
  // thread, so acceptance goes by output, not exit code. gdb is the fallback.
  let tool = "ps-only"
  let stackText = ""
  const eu = await sh(["eu-stack", "-p", String(pid)])
  if (eu.text.includes("TID")) {
    tool = "eu-stack"
    stackText = eu.text
  }
  if (tool === "ps-only") {
    const gdb = await sh(["gdb", "-batch", "-p", String(pid), "-ex", "set pagination off", "-ex", "thread apply all bt"])
    if (gdb.text.includes("Thread")) {
      tool = "gdb"
      stackText = gdb.text
    }
  }
  const frames = tool === "gdb" ? parseGdb(stackText) : parseEuStack(stackText)

  const threads: ThreadSnap[] = table.rows.map((row) => {
    const own = frames.get(row.tid) ?? []
    return {
      name: `TID ${row.tid} ${row.comm} state=${row.state} wchan=${row.wchan || "-"}`,
      state: linuxClassify([row.wchan, ...own], row.state),
      frames: own,
      wchan: row.wchan,
    }
  })

  const tops = new Map<string, number>()
  threads.forEach((thread) => {
    const top = thread.frames[0] ?? (thread.wchan ? `wchan:${thread.wchan}` : "")
    if (top) tops.set(top, (tops.get(top) ?? 0) + 1)
  })
  const histogram = [...tops.entries()].sort((a, b) => b[1] - a[1]).map(([symbol, count]) => `${count}  ${symbol}`)

  const stackHead =
    tool === "ps-only"
      ? `# no userspace stacks (eu-stack/gdb missing or ptrace denied; check kernel.yama.ptrace_scope)`
      : `$ ${tool} ${tool === "eu-stack" ? `-p ${pid}` : `-batch -p ${pid} -ex "thread apply all bt"`}`
  const raw = [
    `$ ${threadTableArgs(pid).join(" ")}`,
    table.text.trim(),
    "",
    stackHead,
    stackText.trim() || "(no output)",
    "",
  ].join("\n")
  return { tool, raw, threads, histogram }
}
