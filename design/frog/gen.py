#!/usr/bin/env python3
"""Generate frog mascot images through OpenRouter's image models.
gen.py MODEL OUT.png "PROMPT" [REFERENCE.png ...]"""
import base64, json, subprocess, sys, urllib.request
model, out, prompt, refs = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
key = subprocess.run(["pi", "auth", "print-bearer-token", "--provider", "openrouter"], capture_output=True, text=True).stdout.strip()
content = [{"type": "text", "text": prompt}]
for r in refs:
    content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(open(r, "rb").read()).decode()}})
body = {"model": model, "modalities": ["image", "text"], "messages": [{"role": "user", "content": content}]}
req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
                             headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
r = json.load(urllib.request.urlopen(req, timeout=300))
msg = r["choices"][0]["message"]
imgs = msg.get("images") or []
if not imgs:
    sys.exit("no image: " + json.dumps(msg)[:500])
url = imgs[0]["image_url"]["url"]
open(out, "wb").write(base64.b64decode(url.split(",", 1)[1]))
print(out, r.get("usage", {}).get("cost"))
