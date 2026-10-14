#!/usr/bin/env bash
# 主机资源采集：只用 /proc、df 与 nvidia-smi（远端实测没有 psutil，也没有 tmux）。
# 输出 KEY=value。GPU 数值是机器真实占用，不等于本项目的预约。
set -u

uptime_s() { awk '{print $1}' /proc/uptime; }
snap() { awk '/^cpu /{idle=$5+$6; tot=0; for(i=2;i<=NF;i++) tot+=$i; printf "%.0f %.0f\n", tot, idle}' /proc/stat; }
T0=$(uptime_s); A=$(snap); sleep 0.5; T1=$(uptime_s); B=$(snap)
# 窗口过短或快照异常时输出空值：宁可显示「无数据」，不输出算出来的假百分比。
CPU=$(awk -v a="$A" -v b="$B" -v t0="$T0" -v t1="$T1" 'BEGIN{
  if (a=="" || b=="") { print ""; exit }
  split(a,x," "); split(b,y," ");
  dt=y[1]-x[1]; di=y[2]-x[2]; win=t1-t0;
  if (dt<=0 || di<0 || win<0.2) { print ""; exit }
  printf "%.1f", 100*(dt-di)/dt
}')

MEM_TOTAL=0; MEM_AVAIL=0
while read -r k v _; do
  case "$k" in
    MemTotal:) MEM_TOTAL=$((v / 1024)) ;;
    MemAvailable:) MEM_AVAIL=$((v / 1024)) ;;
  esac
done < /proc/meminfo
MEM_USED=$((MEM_TOTAL > 0 ? MEM_TOTAL - MEM_AVAIL : 0))

DF=$(df -Pk /home 2>/dev/null | tail -1)
DISK_TOTAL=$(( $(echo "$DF" | awk '{print $2}') / 1048576 ))
DISK_USED=$(( $(echo "$DF" | awk '{print $3}') / 1048576 ))

# 本项目相关的执行进程数（按 run 目录前缀统计，避免把他人任务算进来）。
RUNNING=$(pgrep -fc "bash .*/pi-launch.sh" 2>/dev/null); RUNNING=${RUNNING:-0}

echo "TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CPU=$CPU"
echo "MEM_USED_MB=$MEM_USED"
echo "MEM_TOTAL_MB=$MEM_TOTAL"
echo "DISK_USED_GB=$DISK_USED"
echo "DISK_TOTAL_GB=$DISK_TOTAL"
echo "RUNNING=$RUNNING"

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null |
    while IFS=, read -r idx util mu mt; do
      idx=$(echo "$idx" | tr -d ' '); util=$(echo "$util" | tr -d ' ')
      mu=$(echo "$mu" | tr -d ' '); mt=$(echo "$mt" | tr -d ' ')
      echo "GPU=$idx,$util,$mu,$mt"
    done
fi
