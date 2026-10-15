#!/usr/bin/env bash
# bashrc-opencode-block.sh — opencode() egress/TTY wrapper block for ~/.bashrc
#
# Verbatim extraction from machine A's ~/.bashrc (seat snapshot 2026-09-29).
# Provenance (machine A line numbers):
#   111        export CAUSEWAY_GFW_PROXY
#   210-213    egress self-heal strategy comment
#   214-240    _egress_direct_ok / _egress_18880_or_bail / _via_proxy
#   252-290    _oc_tty_reset / _oc_tty_flush_input / opencode()
# Everything below the marker line is UNMODIFIED machine-A .bashrc text
# (including its original Chinese comments). Do not edit it in place —
# re-extract instead so diffs stay meaningful.
#
# WHAT IT DOES (load-bearing, do not skip):
#   1. Mouse-garbage TTY fix: opencode's TUI enables xterm mouse tracking
#      (?1000/?1002/?1003/?1006). A hard death (kill -9 / crash) skips the
#      cleanup, and the shell then echoes click/scroll SGR reports (e.g.
#      "35;112;35M") as input. _oc_tty_reset disables the modes on entry and
#      exit; _oc_tty_flush_input discards the residual pty input queue.
#      (NEVER send ?1049l in there — see original comment in the block.)
#   2. Egress self-heal: probe real direct egress for EVERY provider baseURL in
#      opencode.jsonc (proxy vars stripped); direct only when all pass. Any
#      unreachable endpoint sends the session to the local causeway proxy chain
#      (18880 -> 17878) — switch-safe: no runtime model change can hit a
#      blocked endpoint unnoticed. Direct recovery automatically falls back to
#      direct on the next launch.
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
#   launches (see 3 above). _oc_tty_reset/_oc_tty_flush_input and the
#   18880 -> 17878 chain are unchanged.
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
#   on the 18880 -> 17878 chain, which is transparent for all providers. All
#   three endpoints measured direct-reachable 2026-10-15 (401/404/404 in
#   ~0.13s), so the healthy path is unchanged. Probe timeout stays 6s/endpoint.
#
#   2026-10-15 DeepSeek-only follow-up — the seat's config collapsed to one
#   provider (deepseek), so the dynamic extraction now yields exactly one
#   endpoint and the hardcoded fallback list was reduced to it (ADR 0010).
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
# TLS/HTTP 全通）。策略 = 直连优先预检（剥 proxy env 测真直连），失败才挂 18880，直连恢复自动回落。
_egress_direct_ok() {  # $1=endpoint；curl 拿到任意 HTTP 响应（含 401）= 通；RST/超时 = 断
    env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
        timeout 6 curl -sS -o /dev/null -X POST -d '{}' -H 'content-type: application/json' "$1" 2>/dev/null
}
_egress_18880_or_bail() {  # $1=调用方名；fallback 链（2026-08-31 eric 裁示）：18880 → 17878（现同为 causeway 两类）
    # 出口变量 EGRESS_PROXY 供 _via_proxy 使用；有可用代理 return 0，全灭 return 1
    [[ -f "$HOME/.local/share/causeway/PROXY_OFF" ]] && { echo "$1: 代理总开关=OFF，直连又断，原样启动自求多福" >&2; return 1; }
    EGRESS_PROXY="$CAUSEWAY_GFW_PROXY"
    if ! timeout 2 bash -c ':</dev/tcp/127.0.0.1/18880' 2>/dev/null; then
        echo "$1: 18880 无响应，重启 causeway..." >&2
        systemctl --user restart causeway.service && sleep 3
        timeout 2 bash -c ':</dev/tcp/127.0.0.1/18880' 2>/dev/null || {
            if timeout 2 bash -c ':</dev/tcp/127.0.0.1/17878' 2>/dev/null; then
                EGRESS_PROXY="http://127.0.0.1:17878"
                echo "$1: 18880 仍死，fallback → causeway 17878" >&2
            else
                echo "$1: 两级代理全灭，原样启动" >&2; return 1
            fi }
    fi
}
_via_proxy() {  # $1=要 exec 的命令名，shift 后接参数；走 $EGRESS_PROXY
    local cmd="$1"; shift
    http_proxy="$EGRESS_PROXY" https_proxy="$EGRESS_PROXY" \
    HTTP_PROXY="$EGRESS_PROXY" HTTPS_PROXY="$EGRESS_PROXY" \
    no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1" \
    command "$cmd" "$@"
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
    # AND 门禁——全部直连通才直连；任一不通则整会话挂代理（18880→17878）。
    # 旧 OR 门禁（任一通即直连）在会话内切换 provider 时会静默卡死：探针通的
    # 不等于本次要用的（写下这条时 seat 还在 deepseek↔mimo 间运行时切换；给 OR
    # 补端点只是安慰剂，只有 AND 能保证"直连绿灯 = 用哪个 provider 都不卡"）。
    # 2026-10-15 起 seat 只剩 deepseek 一个 provider，AND 门禁保留为不变量：
    # 将来若再加 provider，它自动覆盖，这里无需改动。
    local eps ep rc
    local -a bad=()
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
        command opencode "$@"
    elif _egress_18880_or_bail opencode; then
        echo "opencode: 端点直连不可达（${bad[*]}），本次会话走 $EGRESS_PROXY" >&2
        # V2 后台服务沿用“拉起它的客户端”的环境，代理变量传不进已在运行的服务；
        # TUI 启动（无子命令）改用 --standalone，让私有服务器继承本次的代理环境。
        if [[ $# -eq 0 || "$1" == -* || -d "$1" ]]; then
            _via_proxy opencode --standalone "$@"
        else
            _via_proxy opencode "$@"
        fi
    else
        command opencode "$@"
    fi
    rc=$?
    _oc_tty_reset        # 退出后兜底：本次若是硬死（kill -9/崩溃），由 wrapper 关模式
    _oc_tty_flush_input  # 再丢弃退出瞬间残留在输入队列的鼠标上报
    return $rc
}
# <<< machine-A .bashrc verbatim extraction <<<
