#!/bin/sh
# docker(1) for the cold sandbox: starts the engine on first use, then hands
# over to the real client. Installed as /usr/local/bin/docker, ahead of
# /usr/bin/docker on PATH, so a run's `docker …` needs no setup step.
#
# Why lazy: the image ships dockerd but nothing starts it — the container has
# no init; the SDK's server only runs the commands it is sent.
# Why setsid: every /exec runs under `timeout -k 10 … bash -c`, whose process
# group is reaped when the command returns. A daemon started with `nohup … &`
# dies with it; one in its own session survives to the next command.
set -u
REAL=/usr/bin/docker
LOG=/var/log/dockerd.log

daemon_ready() { "$REAL" info >/dev/null 2>&1; }

if [ ! -S /var/run/docker.sock ] || ! daemon_ready; then
  # Containers reach the network through the default bridge, which needs the
  # kernel to forward between it and the outside interface.
  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || echo 1 >/proc/sys/net/ipv4/ip_forward
  # Two concurrent first calls both start a daemon; the second exits on the
  # pid lock and both wait below for the one that won.
  setsid -f dockerd >"$LOG" 2>&1
  # The bridge and the socket take a few seconds on a fresh microVM. 40 s is
  # generous, and a broken engine is reported with its log instead of hanging.
  waited=0
  until daemon_ready; do
    waited=$((waited + 1))
    if [ "$waited" -ge 40 ]; then
      echo "docker: the engine did not come up within 40 s — see $LOG" >&2
      exit 1
    fi
    sleep 1
  done
fi

exec "$REAL" "$@"
