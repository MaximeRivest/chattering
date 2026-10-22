const cv = document.getElementById('pond'), x = cv.getContext('2d');
const scoreEl = document.getElementById('score'), bestEl = document.getElementById('best');
let W = 0, H = 0, score = 0, best = Number(localStorage.getItem('frog-best') || 0), flies = [], tongue = null;
bestEl.textContent = best;
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function size() { const r = devicePixelRatio || 1; W = cv.clientWidth; H = cv.clientHeight; cv.width = W * r; cv.height = H * r; x.setTransform(r, 0, 0, r, 0, 0); }
addEventListener('resize', size); size();
const frog = () => ({ x: W / 2, y: H - 70 });
function spawn() { flies.push({ x: Math.random() * W, y: 30 + Math.random() * (H * 0.55), a: Math.random() * 6.28, s: 0.6 + Math.random(), p: Math.random() * 6.28, r: 0.03 + Math.random() * 0.04 }); }
for (let i = 0; i < 6; i++) spawn();
cv.addEventListener('pointerdown', e => { const r = cv.getBoundingClientRect(); tongue = { tx: e.clientX - r.left, ty: e.clientY - r.top, t: 0 }; });
function step() {
  for (const f of flies) { f.a += (Math.random() - 0.5) * 0.4; f.x += Math.cos(f.a) * f.s; f.y += Math.sin(f.a) * f.s;
    if (f.x < 10 || f.x > W - 10) f.a = Math.PI - f.a; if (f.y < 10 || f.y > H - 140) f.a = -f.a; }
  const F = frog();
  // Fireflies need the dark: the pond is at dusk whatever the page theme.
  const sky = x.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#07151c'); sky.addColorStop(1, '#0f2e2a');
  x.fillStyle = sky; x.fillRect(0, 0, W, H);
  x.strokeStyle = css('--color-border-primary') || '#2c6159'; x.lineWidth = 2;
  for (const r of [60, 110, 170]) { x.beginPath(); x.ellipse(F.x, F.y + 20, r * 2, r * 0.5, 0, 0, 7); x.stroke(); }
  x.fillStyle = '#3f8f3a'; x.beginPath(); x.ellipse(F.x, F.y + 18, 90, 28, 0, 0, 7); x.fill();
  x.fillStyle = '#6cc04a'; x.beginPath(); x.ellipse(F.x, F.y, 48, 34, 0, 0, 7); x.fill();
  for (const dx of [-20, 20]) { x.fillStyle = '#fff'; x.beginPath(); x.arc(F.x + dx, F.y - 30, 11, 0, 7); x.fill();
    x.fillStyle = '#111'; x.beginPath(); x.arc(F.x + dx, F.y - 30, 5, 0, 7); x.fill(); }
  if (tongue) {
    tongue.t += 0.12; const k = tongue.t < 1 ? tongue.t : 2 - tongue.t;
    const tx = F.x + (tongue.tx - F.x) * k, ty = F.y - 8 + (tongue.ty - F.y + 8) * k;
    x.strokeStyle = '#e0567a'; x.lineWidth = 6; x.lineCap = 'round'; x.beginPath(); x.moveTo(F.x, F.y - 8); x.lineTo(tx, ty); x.stroke();
    flies = flies.filter(f => { if (Math.hypot(f.x - tx, f.y - ty) < 18) { score++; spawn(); return false; } return true; });
    scoreEl.textContent = score;
    if (score > best) { best = score; bestEl.textContent = best; localStorage.setItem('frog-best', best); }
    if (tongue.t >= 2) tongue = null;
  }
  // Fireflies: each pulses at its own pace, a soft halo around a bright core.
  x.globalCompositeOperation = 'lighter';
  for (const f of flies) {
    f.p += f.r;
    const glow = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(f.p));
    const halo = x.createRadialGradient(f.x, f.y, 0, f.x, f.y, 28);
    halo.addColorStop(0, `rgba(230,255,120,${0.55 * glow})`);
    halo.addColorStop(0.35, `rgba(190,255,80,${0.25 * glow})`);
    halo.addColorStop(1, 'rgba(160,255,60,0)');
    x.fillStyle = halo; x.beginPath(); x.arc(f.x, f.y, 28, 0, 7); x.fill();
    x.shadowColor = `rgba(220,255,110,${glow})`; x.shadowBlur = 14 * glow;
    x.fillStyle = `rgba(250,255,190,${0.6 + 0.4 * glow})`; x.beginPath(); x.arc(f.x, f.y, 3.5, 0, 7); x.fill();
    x.shadowBlur = 0;
  }
  x.globalCompositeOperation = 'source-over';
  // Faint wings, so they still read as insects.
  for (const f of flies) { x.fillStyle = 'rgba(220,235,255,.25)'; x.beginPath(); x.ellipse(f.x - 5, f.y - 4, 6, 3, 0.4, 0, 7); x.ellipse(f.x + 5, f.y - 4, 6, 3, -0.4, 0, 7); x.fill(); }
  requestAnimationFrame(step);
}
step();
