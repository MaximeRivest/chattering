#!/usr/bin/env python3
"""Chattering downloads, day by day (GitHub only keeps running totals).

    scripts/download-stats.py record     save today's counts (a daily timer runs this)
    scripts/download-stats.py [report] [days]   what changed, per day and per kind (default 14)

Kept in ~/.local/share/chattering-stats/downloads.jsonl, one line per day:
each release file's id and its download count, and the project page's views.
Nothing is sent anywhere; it reads GitHub's public numbers (and the page
views, which need the owner's `gh` sign-in).

GitHub resets a file's counter when the file is replaced (a new upload under
the same name gets a new id), so a day's downloads are counted per file id:
growth since the day before, and a new id counts from zero.
"""
import datetime, json, os, subprocess, sys, urllib.request

REPO = os.environ.get('CHATTERING_REPO', 'MaximeRivest/chattering')
FILE = os.path.join(os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share')), 'chattering-stats', 'downloads.jsonl')

def kind(name):
    n = name.lower()
    if n.endswith('.apk'): return 'Android app'
    if n.endswith('.exe'): return 'Windows installer'
    if n.endswith('.dmg'): return 'Mac installer'
    if 'linux' in n: return 'Linux'
    if 'win' in n: return 'Windows zip'
    if 'macos' in n: return 'Mac zip'
    return 'other'

def token():
    try: return subprocess.run(['gh', 'auth', 'token'], capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception: return ''

def get(path, tok):
    req = urllib.request.Request('https://api.github.com/' + path, headers={'Accept': 'application/vnd.github+json', **({'Authorization': 'Bearer ' + tok} if tok else {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def record():
    tok = token()
    assets, page = {}, 1
    while True:
        rels = get(f'repos/{REPO}/releases?per_page=100&page={page}', tok)
        for rel in rels:
            for a in rel.get('assets', []):
                assets[str(a['id'])] = {'name': a['name'], 'release': rel['tag_name'], 'count': a['download_count']}
        if len(rels) < 100: break
        page += 1
    views = None
    if tok:
        try:
            v = get(f'repos/{REPO}/traffic/views', tok)
            views = {d['timestamp'][:10]: [d['count'], d['uniques']] for d in v.get('views', [])}
        except Exception: pass
    row = {'day': datetime.date.today().isoformat(), 'at': datetime.datetime.now().isoformat(timespec='seconds'), 'assets': assets, 'views': views}
    os.makedirs(os.path.dirname(FILE), exist_ok=True)
    rows = [r for r in load() if r['day'] != row['day']] + [row]
    with open(FILE + '.tmp', 'w') as f:
        for r in rows: f.write(json.dumps(r) + '\n')
    os.replace(FILE + '.tmp', FILE)
    print(f"recorded {row['day']}: {sum(a['count'] for a in assets.values())} downloads in total across {len(assets)} files")

def load():
    try:
        with open(FILE) as f: return [json.loads(l) for l in f if l.strip()]
    except FileNotFoundError: return []

def report(days):
    rows = load()
    if not rows: sys.exit('nothing recorded yet: run `scripts/download-stats.py record`')
    kinds = ['Mac installer', 'Windows installer', 'Linux', 'Android app', 'Mac zip', 'Windows zip']
    print(f"Chattering downloads per day (first day recorded: {rows[0]['day']})\n")
    print(f"  {'day':<12}" + ''.join(f'{k.split()[0] + (" app" if k == "Android app" else " zip" if "zip" in k else ""):>12}' for k in kinds) + f"{'all':>8}{'page views':>12}")
    views = {}
    for r in rows:
        for d, v in (r.get('views') or {}).items(): views[d] = v
    week = {k: 0 for k in kinds}
    out = []
    for prev, cur in zip(rows, rows[1:]):
        per = {k: 0 for k in kinds}
        for aid, a in cur['assets'].items():
            before = prev['assets'].get(aid, {}).get('count', 0)
            k = kind(a['name'])
            if k in per: per[k] += max(0, a['count'] - before)
        out.append((cur['day'], per))
    for day, per in out[-days:][::-1]:
        v = views.get(day)
        print(f"  {day:<12}" + ''.join(f'{per[k]:>12}' for k in kinds) + f"{sum(per.values()):>8}" + (f"{v[0]:>6} ({v[1]})" if v else f"{'':>12}"))
    for day, per in out[-7:]:
        for k in kinds: week[k] += per[k]
    if out:
        print(f"\n  last 7 days: " + ', '.join(f"{k} +{week[k]}" for k in kinds if week[k]) + (f" (total +{sum(week.values())})" if sum(week.values()) else 'none'))
    else:
        print('  (one day recorded so far: changes show from the second day on)')
    tot = {k: 0 for k in kinds}
    for a in rows[-1]['assets'].values():
        if kind(a['name']) in tot: tot[kind(a['name'])] += a['count']
    print('  all time (GitHub\'s totals): ' + ', '.join(f'{k} {tot[k]}' for k in kinds if tot[k]))
    print('\n  page views: views (distinct visitors) of the GitHub page that day')

if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'report'
    if cmd == 'record': record()
    elif cmd == 'report': report(int(sys.argv[2]) if len(sys.argv) > 2 else 14)
    elif cmd.isdigit(): report(int(cmd))
    else: sys.exit(__doc__)
