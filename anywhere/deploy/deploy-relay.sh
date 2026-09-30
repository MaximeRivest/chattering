#!/usr/bin/env bash
# Put the relay's code on the server: a commit that is on GitHub, never a
# working tree. Run from a Chattering checkout:
#
#   anywhere/deploy/deploy-relay.sh [REF]        (REF: default HEAD)
#   RELAY_HOST=ubuntu@relay anywhere/deploy/deploy-relay.sh v0.2.0
#
# The server keeps each release read-only under
# /opt/chattering-anywhere/releases/<commit>, and "current" points at the
# one running; the previous ones stay, so going back is one symlink.
set -euo pipefail
cd "$(dirname "$0")/../.."
HOST="${RELAY_HOST:-ubuntu@encrypted-link-relay}"
REF="${1:-HEAD}"
COMMIT=$(git rev-parse --verify "$REF^{commit}")
git fetch -q origin
if ! git branch -r --contains "$COMMIT" | grep -q .; then
  echo "commit ${COMMIT:0:12} is not on GitHub yet: push it first (the relay only runs published code)" >&2; exit 1
fi
echo "deploying ${COMMIT:0:12} ($(git log -1 --format=%s "$COMMIT" | cut -c1-70)) to $HOST"
# The relay's files only: anywhere/ and the WebSocket server it shares.
git archive --format=tar "$COMMIT" anywhere wsserver.js | gzip -9 | ssh "$HOST" "sudo bash -c '
  set -euo pipefail
  dir=/opt/chattering-anywhere/releases/$COMMIT
  if [ ! -d \$dir ]; then
    tmp=\$(mktemp -d /opt/chattering-anywhere/releases/.new-XXXXXX)
    tar -xzf - -C \$tmp
    node --check \$tmp/anywhere/relay.js
    chown -R root:root \$tmp; chmod -R a+rX,go-w \$tmp
    mv \$tmp \$dir
  else cat >/dev/null; fi
  ln -sfn \$dir /opt/chattering-anywhere/current.new
  mv -T /opt/chattering-anywhere/current.new /opt/chattering-anywhere/current
  echo $COMMIT > /opt/chattering-anywhere/DEPLOYED
  systemctl restart chattering-anywhere
  for i in \$(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8790/healthz 2>/dev/null && break; sleep 0.3; done
  curl -fsS http://127.0.0.1:8790/healthz >/dev/null || { echo relay did not answer; journalctl -u chattering-anywhere -n 20 --no-pager; exit 1; }
  # Keep the five newest releases.
  ls -1dt /opt/chattering-anywhere/releases/*/ | tail -n +6 | xargs -r rm -rf
  echo running: \$(readlink -f /opt/chattering-anywhere/current)
'"
