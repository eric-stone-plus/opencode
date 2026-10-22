#!/usr/bin/env bash
# bashrc-opencode-block.sh — opencode() TTY/token wrapper for ~/.bashrc
#
# 2026-10-22: launch-time egress detection removed by operator request.
#   The wrapper no longer probes provider endpoints, selects a proxy, restarts
#   causeway, or passes --standalone. The shell's proxy environment
#   (proxy-on / proxy-off) and the V2 service environment are authoritative.
#   Caveat: the shared `opencode serve --service` keeps the env of the client
#   that spawned it, so `proxy-on` only reaches a service spawned after it;
#   restart the service after changing proxies (`opencode service restart`).
#   This removes the 0.2-2 s probe and the false-negative path that sent a
#   reachable direct session to 17878.
#
# What it still does:
#   1. TTY hygiene: opencode's TUI enables xterm mouse tracking. A hard death
#      (kill -9 / crash) skips cleanup, and the shell then echoes click/scroll
#      SGR reports as input. _oc_tty_reset disables the modes on entry and exit;
#      _oc_tty_flush_input discards the residual pty input queue.
#      NEVER send ?1049l here: VTE and tmux restore the cursor to the last
#      ?1049h save point, which corrupts the main screen. VTE exits the
#      alternate screen when the child dies.
#   2. TUI token strip: a TUI launched from an opencode-spawned shell inherits
#      OPENCODE_SESSION_ID / OPENCODE_SESSION_TOKEN. The service treats that as
#      a session-scoped credential and rejects /api/event with
#      "Session access token cannot use this route"; the TUI then retries
#      "Restarting service..." every second. A new TUI is an operator client, so
#      the child runs without those two variables (the parent shell keeps them).
#      Headless subcommands keep the token for session confinement.
#
# DEPENDENCIES: bash (interactive), python3 (_oc_tty_flush_input).
# CAUSEWAY_GFW_PROXY is exported for compatibility with other shell helpers;
# this block no longer reads it.

export CAUSEWAY_GFW_PROXY="${CAUSEWAY_GFW_PROXY:-http://127.0.0.1:18880}"

_oc_run() {  # $1=--tui optional; $2=command; rest=args
    local tui=0
    if [[ "$1" == --tui ]]; then tui=1; shift; fi
    if [[ $tui -eq 1 ]]; then
        ( unset OPENCODE_SESSION_ID OPENCODE_SESSION_TOKEN; command "$@" )
    else
        command "$@"
    fi
}

_oc_is_tui() {
    # True when this invocation opens the TUI, false for a headless subcommand.
    # Root flags may precede the subcommand and several take a value, so skip
    # those values before looking at the first operand. Default to non-TUI for
    # an unknown operand: keeping the agent-shell session token is the safe
    # failure (the CLI fails closed without a token). The subcommand list
    # mirrors `opencode --help`; update it when a subcommand is added.
    local -a subs=(acp api auth debug mcp models plugin stats mini run session service reload pair serve)
    local a s skip=0 endopts=0
    for a in "$@"; do
        if [[ $skip -eq 1 ]]; then skip=0; continue; fi
        if [[ $endopts -eq 1 ]]; then
            [[ -d "$a" ]] && return 0
            return 1
        fi
        case "$a" in
            --) endopts=1; continue ;;
            --server|--session|-s|--prompt|--log-level|--agent|--agents|--allow|--deny|--add-dir|--cwd|--debug-file|--disallowed-tools)
                skip=1; continue ;;
            --*=*|-s=*) continue ;;
            -*) continue ;;
        esac
        for s in "${subs[@]}"; do
            [[ "$a" == "$s" ]] && return 1
        done
        [[ -d "$a" ]] && return 0
        return 1
    done
    return 0
}

_oc_tty_reset() {
    # Best-effort terminal restore after a hard TUI death. Idempotent on a
    # normal /exit; only writes when stdout is a terminal so `opencode run`
    # pipes stay clean.
    [[ -t 1 ]] || return 0
    printf '\e[?1003l\e[?1002l\e[?1000l\e[?1006l\e[?2004l\e[?2031l\e[>4;0m\e[0 q\e[?25h'
    return 0
}

_oc_tty_flush_input() {
    # Drop residual mouse reports left in the pty input queue after the TUI
    # exits; readline would otherwise echo them into the next command.
    [[ -t 1 ]] && python3 -c 'import termios,os;fd=os.open("/dev/tty",os.O_RDWR|os.O_NOCTTY);termios.tcflush(fd,termios.TCIFLUSH);os.close(fd)' 2>/dev/null
    return 0
}

opencode() {
    local tui=0 rc
    _oc_is_tui "$@" && tui=1
    _oc_tty_reset
    if [[ $tui -eq 1 ]]; then
        _oc_run --tui opencode "$@"
    else
        _oc_run opencode "$@"
    fi
    rc=$?
    _oc_tty_reset
    _oc_tty_flush_input
    return $rc
}
