#!/usr/bin/env bash
# BRI Runner 的远端执行包装：上传一次，按 run 目录调用。
#
# 存在理由（docs/architecture-v1.md §6、docs/stage0-pi-events.md §3）：
# wrapper 的 stdout 只有在有人持续读取时才可用；SSH 断开后管道写满会阻塞 Pi。
# 因此这里把 stdout/stderr 重定向到 run 目录下的普通文件，Controller 之后按字节偏移续读。
# prompt 从文件读取并整体作为单个参数传入，不通过 shell 字符串拼接。
set -u

RUN_DIR="$1"
. "$RUN_DIR/run.conf"
# setsid 后本进程即组长；应答丢失时 Controller 按此文件核对，不盲目重跑。
printf '%s\n' "$$" > "$RUN_DIR/pgid"

mkfifo "$RUN_DIR/ctl" 2>/dev/null || true
# 持有 ctl 管道的写端，避免 wrapper 的 stdin 立即 EOF；运行期间可追加 get_state/steer/abort。
sleep 86400 > "$RUN_DIR/ctl" &
KEEPER=$!

set -- --prompt "$(cat "$RUN_DIR/prompt.txt")" --cwd "$WORKDIR" --raw --timeout-ms "$TIMEOUT_MS"
[ -n "${PI_TOOLS:-}" ] && set -- "$@" --tools "$PI_TOOLS"
[ -n "${PI_MODEL:-}" ] && set -- "$@" --model "$PI_MODEL"
# 推理档位显式传递，不默默依赖远端全局设置；旧 run.conf 无此键时保持不下发。
[ -n "${PI_THINKING:-}" ] && set -- "$@" --thinking "$PI_THINKING"
[ -n "${PI_NAME:-}" ] && set -- "$@" --name "$PI_NAME"

"$NODE_BIN" "$WRAPPER" run "$@" < "$RUN_DIR/ctl" > "$RUN_DIR/out" 2> "$RUN_DIR/err"
CODE=$?

kill "$KEEPER" 2>/dev/null
rm -f "$RUN_DIR/ctl"
echo "EXIT=$CODE" >> "$RUN_DIR/meta"
exit "$CODE"
