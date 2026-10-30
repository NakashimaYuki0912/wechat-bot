#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
IP="${1:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
cat <<MSG
Run this on your personal computer (keep it open while using the desktop):

  ssh -N -L 16080:127.0.0.1:16080 -L 18899:127.0.0.1:18899 -L 15901:127.0.0.1:15901 kirby@${IP}

Then open:
  http://127.0.0.1:16080/vnc.html

The VNC/noVNC password is in data/wechat/vnc-password on the server.
The desktop and container keep running after the SSH/browser closes.
MSG
