#!/bin/bash
# Root-side GDB key extraction watcher. Waits for the real WeChat process,
# attaches once, captures the SQLCipher key, then detaches.
set +e

LOG=/tmp/gdb_extract.log
for _i in $(seq 1 3600); do
  if [ -s /tmp/wechat.pid ]; then
    break
  fi
  sleep 1
done

if [ ! -s /tmp/wechat.pid ]; then
  echo "[gdb-watch] timeout: /tmp/wechat.pid not found" | tee -a "$LOG"
  exit 1
fi

PID="$(cat /tmp/wechat.pid)"
echo "[gdb-watch] WeChat pid=$PID, attaching in 5s" | tee -a "$LOG"
sleep 5

# Root with CAP_SYS_PTRACE can attach even when yama ptrace_scope is 1.
gdb -batch -nx -p "$PID" -x /usr/local/bin/extract_key.py >>"$LOG" 2>&1
RC=$?
echo "[gdb-watch] gdb exit=$RC" | tee -a "$LOG"

if [ -s /tmp/wechat_key.txt ]; then
  install -m 600 -o wechat -g wechat /tmp/wechat_key.txt /run/mimicwx/key/wechat_key.txt
  echo "[gdb-watch] key captured and persisted (redacted)" | tee -a "$LOG"
else
  echo "[gdb-watch] no key captured; see $LOG" | tee -a "$LOG"
fi
