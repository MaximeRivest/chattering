"""Record reachability and content fingerprints of the primary evidence pages.
No credentials or model calls. Full responses remain in /tmp, outside the report.
A successful fetch is not semantic verification; read the relevant excerpts too.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess, re, json, hashlib, datetime, html
BASE=Path(__file__).resolve().parent
CACHE=Path('/tmp/composer-research'); CACHE.mkdir(exist_ok=True)
text=(BASE/'02-agent-evidence.md').read_text()
rows=[]
for line in text.splitlines():
    m=re.match(r'\| (R\d+) \| (.*?) \| (.*?) \|',line)
    if m:
        for i,url in enumerate(re.findall(r'`(https://[^`]+)`',m[3])):
            rows.append((m[1]+('-'+str(i+1) if i else ''),m[2],url))
def get(row):
    ref,title,url=row; dest=CACHE/(ref+'.html')
    p=subprocess.run(['curl','-L','--max-time','35','--connect-timeout','10','-sS','-o',str(dest),'-w','%{http_code}\n%{url_effective}',url],capture_output=True,text=True)
    meta=p.stdout.splitlines(); body=dest.read_bytes() if dest.exists() else b''
    s=body.decode('utf8','replace')
    s=re.sub(r'<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>','',s,flags=re.S|re.I)
    s=html.unescape(re.sub('<[^>]+>','\n',s));s=re.sub(r'\n[ \t]*\n+','\n',s)
    (CACHE/(ref+'.txt')).write_text(s)
    return dict(ref=ref,title=title,url=url,status=meta[0] if meta else 'error',effectiveUrl=meta[1] if len(meta)>1 else url,sha256=hashlib.sha256(body).hexdigest(),bytes=len(body),error=p.stderr.strip() or None)
with ThreadPoolExecutor(max_workers=6) as pool: results=list(pool.map(get,rows))
(BASE/'source-checks.json').write_text(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'Unauthenticated GET; status/hash only; see research for semantic evidence','sources':results},indent=2)+'\n')
for r in results: print(r['ref'],r['status'],r['bytes'],r['effectiveUrl'])
