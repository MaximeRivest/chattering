#!/usr/bin/env python3
"""How much the relay is used (design/85, "Usage"): totals only.

    anywhere/deploy/relay-usage.py [days]        (default: the last 14 days)
    RELAY_HOST=ubuntu@encrypted-link-relay anywhere/deploy/relay-usage.py

Reads, over SSH, the relay's own totals (computers, phone connections: no
ids, no addresses) and the firewall's daily byte counts for relayed traffic.
"""
import json, os, subprocess, sys

HOST = os.environ.get('RELAY_HOST', 'ubuntu@encrypted-link-relay')
DAYS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 14
SEP = '::relay-usage::'
remote = f"""curl -fsS http://127.0.0.1:8790/_usage; echo '{SEP}';
sudo cat /var/lib/chattering-anywhere-traffic/traffic.json 2>/dev/null || echo '{{}}'; echo '{SEP}';
sudo nft -j list counters table inet relay 2>/dev/null || echo '{{}}'"""
out = subprocess.run(['ssh', '-o', 'BatchMode=yes', HOST, remote], capture_output=True, text=True, timeout=60)
if out.returncode != 0 and SEP not in out.stdout:
    sys.exit('could not read the relay: ' + (out.stderr.strip() or 'ssh failed'))
parts = out.stdout.split(SEP)
usage = json.loads(parts[0])
traffic = {d['key']: d for d in (json.loads(parts[1] or '{}').get('days') or [])}
live = {c['counter']['name']: c['counter']['bytes'] for c in json.loads(parts[2] or '{}').get('nftables', []) if 'counter' in c}

def size(n):
    n = float(n or 0)
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if n < 1000 or unit == 'TB':
            return (f'{n:.0f} {unit}' if unit == 'B' or n >= 100 else f'{n:.1f} {unit}')
        n /= 1000

def relayed(day, today=False):
    t = traffic.get(day, {})
    total = (t.get('in', 0) + t.get('out', 0)) / 2
    if today:
        total += (live.get('relayed_in', 0) + live.get('relayed_out', 0)) / 2
    return total

today = usage['today']
month = usage['thisMonth']
month_relayed = sum(relayed(k) for k in traffic if k.startswith(month['key'])) + (live.get('relayed_in', 0) + live.get('relayed_out', 0)) / 2
print(f"Chattering relay: how much it is used (totals only; UTC days)\n")
print(f"  right now        {usage['online']} computer{'s' if usage['online'] != 1 else ''} connected")
print(f"  this month       {month['computers']} computers · at most {month['peak']} at once · {month['calls']} phone connections · {size(month_relayed)} relayed ({month['key']})")
for m in usage.get('months', [])[-3:][::-1]:
    print(f"  {m['key']:<16} {m['computers']} computers · at most {m['peak']} at once · {m['calls']} phone connections")
print()
print(f"  {'day':<12}{'computers':>10}{'at once':>9}{'phones':>8}{'waited':>8}{'relayed':>11}")
rows = [today] + usage.get('days', [])[::-1]
for i, d in enumerate(rows[:DAYS]):
    note = ' (so far)' if i == 0 else ''
    restarts = f"  (relay restarted {d['restarts']}×: a computer may count twice)" if d.get('restarts') else ''
    print(f"  {d['key']:<12}{d['computers']:>10}{d['peak']:>9}{d['calls']:>8}{d['waits']:>8}{size(relayed(d['key'], i == 0)):>11}{note}{restarts}")
print("\n  phones: connections introduced (opening Chattering, pairing, coming back)")
print("  waited: phones that asked for a computer that was not connected")
print("  relayed: data carried for phones that could not reach their computer directly")
