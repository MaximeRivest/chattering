#!/usr/bin/env bash
# Restart Chattering and bring back every conversation that was working.
#
#   scripts/restart-chattering.sh [--report <conversation id>] [--delay <s>] [--frog]
#
# What it does, in order:
#   1. notes which conversations are busy right now (the agents' active list);
#   2. launches itself as its own user unit (chattering-restart), so the
#      restart does not end it, and returns at once;
#   3. in the unit: waits --delay seconds (default 20: the turn that asked
#      for the restart finishes saying so), restarts the chattering service,
#      waits until it answers, reads its recovery records and resumes each
#      conversation that was busy before (Chattering's own "Sorry, you were
#      interrupted, continue"), then checks 15 s later that each is working;
#   4. with --report <id>, wakes that conversation with a note pointing at
#      the log, so it can verify and tell the person.
# The frog's own conversation is never resumed unless --frog is given: its
# next turn starts when the person speaks, and a resumed turn would be read
# aloud to them unasked.
# Log: /tmp/chattering-restart.log. The GPU jobs, the voice services and
# every other unit are untouched: only `chattering` is restarted.
set -u
LOG=/tmp/chattering-restart.log
BASE=${CHATTERING_BASE:-https://127.0.0.1:7443}
TOKEN=$(cat ~/.cache/chattering/lan-token)
REPORT=""; DELAY=20; FROG=0; INNER=0; BUSY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) REPORT="$2"; shift 2 ;;
    --delay) DELAY="$2"; shift 2 ;;
    --frog) FROG=1; shift ;;
    --inner) INNER=1; BUSY="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
api() { curl -sk -m 20 -H "Authorization: Bearer $TOKEN" "$@"; }
say() { echo "$(date +%T) $*" | tee -a "$LOG"; }
busy_keys() { api "$BASE/api/agents/active" | python3 -c 'import json,sys; print("\n".join(p["key"] for p in json.load(sys.stdin).get("procs",[]) if p.get("busy") and p.get("key")))'; }

if [ "$INNER" = 0 ]; then
  BUSY=$(busy_keys)
  if [ -z "$BUSY" ]; then echo "nothing is working; restarting all the same"; fi
  echo "$BUSY" | sed 's/^/working: /'
  systemctl --user reset-failed chattering-restart 2>/dev/null
  systemd-run --user --unit=chattering-restart --collect "$0" --inner "$BUSY" --report "$REPORT" --delay "$DELAY" $([ "$FROG" = 1 ] && echo --frog)
  echo "launched: it restarts in $DELAY s; log: $LOG"
  exit 0
fi

: > "$LOG"
say "restart asked; working before: $(echo "$BUSY" | grep -c . ) conversation(s)"
sleep "$DELAY"
say "restarting chattering"
systemctl --user restart chattering
for i in $(seq 1 120); do api -o /dev/null -w '%{http_code}' "$BASE/api/app/status" 2>/dev/null | grep -q 200 && break; sleep 1; done
say "chattering answers again"
sleep 6  # its index and recovery records load
FROG_KEY=$(api "$BASE/api/frog/home" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("key") or "")' 2>/dev/null)
REC=$(api "$BASE/api/agents/recovery")
say "interrupted: $(echo "$REC" | python3 -c 'import json,sys; print(", ".join((r.get("title") or r.get("key","")[-40:]) for r in json.load(sys.stdin).get("interrupted",[])))')"
RESUMED=""
while IFS= read -r key; do
  [ -z "$key" ] && continue
  if [ "$FROG" = 0 ] && [ "$key" = "$FROG_KEY" ]; then say "skip the frog (it goes on when the person speaks)"; continue; fi
  # The conversation that asked is woken with the report below, not resumed
  # as well (it got both the first time, 2026-10-19).
  if [ -n "$REPORT" ] && [[ "$key" == *"$REPORT"* ]]; then say "skip ${key: -44}: it asked; it gets the report"; continue; fi
  rid=$(echo "$REC" | python3 -c "import json,sys; print(next((r['id'] for r in json.load(sys.stdin).get('interrupted',[]) if r.get('key')==sys.argv[1]), ''))" "$key")
  title=$(echo "$REC" | python3 -c "import json,sys; print(next((r.get('title') or '' for r in json.load(sys.stdin).get('interrupted',[]) if r.get('key')==sys.argv[1]), ''))" "$key")
  if [ -n "$rid" ]; then
    out=$(api -X POST -H 'Content-Type: application/json' -d "{\"action\":\"resume\",\"id\":\"$rid\"}" "$BASE/api/agents/recovery")
    ok=$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ok", False))' 2>/dev/null)
    say "resume $title: ok=$ok"
    RESUMED="$RESUMED
$key"
  else
    say "resume ${title:-$key}: no interrupted record (it finished before the restart, or was not cut)"
  fi
done <<< "$BUSY"
sleep 15
ACT=$(api "$BASE/api/agents/active")
while IFS= read -r key; do
  [ -z "$key" ] && continue
  busy=$(echo "$ACT" | python3 -c "import json,sys; print(any(p.get('key')==sys.argv[1] and p.get('busy') for p in json.load(sys.stdin).get('procs',[])))" "$key")
  say "after 15 s, ${key: -44}: working=$busy"
done <<< "$RESUMED"
if [ -n "$REPORT" ]; then
  key=$(ls ~/.pi/agent/sessions/*/*"$REPORT"*.jsonl 2>/dev/null | head -1 | sed "s|$HOME/.pi/agent/sessions/|pi:|")
  if [ -n "$key" ]; then
    msg="(From the restart script, not Maxime.) Chattering was restarted as Maxime asked. Read $LOG, check that the conversations it resumed are working again, and tell Maxime in one or two sentences; if one did not resume, say so and why."
    out=$(python3 -c 'import json,sys; print(json.dumps({"id": sys.argv[1], "prompt": sys.argv[2]}))' "$key" "$msg" | api -X POST -H 'Content-Type: application/json' --data @- "$BASE/api/node/send")
    say "woke $REPORT: $(echo "$out" | head -c 120)"
  else say "report: no conversation matches $REPORT"; fi
fi
say "done"
