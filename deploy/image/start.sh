#!/bin/bash
# Container entrypoint: independent Openbox desktop + real WeChat 4.1.13.26 +
# MimicWX REST bridge. All host-published ports are loopback-only in compose.
set +e

export LANG=zh_CN.UTF-8
export LANGUAGE=zh_CN:zh
export LC_ALL=zh_CN.UTF-8
export TZ=Asia/Shanghai

log() { echo "[start.sh] $*"; }

# ---------------------------------------------------------------------------
# 0) Root-side system setup
# ---------------------------------------------------------------------------
mkdir -p /run/dbus /tmp/.X11-unix /var/log/mimicwx /run/mimicwx/key
chmod 1777 /tmp/.X11-unix
dbus-daemon --system --fork 2>/dev/null || true

# Best-effort only. In this Docker environment /proc/sys is read-only; root
# has CAP_SYS_PTRACE, which bypasses yama restrictions.
echo 0 > /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || true

mkdir -p /home/wechat/.xwechat /home/wechat/Documents /home/wechat/.config \
         /home/wechat/.local /home/wechat/.vnc
chown -R wechat:wechat /home/wechat/.xwechat /home/wechat/Documents \
        /home/wechat/.config /home/wechat/.local /home/wechat/.vnc 2>/dev/null || true

# VNC password: supplied as a bind-mounted file, never baked into the image.
if [ -s /run/mimicwx/vnc-password ]; then
  install -m 600 -o wechat -g wechat /run/mimicwx/vnc-password /home/wechat/.vnc/passwd.plain
  su - wechat -c 'vncpasswd -f < ~/.vnc/passwd.plain > ~/.vnc/passwd; chmod 600 ~/.vnc/passwd; rm -f ~/.vnc/passwd.plain'
else
  log "WARNING: no VNC password file; refusing weak default, disabling VNC password"
  : > /home/wechat/.vnc/passwd
  chown wechat:wechat /home/wechat/.vnc/passwd
fi

cat > /home/wechat/.vnc/xstartup <<'XSTART'
#!/bin/bash
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XKL_XMODMAP_DISABLE=1
exec openbox-session
XSTART
chmod 755 /home/wechat/.vnc/xstartup
chown wechat:wechat /home/wechat/.vnc/xstartup

# Reuse a previously extracted key if present; the key is account/DB specific.
if [ -s /run/mimicwx/key/wechat_key.txt ]; then
  install -m 600 -o wechat -g wechat /run/mimicwx/key/wechat_key.txt /tmp/wechat_key.txt
  log "restored persisted DB key"
fi

# Root-side GDB watcher; only needed when no key was restored.
if [ ! -s /tmp/wechat_key.txt ]; then
  /usr/local/bin/gdb-watch.sh >/tmp/gdb-watch.out 2>&1 &
fi

# ---------------------------------------------------------------------------
# 1) Desktop session (wechat user)
# ---------------------------------------------------------------------------
su - wechat <<'USEREOF'
  set +e
  log() { echo "[desktop] $*"; }
  export LANG=zh_CN.UTF-8
  export LANGUAGE=zh_CN:zh
  export LC_ALL=zh_CN.UTF-8

  eval $(dbus-launch --sh-syntax)
  export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
  export QT_ACCESSIBILITY=1

  log "starting VNC/Openbox on :1"
  vncserver -kill :1 >/dev/null 2>&1 || true
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
  vncserver :1 -geometry 1440x900 -depth 24 -localhost no -SecurityTypes VncAuth
  VNC_RC=$?
  if [ "$VNC_RC" != "0" ]; then
    log "VNC first start failed rc=$VNC_RC; retrying"
    vncserver -kill :1 >/dev/null 2>&1 || true
    rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
    sleep 2
    vncserver :1 -geometry 1440x900 -depth 24 -localhost no -SecurityTypes VncAuth
  fi
  export DISPLAY=:1
  sleep 3

  if [ -S /tmp/.X11-unix/X1 ]; then
    log "VNC/Openbox is up on :1"
  else
    log "ERROR: X display :1 did not appear"
  fi

  xset s off 2>/dev/null || true
  xset -dpms 2>/dev/null || true
  xset s noblank 2>/dev/null || true

  # One AT-SPI bus for this desktop; Qt accessibility is enabled above.
  for _r in 1 2 3; do
    pkill -9 -f at-spi-bus-launcher 2>/dev/null || true
    pkill -9 -f at-spi2-registryd 2>/dev/null || true
    sleep 0.5
  done
  rm -f ~/.cache/at-spi/bus_1 ~/.cache/at-spi/bus 2>/dev/null || true
  sleep 1
  nohup /usr/libexec/at-spi-bus-launcher >/tmp/at-spi.log 2>&1 &
  sleep 2
  A11Y_ADDR=$(dbus-send --session --dest=org.a11y.Bus --print-reply \
    /org/a11y/bus org.a11y.Bus.GetAddress 2>/dev/null \
    | grep string | sed 's/.*"\(.*\)"/\1/')
  if [ -n "$A11Y_ADDR" ]; then
    export AT_SPI_BUS_ADDRESS="$A11Y_ADDR"
    log "AT-SPI bus: $A11Y_ADDR"
  else
    log "WARNING: AT-SPI bus address not found"
  fi

  cat > ~/.dbus_env <<ENVEOF
export DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
export DISPLAY=$DISPLAY
export LANG=zh_CN.UTF-8
export LANGUAGE=zh_CN:zh
export LC_ALL=zh_CN.UTF-8
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export QT_ACCESSIBILITY=1
ENVEOF
  [ -n "$A11Y_ADDR" ] && echo "export AT_SPI_BUS_ADDRESS=$AT_SPI_BUS_ADDRESS" >> ~/.dbus_env

  log "starting official WeChat Linux (4.1.13.26)"
  nohup wechat --no-sandbox --disable-gpu --disable-audio-output >/tmp/wechat_stdout.log 2>&1 &
  WECHAT_PID=$!
  echo "$WECHAT_PID" >/tmp/wechat.pid
  log "wechat pid=$WECHAT_PID"

  for _wait in $(seq 1 60); do
    if pgrep -x wechat >/dev/null 2>&1 && xprop -root _NET_CLIENT_LIST 2>/dev/null | grep -q '0x'; then
      log "WeChat window is ready (${_wait}s)"
      break
    fi
    sleep 1
  done
  if kill -0 "$WECHAT_PID" 2>/dev/null; then
    log "WeChat process alive"
  else
    log "ERROR: WeChat process exited; see /tmp/wechat_stdout.log"
    tail -30 /tmp/wechat_stdout.log 2>/dev/null || true
  fi

  log "starting noVNC on :6080 -> localhost:5901"
  nohup websockify --web /usr/share/novnc 6080 localhost:5901 >/tmp/novnc.log 2>&1 &
USEREOF

log "desktop session prepared; starting MimicWX bridge"

# ---------------------------------------------------------------------------
# 2) MimicWX bridge loop. Exit code 42 = /restart, otherwise stop container.
# ---------------------------------------------------------------------------
while true; do
  su - wechat -c '
    source ~/.dbus_env 2>/dev/null
    export RUST_LOG=mimicwx=info,tower_http=info
    exec /usr/local/bin/mimicwx
  ' 2>&1 | tee -a /var/log/mimicwx/mimicwx.log
  CODE=${PIPESTATUS[0]}
  if [ "$CODE" = "42" ]; then
    log "MimicWX requested restart (3s)"
    sleep 3
    continue
  fi
  log "MimicWX exited code=$CODE; container stopping"
  break
done

log "container exiting"
