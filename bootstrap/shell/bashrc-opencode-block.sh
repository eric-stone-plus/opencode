#!/usr/bin/env bash
# bashrc-opencode-block.sh — opencode() egress/TTY wrapper block for ~/.bashrc
#
# Verbatim extraction from machine A's ~/.bashrc (seat snapshot 2026-09-29).
# Provenance (machine A line numbers):
#   111        export CAUSEWAY_GFW_PROXY
#   210-213    egress self-heal strategy comment
#   214-240    _egress_direct_ok / _egress_proxy_or_bail / _via_proxy / _oc_run
#   252-290    _oc_tty_reset / _oc_tty_flush_input / opencode()
# The functions below started as machine-A .bashrc text (including its original
# Chinese comments). The DEVIATION LOG records every change; add an entry when
# editing, and re-extract when possible so diffs stay meaningful.
#
# WHAT IT DOES (load-bearing, do not skip):
#   1. Mouse-garbage TTY fix: opencode's TUI enables xterm mouse tracking
#      (?1000/?1002/?1003/?1006). A hard death (kill -9 / crash) skips the
#      cleanup, and the shell then echoes click/scroll SGR reports (e.g.
#      "35;112;35M") as input. _oc_tty_reset disables the modes on entry and
#      exit; _oc_tty_flush_input discards the residual pty input queue.
#      (NEVER send ?1049l in there — see original comment in the block.)
#   2. Egress selection: probe real direct egress for EVERY provider baseURL in
#      opencode.jsonc (proxy vars stripped); direct only when all pass. Any
#      unreachable endpoint sends the session to the first live local causeway
#      proxy (17878, then 18880) — switch-safe: no runtime model change can hit
#      a blocked endpoint unnoticed. Direct recovery automatically falls back to
#      direct on the next launch. The launcher does NOT restart causeway; use
#      `proxy-on` for gateway recovery (2026-10-22).
#   3. V2 service semantics: the TUI is a thin client and the shared background
#      service (`opencode serve --service`) makes the model requests. The service
#      keeps the environment of the client that spawned it, so a proxy exported by
#      this wrapper would never reach an already running service. A proxied TUI
#      launch therefore runs with --standalone (private server inheriting the
#      proxy env); direct launches keep the default shared service, whose env is
#      pinned by ~/.local/bin/opencode (OPENCODE_DB, OPENCODE_DISABLE_MODELS_FETCH)
#      and by `opencode service set env` (bootstrap/install.sh step 3).
#
# DEVIATION LOG (the marker claim "UNMODIFIED machine-A text" is scoped below):
#   2026-09-30 review F6 — probe set extended from two endpoints to three:
#   the default provider moved to xiaomi-token-plan-cn/mimo-v2.6-pro and the
#   wrapper still probed only the ali/glm endpoints, so a xiaomi-only outage
#   never triggered proxy self-heal. Endpoint host taken from the seat's
#   opencode.jsonc provider.xiaomi-token-plan-cn.options.baseURL (no derived
#   host assumption). Everything else stays machine-A verbatim.
#
#   2026-10-12 V2 re-base — probe set rewritten for the two live providers:
#   deepseek https://api.deepseek.com/chat/completions and xiaomi
#   https://token-plan-cn.xiaomimimo.com/v1/chat/completions (bailian/GLM probes
#   dropped with those providers). The proxied branch passes --standalone for TUI
#   launches (see 3 above). _oc_tty_reset/_oc_tty_flush_input are unchanged;
#   the proxy chain order was later changed (see the 2026-10-22 entry).
#
#   2026-10-15 V3 (silent-direct-egress-audit-20261015) — OR gate -> AND gate,
#   hardcoded probe set -> dynamic. The V2 "any endpoint reachable => direct"
#   hole: the session may talk to a different provider than the one probed —
#   runtime model switching (deepseek<->mimo in this seat) and agent-pinned
#   models make the launch-time "current model" unknowable, so a green probe on
#   endpoint A left a session that silently stalls on a blocked endpoint B the
#   moment it switches. (Adding missing providers to the OR set is a placebo:
#   OR can never be switch-safe.) Now every "baseURL" in opencode.jsonc is
#   extracted and probed; direct only when ALL pass, otherwise the session runs
#   on the proxy chain (order/timeout updated 2026-10-22), which is transparent
#   for all providers. All three endpoints measured direct-reachable 2026-10-15
#   (401/404/404 in ~0.13s), so the healthy path is unchanged. Probe timeout was
#   6s/endpoint at the time; see the 2026-10-22 entry.
#
#   2026-10-15 DeepSeek-only follow-up — the seat's config collapsed to one
#   provider (deepseek), so the dynamic extraction now yields exactly one
#   endpoint and the hardcoded fallback list was reduced to it (ADR 0010).
#
#   2026-10-22 startup-latency — three fixes for slow `opencode` launches:
#   (a) direct probe 6 s -> 2 s connect / 5 s total; (b) probe 17878 before
#   18880 and remove `systemctl restart causeway.service && sleep 3` from the
#   launch path (18880 is permanently down here, so every direct failure paid
#   3 s+; `proxy-on` owns gateway recovery); (c) a child TUI runs without
#   OPENCODE_SESSION_ID/OPENCODE_SESSION_TOKEN, because a TUI launched from an
#   opencode-spawned shell inherited the session-scoped token, the service
#   rejected /api/event with "Session access token cannot use this route", and
#   the TUI sat in "Restarting service…" retrying every second. The parent
#   shell keeps its token; only the child is cleaned.
#
# INSTALL (machine B):
#   Option A (install.sh does this by default):
#     append to ~/.bashrc, inside the interactive-only guard:
#       if [[ $- == *i* ]]; then source /absolute/path/to/this/file; fi
#   Option B (manual): copy the functions below into ~/.bashrc.
#   Verify with: type opencode   (must show the wrapper function)
#
# DEPENDENCIES: bash (interactive), curl (egress probes), python3 (_oc_tty_flush_input).
# DEGRADATION ON A BOX WITHOUT causeway: if the probes fail and the
# 18880/17878 ports are dead, the wrapper runs `command opencode "$@"` directly
# — correct behavior on a machine with healthy direct egress.
#
# >>> machine-A .bashrc verbatim extraction >>>
export CAUSEWAY_GFW_PROXY="http://127.0.0.1:18880"

# opencode(deepseek) 出口自愈（2026-08-30 起；2026-10-15 收敛到唯一 provider）：2026-08-30 的故障
# 发生在当时的阿里北京段端点（39.106.x/39.108.x）——直连路径被 RST/黑洞，traceroute 断在骨干、
# 同 IP 任意 SNI 皆 RST，定性运营商侧故障（非本机非配置）；18880 实测可达（未带 key 返 401 =
# TLS/HTTP 全通）。策略 = 直连优先预检（剥 proxy env 测真直连），失败才挂 17878/18880，直连恢复自动回落。
_egress_direct_ok() {  # $1=endpoint；curl 拿到任意 HTTP 响应（含 401）= 通；RST/超时 = 断
    # 2026-10-22 startup-latency: a blocked direct path used to burn the full
    # 6 s timeout before the proxy fallback even started. 2 s connect fails a
    # blackhole fast; 5 s total leaves room for a reachable-but-slow cross-
    # border TLS handshake, so a false negative does not force --standalone.
    # The healthy path is still ~0.13 s.
    env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
        timeout 6 curl -sS --connect-timeout 2 --max-time 5 -o /dev/null \
        -X POST -d '{}' -H 'content-type: application/json' "$1" 2>/dev/null
}
_egress_local_proxy() {  # $1=url；本机监听该端口则回显 url，否则返回 1
    # Probe exactly the host/port that will be exported. The old code probed
    # 17878 but exported _proxy_gw_http, so a changed gateway URL could be
    # exported without ever being probed.
    local url="$1" hp host port
    [[ -n "$url" ]] || return 1
    hp="${url#http://}"; hp="${hp#https://}"
    hp="${hp%%/*}"; hp="${hp##*@}"
    if [[ "$hp" == *:* ]]; then host="${hp%:*}"; port="${hp##*:}"; else host="$hp"; port=80; fi
    [[ "$host" == "127.0.0.1" || "$host" == "localhost" ]] || return 1
    [[ "$port" =~ ^[0-9]+$ ]] || return 1
    timeout 1 bash -c ':</dev/tcp/127.0.0.1/$1' _ "$port" 2>/dev/null || return 1
    printf '%s\n' "$url"
}

_egress_proxy_or_bail() {  # $1=调用方名；探测 17878 → 18880，均无响应则返回 1
    # 2026-10-22 startup-latency: do NOT restart causeway on the launch path.
    # The old code ran `systemctl --user restart causeway.service && sleep 3`
    # whenever 18880 was down, and 18880 is permanently down on this host while
    # 17878 is the live dev gateway. That added 3 s+ to every launch whose
    # direct probe failed, on top of the 6 s probe. Selecting a working proxy is
    # the launcher's job; recovering the gateway is `proxy-on`'s job.
    # 17878 first: it is .bashrc's _proxy_gw_http and the live dev gateway.
    [[ -f "$HOME/.local/share/causeway/PROXY_OFF" ]] && { echo "$1: 代理总开关=OFF，直连又断，原样启动自求多福" >&2; return 1; }
    local p
    if p="$(_egress_local_proxy "${_proxy_gw_http:-http://127.0.0.1:17878}")"; then
        EGRESS_PROXY="$p"
        return 0
    fi
    if p="$(_egress_local_proxy "${CAUSEWAY_GFW_PROXY:-http://127.0.0.1:18880}")"; then
        EGRESS_PROXY="$p"
        return 0
    fi
    echo "$1: 17878/18880 均无响应；不自动重启 causeway，原样启动（可运行 proxy-on 或手动 systemctl --user restart causeway.service）" >&2
    return 1
}
_via_proxy() {  # $1=--tui 可选；$2=命令；其余为参数；走 $EGRESS_PROXY
    local tui=0
    if [[ "$1" == --tui ]]; then tui=1; shift; fi
    local cmd="$1"; shift
    # _oc_run owns the TUI token strip. Prefix assignments put the proxy env
    # into its environment without leaking it to the parent shell.
    if [[ $tui -eq 1 ]]; then
        http_proxy="$EGRESS_PROXY" https_proxy="$EGRESS_PROXY" \
        HTTP_PROXY="$EGRESS_PROXY" HTTPS_PROXY="$EGRESS_PROXY" \
        no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
        _oc_run --tui "$cmd" "$@"
    else
        http_proxy="$EGRESS_PROXY" https_proxy="$EGRESS_PROXY" \
        HTTP_PROXY="$EGRESS_PROXY" HTTPS_PROXY="$EGRESS_PROXY" \
        no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
        _oc_run "$cmd" "$@"
    fi
}
_oc_run() {  # $1=--tui 可选；$2=命令；其余为参数
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
    # 兜底恢复终端状态（2026-09-18）：TUI 被硬杀（kill -9/冻结后强杀/崩溃）时来不及关
    # 鼠标追踪（?1000/?1002/?1003/?1006），shell 里点击/滚动会打出 35;112;35M 之类 SGR
    # 上报。正常 /exit、SIGTERM 路径 opencode 自己会全量清理，序列幂等无害；
    # 仅当 stdout 是终端时发送，避免污染 opencode run 的管道输出。
    # 严禁在这里发 ?1049l：VTE 和 tmux 收到 1049l 都会无条件把光标恢复到上次 ?1049h
    # 的存档位——在主屏上多发一次 = 光标跳回旧行，提示符画到上方、屏幕行序错乱
    # （2026-09-18 实测两家终端皆如此）。VTE 在子进程死亡时本就自动退备用屏；
    # tmux 里硬杀后备用屏卡住的罕见场景用 reset 手动恢复。
    [[ -t 1 ]] || return 0
    printf '\e[?1003l\e[?1002l\e[?1000l\e[?1006l\e[?2004l\e[?2031l\e[>4;0m\e[0 q\e[?25h'
    return 0
}
_oc_tty_flush_input() {
    # 清空 pty 输入队列（2026-09-18）：即使 /exit 干净退出，退出窗口内（opencode 已停读
    # stdin、终端尚未应用 mouse-disable）产生的鼠标上报会残留在队列里，被 bash readline
    # 回显成 35;54;13M 之类并混进下一条命令。tcflush 丢弃之。毫秒级在途上报仍可能漏网。
    [[ -t 1 ]] && python3 -c 'import termios,os;fd=os.open("/dev/tty",os.O_RDWR|os.O_NOCTTY);termios.tcflush(fd,termios.TCIFLUSH);os.close(fd)' 2>/dev/null
    return 0
}
opencode() {
    # 2026-10-15 V3：探针集=动态抽取 opencode.jsonc 全部 provider baseURL，
    # AND 门禁——全部直连通才直连；任一不通则整会话挂代理（17878→18880）。
    # 旧 OR 门禁（任一通即直连）在会话内切换 provider 时会静默卡死：探针通的
    # 不等于本次要用的（写下这条时 seat 还在 deepseek↔mimo 间运行时切换；给 OR
    # 补端点只是安慰剂，只有 AND 能保证"直连绿灯 = 用哪个 provider 都不卡"）。
    # 2026-10-15 起 seat 只剩 deepseek 一个 provider，AND 门禁保留为不变量：
    # 将来若再加 provider，它自动覆盖，这里无需改动。
    #
    # 2026-10-22 startup-latency: a TUI launched from an opencode-spawned shell
    # inherits OPENCODE_SESSION_ID/OPENCODE_SESSION_TOKEN. The service treats
    # that as a session-scoped credential and rejects /api/event with
    # "Session access token cannot use this route"; the TUI then retries
    # "Restarting service…" every second. A new TUI is an operator client, so
    # the child runs without those two variables (the parent shell keeps them).
    local eps ep rc tui=0
    local -a bad=()
    _oc_is_tui "$@" && tui=1
    _oc_tty_reset   # 启动前先清一遍：本终端可能残留着上一个硬死实例泄漏的鼠标模式
    eps="$(grep -o '"baseURL"[[:space:]]*:[[:space:]]*"https\{0,1\}://[^"]*"' \
        "$HOME/.config/opencode/opencode.jsonc" 2>/dev/null \
        | sed 's/.*"\(https\{0,1\}:\/\/[^"]*\)".*/\1/' | sort -u)"
    # Fallback only when the config declares no baseURL at all: the seat is
    # DeepSeek-only (ADR 0010), so this list has exactly one endpoint.
    [[ -n "$eps" ]] || eps="https://api.deepseek.com"
    while IFS= read -r ep; do
        [[ -z "$ep" ]] && continue
        _egress_direct_ok "$ep" || bad+=("$ep")
    done <<< "$eps"
    if [[ ${#bad[@]} -eq 0 ]]; then
        if [[ $tui -eq 1 ]]; then _oc_run --tui opencode "$@"; else _oc_run opencode "$@"; fi
    elif _egress_proxy_or_bail opencode; then
        echo "opencode: 端点直连不可达（${bad[*]}），本次会话走 $EGRESS_PROXY" >&2
        # V2 后台服务沿用“拉起它的客户端”的环境，代理变量传不进已在运行的服务；
        # TUI 启动（无子命令）改用 --standalone，让私有服务器继承本次的代理环境。
        if [[ $tui -eq 1 ]]; then
            _via_proxy --tui opencode --standalone "$@"
        else
            _via_proxy opencode "$@"
        fi
    else
        if [[ $tui -eq 1 ]]; then _oc_run --tui opencode "$@"; else _oc_run opencode "$@"; fi
    fi
    rc=$?
    _oc_tty_reset        # 退出后兜底：本次若是硬死（kill -9/崩溃），由 wrapper 关模式
    _oc_tty_flush_input  # 再丢弃退出瞬间残留在输入队列的鼠标上报
    return $rc
}
# <<< machine-A .bashrc verbatim extraction <<<
