'use strict';
require('./win-hide.js'); // first: on Windows nothing this starts opens a window (design/70)

// Build a Chattering theme from a terminal or OS color scheme.
// Terminal palettes and Chattering tokens have the same shape: a background,
// a foreground, and 16 ANSI colors. The mapping is mechanical; contrast
// repair makes the result pass the theme validator (themes.js).
//
// Usage: node themeimport.js [--from <source|file>] [--id x] [--name "X"]
//                            [--out <dir>] [--print] [--list]

const fs = require('fs');
const os = require('os');
const path = require('path');
const themesLib = require('./themes.js');

const HOME = os.homedir();
const expand = p => p.replace(/^~(?=$|\/)/, HOME);

// ---- color math -----------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function parseHex(raw) {
  const m = String(raw || '').trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [((h * 60) + 360) % 360, s * 100, l * 100];
}

function hslToRgb([h, s, l]) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map(v => (v + m) * 255);
}

const luminance = rgb => themesLib.contrast(rgb, [0, 0, 0]) / 21; // cheap relative scale
const contrast = themesLib.contrast;

// Move a color's lightness away from the background until it reaches the
// target contrast. Hue and saturation stay; only lightness repairs.
function ensureContrast(rgb, bg, minimum) {
  if (contrast(rgb, bg) >= minimum) return rgb;
  const lighten = luminance(bg) < 0.5;
  let [h, s, l] = rgbToHsl(rgb);
  for (let i = 0; i < 60; i++) {
    l = clamp(l + (lighten ? 1.5 : -1.5), 0, 100);
    const next = hslToRgb([h, s, l]);
    if (contrast(next, bg) >= minimum) return next;
    if (l === 0 || l === 100) return next;
  }
  return rgb;
}

// ---- source readers -------------------------------------------------------
// Every reader returns { bg, fg, ansi[16], selBg?, selFg? } with rgb arrays.

function readAlacritty(file, depth = 0) {
  const text = fs.readFileSync(file, 'utf8');
  const out = { ansi: [] };
  // Follow "import"/"general.import" chains first: colors usually live in an
  // imported theme file (Omarchy, alacritty-theme, pi-look all work this way).
  const imports = [...text.matchAll(/^\s*import\s*=\s*\[([^\]]*)\]/gm)]
    .flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]));
  if (depth < 4) {
    for (const imp of imports) {
      const resolved = path.isAbsolute(expand(imp)) ? expand(imp) : path.join(path.dirname(file), imp);
      try { mergePalette(out, readAlacritty(resolved, depth + 1)); } catch {}
    }
  }
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^\s*\[([^\]]+)\]/);
    if (head) { section = head[1]; continue; }
    const pair = line.match(/^\s*([a-z_]+)\s*=\s*"?(#[0-9a-fA-F]{3,6})"?/);
    if (!pair) continue;
    const [, key, value] = pair, rgb = parseHex(value);
    if (!rgb) continue;
    if (section === 'colors.primary' && key === 'background') out.bg = rgb;
    if (section === 'colors.primary' && key === 'foreground') out.fg = rgb;
    if (section === 'colors.selection' && key === 'background') out.selBg = rgb;
    if (section === 'colors.selection' && key === 'text') out.selFg = rgb;
    const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    const slot = names.indexOf(key);
    if (slot >= 0 && section === 'colors.normal') out.ansi[slot] = rgb;
    if (slot >= 0 && section === 'colors.bright') out.ansi[slot + 8] = rgb;
  }
  // Omarchy keeps a named accent in colors.toml next to the palette.
  try {
    const colorsFile = path.join(path.dirname(file), 'colors.toml');
    if (fs.existsSync(colorsFile)) {
      const text = fs.readFileSync(colorsFile, 'utf8');
      const acc = text.match(/^\s*accent\s*=\s*"?(#[0-9a-fA-F]{3,6})"?/m);
      if (acc) out.accent = parseHex(acc[1]);
    }
  } catch {}
  return out;
}

function readKitty(file, depth = 0) {
  const text = fs.readFileSync(file, 'utf8');
  const out = { ansi: [] };
  for (const line of text.split(/\r?\n/)) {
    const inc = line.match(/^\s*include\s+(.+?)\s*$/);
    if (inc && depth < 4) {
      const resolved = path.isAbsolute(expand(inc[1])) ? expand(inc[1]) : path.join(path.dirname(file), inc[1]);
      try { mergePalette(out, readKitty(resolved, depth + 1)); } catch {}
      continue;
    }
    const pair = line.match(/^\s*([a-z_0-9]+)\s+(#[0-9a-fA-F]{3,6})\s*$/);
    if (!pair) continue;
    const [, key, value] = pair, rgb = parseHex(value);
    if (!rgb) continue;
    if (key === 'background') out.bg = rgb;
    if (key === 'foreground') out.fg = rgb;
    if (key === 'selection_background') out.selBg = rgb;
    if (key === 'selection_foreground') out.selFg = rgb;
    const slot = key.match(/^color(\d{1,2})$/);
    if (slot && +slot[1] < 16) out.ansi[+slot[1]] = rgb;
  }
  return out;
}

function readGhostty(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = { ansi: [] };
  for (const line of text.split(/\r?\n/)) {
    const pair = line.match(/^\s*([a-z-]+)\s*=\s*(.+?)\s*$/);
    if (!pair) continue;
    const [, key, value] = pair;
    if (key === 'palette') {
      const slot = value.match(/^(\d{1,2})\s*=\s*(#?[0-9a-fA-F]{6})$/);
      if (slot && +slot[1] < 16) out.ansi[+slot[1]] = parseHex(slot[2]);
      continue;
    }
    const rgb = parseHex(value);
    if (!rgb) continue;
    if (key === 'background') out.bg = rgb;
    if (key === 'foreground') out.fg = rgb;
    if (key === 'selection-background') out.selBg = rgb;
    if (key === 'selection-foreground') out.selFg = rgb;
  }
  return out;
}

function readFoot(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = { ansi: [] };
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^\s*\[([^\]]+)\]/);
    if (head) { section = head[1].trim(); continue; }
    if (section !== 'colors') continue;
    const pair = line.match(/^\s*([a-z0-9]+)\s*=\s*([0-9a-fA-F]{6})\s*$/);
    if (!pair) continue;
    const [, key, value] = pair, rgb = parseHex(value);
    if (key === 'background') out.bg = rgb;
    if (key === 'foreground') out.fg = rgb;
    const regular = key.match(/^regular(\d)$/), bright = key.match(/^bright(\d)$/);
    if (regular) out.ansi[+regular[1]] = rgb;
    if (bright) out.ansi[+bright[1] + 8] = rgb;
  }
  return out;
}

function readWal(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = { ansi: [] };
  // pi theme files (~/.pi/agent/themes/*.json) keep the palette under "vars".
  if (data.vars) {
    const vars = data.vars;
    out.bg = parseHex(vars.background);
    out.fg = parseHex(vars.foreground);
    out.selBg = parseHex(vars.selectionBackground);
    out.selFg = parseHex(vars.selectionForeground);
    const accent = parseHex(vars.accent);
    if (accent) out.accent = accent;
    for (let i = 0; i < 16; i++) out.ansi[i] = parseHex(vars['color' + i]);
    return out;
  }
  if (data.special) {
    out.bg = parseHex(data.special.background);
    out.fg = parseHex(data.special.foreground);
  }
  for (let i = 0; i < 16; i++) out.ansi[i] = parseHex((data.colors || {})['color' + i]);
  return out;
}

// The active pi theme, when it is a custom file with a full palette.
// Built-in pi themes (dark/light) paint on the terminal background and
// carry no palette, so they are not importable.
function resolvePiTheme() {
  try {
    const settings = JSON.parse(fs.readFileSync(expand('~/.pi/agent/settings.json'), 'utf8'));
    if (!settings.theme) return null;
    return expand(`~/.pi/agent/themes/${settings.theme}.json`);
  } catch { return null; }
}

// On WSL, the terminal usually runs on the Windows side: find an Alacritty
// config under /mnt/c/Users/<name>/AppData/Roaming/alacritty.
function resolveWindowsAlacritty() {
  try {
    for (const user of fs.readdirSync('/mnt/c/Users')) {
      const file = path.join('/mnt/c/Users', user, 'AppData', 'Roaming', 'alacritty', 'alacritty.toml');
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

function mergePalette(target, extra) {
  for (const key of ['bg', 'fg', 'selBg', 'selFg', 'accent']) if (extra[key]) target[key] = extra[key];
  extra.ansi.forEach((rgb, i) => { if (rgb) target.ansi[i] = rgb; });
}

// ---- source detection -----------------------------------------------------

const SOURCES = [
  { id: 'omarchy', label: 'Omarchy / Hyprland theme', file: '~/.local/state/omarchy/current/theme/alacritty.toml', read: readAlacritty },
  { id: 'pi', label: 'pi custom theme', resolve: resolvePiTheme, read: readWal },
  { id: 'wal', label: 'pywal / wallust', file: '~/.cache/wal/colors.json', read: readWal },
  { id: 'alacritty', label: 'Alacritty', file: '~/.config/alacritty/alacritty.toml', read: readAlacritty },
  { id: 'alacritty-windows', label: 'Alacritty (Windows side, via WSL)', resolve: resolveWindowsAlacritty, read: readAlacritty },
  { id: 'kitty', label: 'kitty', file: '~/.config/kitty/kitty.conf', read: readKitty },
  { id: 'ghostty', label: 'Ghostty', file: '~/.config/ghostty/config', read: readGhostty },
  { id: 'foot', label: 'foot', file: '~/.config/foot/foot.ini', read: readFoot },
];

function readerForFile(file) {
  if (/\.json$/i.test(file)) return readWal;
  if (/\.toml$/i.test(file)) return readAlacritty;
  if (/\.ini$/i.test(file)) return readFoot;
  if (/kitty|\.conf$/i.test(file)) return readKitty;
  return readGhostty;
}

function paletteComplete(palette) {
  return palette && palette.bg && palette.fg && palette.ansi.filter(Boolean).length >= 8;
}

function detectSources() {
  return SOURCES.map(source => {
    const file = source.resolve ? source.resolve() : expand(source.file);
    let palette = null;
    try { if (file && fs.existsSync(file)) palette = source.read(file); } catch {}
    return { ...source, file: file || '(none found)', palette, ok: paletteComplete(palette) };
  });
}

// ---- palette → tokens -----------------------------------------------------

function buildTheme(palette, { id, name }) {
  const { bg, fg } = palette;
  const dark = luminance(bg) < 0.5;
  // Fill the ANSI gaps: dim slots reuse bright ones and the reverse.
  const ansi = Array.from({ length: 16 }, (_, i) =>
    palette.ansi[i] || palette.ansi[i < 8 ? i + 8 : i - 8] || (i % 8 === 0 ? bg : fg));

  // For each app hue, take the normal or bright ANSI slot with the better
  // contrast on the background, then repair lightness to at least 4.5:1.
  const hue = (a, b) => ensureContrast(contrast(ansi[a], bg) >= contrast(ansi[b], bg) ? ansi[a] : ansi[b], bg, 4.5);
  const red = hue(1, 9), green = hue(2, 10), yellow = hue(3, 11);
  const blue = hue(4, 12), magenta = hue(5, 13), cyan = hue(6, 14);

  // Surfaces step from the background toward the foreground, like the
  // built-in ramps. Text dims by mixing back toward the background.
  const surface = t => toHex(mix(bg, fg, t));
  const text = ensureContrast(fg, bg, 4.5);
  const textDim = ensureContrast(mix(fg, bg, 0.3), bg, 4.5);
  const textFaint = ensureContrast(mix(fg, bg, 0.5), bg, 3);

  // Filled controls: the OS/theme accent when present, else ANSI green.
  // --accent can differ from --green so success stays green.
  let accentStrong = palette.accent ? ensureContrast(palette.accent, bg, 4.5) : green;
  let accentInk = contrast(bg, accentStrong) >= 4.5 ? bg
    : (contrast([0, 0, 0], accentStrong) >= contrast([255, 255, 255], accentStrong) ? [0, 0, 0] : [255, 255, 255]);
  accentInk = ensureContrast(accentInk, accentStrong, 4.5);

  let selBg = palette.selBg || cyan;
  let selFg = palette.selFg && contrast(palette.selFg, selBg) >= 4.5 ? palette.selFg
    : (contrast(fg, selBg) >= 4.5 ? fg : ensureContrast(bg, selBg, 4.5));

  const declarations = {
    '--bg': toHex(bg),
    '--surface-1': surface(0.045), '--surface-2': surface(0.09), '--surface-3': surface(0.14),
    '--border': surface(0.19), '--border-strong': surface(0.32),
    '--text': toHex(text), '--text-dim': toHex(textDim), '--text-faint': toHex(textFaint),
    '--red': toHex(red), '--yellow': toHex(yellow), '--green': toHex(green),
    '--cyan': toHex(cyan), '--blue': toHex(blue), '--magenta': toHex(magenta),
    ...(palette.accent ? { '--accent': toHex(accentStrong) } : {}),
    '--accent-strong': toHex(accentStrong), '--accent-ink': toHex(accentInk),
    '--term-selection': toHex(selBg), '--term-selection-ink': toHex(selFg),
    '--ink': toHex(ensureContrast(red, bg, 4.5)), '--ink-ai': 'var(--ink)', '--ink-halo': toHex(bg),
  };
  ansi.forEach((rgb, i) => { declarations[`--ansi-${i}`] = toHex(rgb); });

  const body = Object.entries(declarations).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  const css = `/* chattering-theme
name: ${name}
scheme: ${dark ? 'dark' : 'light'}
mode: color
motion: full
*/
:root[data-theme="${id}"] {
${body}
}
`;
  return { css, scheme: dark ? 'dark' : 'light' };
}

// ---- CLI ------------------------------------------------------------------

function suggestId() {
  // Omarchy writes the current theme name next to the theme directory.
  for (const probe of ['~/.local/state/omarchy/current/theme.name']) {
    try {
      const id = fs.readFileSync(expand(probe), 'utf8').trim().toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
      if (id && !themesLib.BUILTIN_THEME_IDS.has(id)) return id;
    } catch {}
  }
  return 'terminal';
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--list' || argv[i] === '--print') args[argv[i].slice(2)] = true;
    else if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  const detected = detectSources();
  if (args.list || (!args.from && !detected.some(s => s.ok))) {
    console.log('detected color sources:');
    for (const s of detected) console.log(`  ${s.ok ? '✓' : '✗'} ${s.id.padEnd(10)} ${s.label} — ${s.file}${s.ok ? '' : ' (not usable)'}`);
    if (!args.list) { console.error('no usable source found. Pass --from <file>.'); process.exitCode = 1; }
    return;
  }

  let palette, sourceLabel;
  if (args.from) {
    const known = detected.find(s => s.id === args.from);
    if (known) {
      if (!known.ok) { console.error(`source ${args.from} is not usable (${known.file})`); process.exitCode = 1; return; }
      palette = known.palette; sourceLabel = known.label;
    } else {
      const file = path.resolve(expand(args.from));
      palette = readerForFile(file)(file);
      sourceLabel = file;
      if (!paletteComplete(palette)) { console.error(`could not read a full palette from ${file}`); process.exitCode = 1; return; }
    }
  } else {
    const best = detected.find(s => s.ok);
    palette = best.palette; sourceLabel = best.label;
    console.log(`using source: ${best.id} (${best.file})`);
  }

  const id = args.id || suggestId();
  const name = args.name || (id[0].toUpperCase() + id.slice(1)).replace(/-/g, ' ');
  const { css, scheme } = buildTheme(palette, { id, name });

  const result = themesLib.validateTheme(css, id);
  if (!result.valid) {
    console.error('generated theme failed validation (report this palette):');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  if (args.print) { process.stdout.write(css); return; }

  const dir = args.out ? path.resolve(expand(args.out)) : themesLib.defaultThemeDir(HOME);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.css`);
  fs.writeFileSync(file, css);
  console.log(`wrote ${file}`);
  console.log(`theme: ${name} (${scheme}) from ${sourceLabel}`);
  console.log('Open Chattering, focus the theme selector, and pick it under "custom themes".');
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { buildTheme, detectSources, readAlacritty, readKitty, readGhostty, readFoot, readWal, ensureContrast, parseHex, toHex };
