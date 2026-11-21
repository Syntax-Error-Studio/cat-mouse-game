#!/usr/bin/env bash
# PPC-G6T2-SELECTION-CAUSE-01 — cloud guard for ONE job (serial by construction).
#
# Usage: run_03.sh PHASE TESTFILE [EXTRA_ENV]
#   EXTRA_ENV is optional and limited to PPC_INSTR_REP=<n>.
# Writes: /opt/ppc-bench/runs/03/<phase>.{stdout.log,samples.csv,result.txt,
#         precheck.txt,admission.txt}
#
# Admission (task book §G0): MemAvailable >= 2.5 GiB for 5 CONSECUTIVE samples,
# SwapFree >= 1 GiB, no new swap-out / OOM kill, protected services 8787/8788
# active with unchanged MainPID, no deployment in progress, no other heavy
# task, no duplicate benchmark. Any failure stops before launch.
set -u
PHASE=$1
TESTFILE=$2
EXTRA_ENV=${3:-}
REPO=/opt/ppc-bench/repo
RUNDIR=/opt/ppc-bench/runs/03
mkdir -p "$RUNDIR"
export PATH=/home/ubuntu/.nvm/versions/node/v24.19.0/bin:$PATH
cd "$REPO" || exit 90

LOG=$RUNDIR/$PHASE.stdout.log
SAMP=$RUNDIR/$PHASE.samples.csv
RES=$RUNDIR/$PHASE.result.txt
PRE=$RUNDIR/$PHASE.precheck.txt
ADM=$RUNDIR/$PHASE.admission.txt

meminfo() { awk -v k="$1" '$1==k":"{print $2}' /proc/meminfo; }
vmstat_k() { awk -v k="$1" '$1==k{print $2}' /proc/vmstat; }
svc_pid() { systemctl show -p MainPID --value "$1" 2>/dev/null; }
sumtree() {
  local p=$1 t c
  t=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ')
  [ -z "$t" ] && t=0
  for c in $(pgrep -P "$p" 2>/dev/null); do t=$((t+$(sumtree "$c"))); done
  echo "$t"
}

# ---------------- admission: 5 consecutive MemAvailable samples >= 2.5GiB --
echo "ts,memavail_kb,swapfree_kb" > "$ADM"
CONSEC=0; BEST=0; TRIES=0
while [ "$CONSEC" -lt 5 ] && [ "$TRIES" -lt 120 ]; do
  TRIES=$((TRIES+1))
  MA=$(meminfo MemAvailable); SF=$(meminfo SwapFree)
  echo "$(date +%s),$MA,$SF" >> "$ADM"
  if [ "$MA" -ge 2621440 ]; then CONSEC=$((CONSEC+1)); else CONSEC=0; fi
  [ "$CONSEC" -gt "$BEST" ] && BEST=$CONSEC
  [ "$CONSEC" -lt 5 ] && sleep 1
done
if [ "$CONSEC" -lt 5 ]; then
  {
    echo "PHASE=$PHASE"
    echo "TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "ADMISSION=FAIL_NO_FIVE_CONSECUTIVE_2.5GIB_SAMPLES"
    echo "TRIES=$TRIES BEST_CONSECUTIVE=$BEST"
  } > "$PRE"
  echo "ADMISSION FAILED: no 5 consecutive MemAvailable >= 2.5GiB samples (best=$BEST of $TRIES)"
  exit 91
fi

MA_PRE=$(meminfo MemAvailable); MF_PRE=$(meminfo MemFree); SF_PRE=$(meminfo SwapFree)
PO_PRE=$(vmstat_k pswpout); PI_PRE=$(vmstat_k pswpin); OK_PRE=$(vmstat_k oom_kill)
DISK_KB=$(df -Pk /opt | awk 'NR==2{print $4}')
HEAVY=$(ps -eo pid,args | grep -E 'vitest|\.test\.ts' | grep -v grep | grep -v run_03.sh | wc -l)
DEPLOY=$(ps -eo pid,args | grep -E 'deploy|git pull|npm (ci|install)|systemctl restart' | grep -v grep | grep -v run_03.sh | wc -l)
DUP=0; [ -f "$RES" ] && DUP=1
P8787=$(svc_pid catmouse-web); P8788=$(svc_pid catmouse-research)
A8787=$(systemctl is-active catmouse-web 2>/dev/null); A8788=$(systemctl is-active catmouse-research 2>/dev/null)

FAIL=""
[ "$MA_PRE" -lt 2621440 ] && FAIL="$FAIL MEMAVAILABLE_BELOW_2.5GIB"
[ "$SF_PRE" -lt 1048576 ] && FAIL="$FAIL SWAPFREE_BELOW_1GIB"
[ "$DISK_KB" -lt 2097152 ] && FAIL="$FAIL DISK_BELOW_2GIB"
[ "$HEAVY" -ne 0 ] && FAIL="$FAIL OTHER_HEAVY_PROCESS_RUNNING"
[ "$DEPLOY" -ne 0 ] && FAIL="$FAIL DEPLOYMENT_IN_PROGRESS"
[ "$DUP" -ne 0 ] && FAIL="$FAIL DUPLICATE_PHASE_ALREADY_RAN"
[ "$A8787" != "active" ] && FAIL="$FAIL CATMOUSE_WEB_NOT_ACTIVE"
[ "$A8788" != "active" ] && FAIL="$FAIL CATMOUSE_RESEARCH_NOT_ACTIVE"
{
  echo "PHASE=$PHASE"
  echo "TESTFILE=$TESTFILE"
  echo "EXTRA_ENV=$EXTRA_ENV"
  echo "TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "ADMISSION_SAMPLES=5_CONSECUTIVE_OK"
  echo "MEMAVAILABLE_KB=$MA_PRE MEMFREE_KB=$MF_PRE SWAPFREE_KB=$SF_PRE"
  echo "PSWPOUT=$PO_PRE PSWPIN=$PI_PRE OOM_KILL=$OK_PRE"
  echo "DISK_FREE_KB=$DISK_KB HEAVY_PROCS=$HEAVY DEPLOY_PROCS=$DEPLOY DUPLICATE=$DUP"
  echo "PID_8787=$P8787 ACTIVE_8787=$A8787 PID_8788=$P8788 ACTIVE_8788=$A8788"
  echo "PRECHECK=$([ -z "$FAIL" ] && echo PASS || echo "FAIL:$FAIL")"
} > "$PRE"
if [ -n "$FAIL" ]; then echo "PRECHECK FAILED:$FAIL"; exit 91; fi

# ---------------- launch + monitor ----------------
echo "ts,memavail_kb,memfree_kb,swapfree_kb,pswpout,pswpin,oom_kill,load1,job_rss_kb,pid_8787,pid_8788" > "$SAMP"
t0=$(date +%s%3N)
env $EXTRA_ENV nice -n 19 taskset -c 3 ./node_modules/.bin/vitest run --config PPC-G6T2-SELECTION-CAUSE-01/probe/vitest.config.mts "$TESTFILE" > "$LOG" 2>&1 &
job=$!
LOW=0; ABORT=""
while kill -0 "$job" 2>/dev/null; do
  MA=$(meminfo MemAvailable); MF=$(meminfo MemFree); SF=$(meminfo SwapFree)
  PO=$(vmstat_k pswpout); PI=$(vmstat_k pswpin); OK=$(vmstat_k oom_kill)
  L1=$(awk '{print $1}' /proc/loadavg)
  R=$(sumtree "$job")
  C8787=$(svc_pid catmouse-web); C8788=$(svc_pid catmouse-research)
  echo "$(date +%s),$MA,$MF,$SF,$PO,$PI,$OK,$L1,$R,$C8787,$C8788" >> "$SAMP"
  if [ "$MA" -lt 1048576 ]; then LOW=$((LOW+1)); else LOW=0; fi
  [ "$LOW" -ge 5 ] && ABORT="ABORT_MEMAVAILABLE_BELOW_1GIB_5_SAMPLES"
  [ "$PO" -gt "$PO_PRE" ] && ABORT="ABORT_NEW_SWAP_OUT"
  [ "$OK" -gt "$OK_PRE" ] && ABORT="ABORT_NEW_OOM_KILL"
  [ -n "$P8787" ] && [ "$C8787" != "$P8787" ] && ABORT="ABORT_PROTECTED_8787_PID_CHANGED"
  [ -n "$P8788" ] && [ "$C8788" != "$P8788" ] && ABORT="ABORT_PROTECTED_8788_PID_CHANGED"
  if [ -n "$ABORT" ]; then
    pkill -TERM -P "$job" 2>/dev/null
    kill -TERM "$job" 2>/dev/null
    sleep 3
    kill -KILL "$job" 2>/dev/null
    break
  fi
  sleep 1
done
wait "$job"; rc=$?
t1=$(date +%s%3N)
{
  echo "PHASE=$PHASE"
  echo "RC=$rc"
  echo "ABORT=${ABORT:-NONE}"
  echo "WALL_MS=$((t1-t0))"
  echo "START_EPOCH_MS=$t0"
  echo "END_EPOCH_MS=$t1"
  echo "BASELINE_PSWPOUT=$PO_PRE BASELINE_OOM_KILL=$OK_PRE"
  awk -F, 'NR>1{if(min==""||$2<min)min=$2; if(mf==""||$3<mf)mf=$3; if(sf==""||$4<sf)sf=$4; if(po==""||$5>po)po=$5; if(ok==""||$7>ok)ok=$7; if(r==""||$9>r)r=$9; if(l==""||$8>l)l=$8; n++} END{printf "SAMPLES=%d MEMAVAIL_MIN_KB=%d MEMFREE_MIN_KB=%d SWAPFREE_MIN_KB=%d PSWPOUT_MAX=%d OOM_KILL_MAX=%d PEAK_JOB_TREE_RSS_KB=%d LOAD1_MAX=%s\n",n,min,mf,sf,po,ok,r,l}' "$SAMP"
} | tee -a "$RES"
cat "$RES" >> "$LOG"
[ -n "$ABORT" ] && exit 92
exit "$rc"