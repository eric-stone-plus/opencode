# Measurement ladder

Read-only commands, silicon to egress. Every rung names the **trap** that lives there — each one is a defect that actually reached a published report in the origin audit, so the case law is the reason the rung exists.

Walk rungs in order, but treat **L2 as a gate on every other rung's timestamps**: in the origin audit a clock step poisoned every published boot table, and three rounds quoted wall-clock times from it before anyone checked.

Portability: commands assume a systemd/journald Linux host (Fedora in the origin audit). On another init, substitute the equivalent read-only inspector; the trap travels even when the command does not.

## L0 — Silicon and firmware

| Measure | Command | Trap |
| --- | --- | --- |
| Thermal / throttling | `sensors`, `cat /sys/class/thermal/thermal_zone*/temp`, `lscpu | grep MHz` | A box at 97–99 °C under concurrent AI load makes live measurement itself a load generator. Set the **thermal budget** before measuring, and prefer archive primaries over fresh probes. |
| Memory errors | `journalctl -k | grep -iE 'mce|edac|ecc'`, `edac-util -v` | Absence of hits is not absence of ECC: many boards report only via firmware. Say which channel you checked. |
| Disk health | `smartctl -H /dev/nvme0`, `smartctl -A` | `-H` says PASSED on a drive with growing reallocated sectors; read the attributes, not the verdict. |
| Firmware/ucode | `dmesg | grep -i microcode`, `fwupdmgr get-devices` (read-only subcommands) | A microcode load failure is silent at runtime and shows only in early boot records — which L2 may have mis-timestamped. |

## L1 — Kernel

`journalctl -k -b N -o short-monotonic` for the boot under test; `dmesg` only for the current one.

- **OOM kills**: `journalctl -k | grep -iE 'out of memory|oom-kill'`. The trap: an OOM kill recorded as a clean service exit. Cross-check the unit's own log for the same monotonic window.
- **Hung/blocked tasks**: `grep -iE 'hung_task|blocked for more than'`. 
- **Coredumps**: `coredumpctl list` **and** `ls /var/lib/systemd/coredump/`. Trap: a report asserted "the core is in `/var/lib/systemd/coredump/`" as proof of success; the directory listing is the only evidence, and a config can route cores elsewhere or disable them.
- **Journal retention**: `journalctl --disk-usage`, `journalctl --header`. Trap: a finding measured over `/30 d` while the journal retained **15.3 d** — the window was longer than the record, so the count was unknowable. Measure retention **before** asserting any count over a window.

## L2 — Clock and journal integrity (the gate)

- **Boot list**: `journalctl --list-boots`. **Trap**: the FIRST cell is +8 h for *every* boot whose early records precede the chrony step, not just some. Detecting it by row reversal (FIRST > LAST) only catches boots shorter than the offset — the published detection rule was wrong for exactly the boots that mattered.
- **Monotonic, always**: `journalctl -b N -o short-monotonic`. Wall-clock ordering across a step is meaningless. `--since`/`--until` are unusable for the same reason.
- **Boot anchor**: `uptime -s` and the monotonic↔wall pair from the boot's own first and last records. Trap: back-deriving a microsecond digit from a rounded published delta produces a **derived number typeset as measured** — and three candidate digits all rounded to the same published value, so the derivation could not discriminate between them. Copy the primary's digits instead.
- **Step events**: `journalctl -u chronyd -o short-monotonic | grep -iE 'step|backward|forward'`.
- **Rotation/loss**: `journalctl --header | grep -i -A2 'state\|files'`. A gap between boots can be rotation rather than downtime; assert which only after checking.

## L3 — Init and service supervision

- **Failed and restarting units**: `systemctl --failed`, `systemctl list-units --state=activating`, and per-unit `systemctl status` (read-only).
- **Restart loops**: `systemctl show <unit> -p NRestarts,ExecMainStartTimestamp,ActiveEnterTimestamp`. Trap: a unit that "works" after 137 restarts; the restart count is the finding.
- **Drop-ins**: `systemctl cat <unit>` shows the effective unit including `override.conf`. Trap: a report quoted the vendor unit while a drop-in changed the behaviour under test.
- **`ExecStopPost=` traps**: read what the stop hook actually executes. The origin host had a cgroup-cleanup hook that SIGKILLed **every PID in the caller's own cgroup** — running it by hand from an agent shell killed the agent session three times. It is safe only as the unit's own stop hook: trigger it via `systemctl --user stop|restart <unit>`, never directly. Reading the file is always safe.
- **Kill discipline**: record the PID at startup (`setsid … & echo $! > run.pid`) and stop by numeric PID or process group. Pattern-kills (`pkill -f`) match the shell running them: in an agent harness argv is the entire script, so the pattern is always present. Split match from kill into two calls.

## L4 — Resources

- **Quotas and full filesystems**: `df -h`, `df -i`, quota per user. Trap: a GUI client SIGABRTing because `/tmp` hit quota — the composite failure appeared in no single archive.
- **Unlinked but running code**: `lsof +L1`. A process holding a deleted library file runs the **old** code no matter what the path says. Trap: verifying the *path* on disk does not prove which *inode* the process executes — one round's rule conflated them, and the correction had to distinguish path-verification from inode-verification explicitly.
- **Memory pressure / swap**: `cat /proc/pressure/memory`, `free -h`, `swapon --show`.
- **File descriptors**: `cat /proc/sys/fs/file-nr`, per-process `ls /proc/<pid>/fd | wc -l`.
- **Filesystem integrity**: `btrfs filesystem usage <mount>` (read-only subcommands only; no balance, no scrub-start, no device deletion).

## L5 — Security policy

- **SELinux**: `getenforce`, `ausearch -m avc -ts recent` (read-only), `sestatus`. Trap: suppression tests (`setenforce 0`, `audit2allow`) are **policy mutations** — off-limits in a read-only round; register the hypothesis instead of testing it.
- **Firewall**: `firewall-cmd --list-all`, `--list-rich-rules`. Trap: a rich rule dropping a port looks like an application failure from the workload's side. Quote rules **byte-exact** — the origin audit's `--list-rich-rules` output had two spaces where a report quoted one, and the quote was labelled 逐字.
- **Audit rules**: `auditctl -l` (listing is read-only; adding syscall rules is a mutation — deferred, registered).

## L6 — The workload under test

- **What is the long-running task?** Name it, its PID, its start monotonic, and its expected lifetime.
- **Crash artifacts**: coredumps (L1), the workload's own logs, and the compositor/session log for GUI workloads. Trap: a Wayland client crash attributed to a mechanism nobody measured; the honest finding was "asserted as 实测 that no round actually measured".
- **Restart vs recovery**: distinguish "the service restarted itself" from "the operator restarted it" — journald monotonic plus the unit's `ExecMainStartTimestamp` settles it.
- **Concurrent-load confound**: if several heavy workloads share the box, thermal and memory findings are joint. Record what else was running during the window; an unattributed correlation becomes a mechanism claim in the next round's summary.

## L7 — Egress and reachability

- **Reachability ≠ throughput.** Trap: `api.github.com` answered 200 and a `HEAD` on a release asset answered 200, so "GitHub is reachable" — while the asset body trickled at ~20 KB/s and a 147 MB fetch moved 23 MB in 19 minutes. Probe bulk paths with a ranged GET and compare routes: `curl -r 0-8388607 -o /dev/null -w '%{speed_download}\n' <url>`, direct vs proxy.
- **DNS poisoning**: a hostname resolving to an unrelated operator's address block, with connect failing, is poisoning rather than downtime. Record the resolved address.
- **Off-box probes** (peer reachability, LAN SSH, tailnet ACLs) need the other end's cooperation and are usually **out of scope for a read-only round** — register them as open rather than inferring from one side.

## Baseline snapshot for a fresh machine

On a new box, capture L0–L5 once, with outputs, into `baseline-<date>/`, and record the box identity plus the versions (`uname -a`, `rpm -qa | wc -l` or equivalent, firmware). That snapshot is the comparison point for every later round: without it, "it got worse" has no referent, and drift findings collapse into unverifiable memory.

Then set the budget and walk the ladder again under the real workload — the idle baseline and the loaded one disagree, and the disagreement is usually the finding.
