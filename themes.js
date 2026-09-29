'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN_THEME_IDS = new Set(['rockfrog', 'dark', 'light', 'gray', 'eink']);
// What a device shows until someone picks a theme (design/25). 'auto', the
// other end of the choice, follows the system's light or dark setting.
const DEFAULT_THEME = 'rockfrog';
const MODES = new Set(['color', 'gray', 'binary']);
const SCHEMES = new Set(['dark', 'light']);
const MOTIONS = new Set(['full', 'none']);

// A custom theme owns all visible colors. Layout and spacing stay global.
const REQUIRED_COLOR_TOKENS = [
  '--bg', '--surface-1', '--surface-2', '--surface-3',
  '--border', '--border-strong',
  '--text', '--text-dim', '--text-faint',
  '--red', '--yellow', '--green', '--cyan', '--blue', '--magenta',
  '--accent-strong', '--accent-ink',
  '--term-selection', '--term-selection-ink',
  '--ink', '--ink-ai', '--ink-halo',
  ...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`),
];

function defaultThemeDir(home) {
  return path.join(require('./platform.js').appDirs(process.env, home).config, 'themes');
}

function validThemeId(id) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id || ''));
}

function parseMetadata(css) {
  const match = String(css).match(/\/\*\s*(?:chattering|aiconvo)-theme\s*\n([\s\S]*?)\*\//i);
  if (!match) return { metadata: null, error: 'missing /* chattering-theme metadata block */' };
  const metadata = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim().replace(/^\*\s?/, '');
    if (!line) continue;
    const pair = line.match(/^([a-z][a-z0-9-]*)\s*:\s*(.+)$/i);
    if (!pair) return { metadata: null, error: `invalid metadata line: ${line}` };
    metadata[pair[1].toLowerCase()] = pair[2].trim();
  }
  return { metadata, error: null };
}

function parseDeclarations(css, id) {
  const withoutComments = String(css).replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^:root\\[data-theme=(['\"])${escaped}\\1\\]\\s*\\{([\\s\\S]*)\\}\\s*$`);
  const match = withoutComments.match(rule);
  if (!match) return { declarations: null, error: `expected one :root[data-theme="${id}"] rule` };
  const declarations = {};
  for (const raw of match[2].split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const pair = part.match(/^(--[a-z0-9-]+)\s*:\s*(.+)$/i);
    if (!pair) return { declarations: null, error: `only custom-property declarations are allowed: ${part}` };
    if (Object.hasOwn(declarations, pair[1])) return { declarations: null, error: `duplicate token ${pair[1]}` };
    const value = pair[2].trim();
    // Braces or comment markers inside a value would escape the token rule
    // when the bundle is served. Reject them with the other unsafe patterns.
    if (/[{}]|\/\*|\*\/|@import|url\s*\(|!important/i.test(value)) return { declarations: null, error: `unsafe value for ${pair[1]}` };
    declarations[pair[1]] = value;
  }
  return { declarations, error: null };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
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
  return rgb.map(v => Math.round((v + m) * 255));
}

function parseCssColor(value, declarations, seen = new Set()) {
  const raw = String(value || '').trim();
  const variable = raw.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
  if (variable) {
    if (seen.has(variable[1]) || !Object.hasOwn(declarations, variable[1])) return null;
    seen.add(variable[1]);
    return parseCssColor(declarations[variable[1]], declarations, seen);
  }
  let m = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  }
  m = raw.match(/^rgb\(\s*([\d.]+)%?[,\s]+([\d.]+)%?[,\s]+([\d.]+)%?\s*\)$/i);
  if (m) {
    const pct = raw.includes('%');
    const out = m.slice(1).map(v => Number(v) * (pct ? 2.55 : 1));
    return out.every(v => Number.isFinite(v) && v >= 0 && v <= 255) ? out.map(Math.round) : null;
  }
  m = raw.match(/^hsl\(\s*([\d.+-]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)$/i);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function luminance(rgb) {
  const channel = value => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function validateTheme(css, id) {
  const errors = [];
  if (!validThemeId(id)) errors.push('theme id must use lowercase letters, numbers, and hyphens');
  if (BUILTIN_THEME_IDS.has(id)) errors.push(`theme id conflicts with built-in theme: ${id}`);
  const parsedMeta = parseMetadata(css);
  if (parsedMeta.error) errors.push(parsedMeta.error);
  const metadata = parsedMeta.metadata || {};
  if (!metadata.name) errors.push('metadata name is required');
  if (!SCHEMES.has(metadata.scheme)) errors.push('metadata scheme must be dark or light');
  if (!MODES.has(metadata.mode)) errors.push('metadata mode must be color, gray, or binary');
  if (!MOTIONS.has(metadata.motion)) errors.push('metadata motion must be full or none');

  const parsedRule = validThemeId(id) ? parseDeclarations(css, id) : { declarations: null };
  if (parsedRule && parsedRule.error) errors.push(parsedRule.error);
  const declarations = (parsedRule && parsedRule.declarations) || {};
  for (const token of REQUIRED_COLOR_TOKENS) {
    if (!Object.hasOwn(declarations, token)) errors.push(`missing required token ${token}`);
    else if (!parseCssColor(declarations[token], declarations)) errors.push(`${token} must resolve to a hex, rgb, or hsl color`);
  }

  const check = (front, back, minimum) => {
    if (!Object.hasOwn(declarations, front) || !Object.hasOwn(declarations, back)) return;
    const a = parseCssColor(declarations[front], declarations);
    const b = parseCssColor(declarations[back], declarations);
    if (!a || !b) return;
    const ratio = contrast(a, b);
    if (ratio + 1e-9 < minimum) errors.push(`${front} on ${back} has ${ratio.toFixed(2)}:1 contrast; needs ${minimum}:1`);
  };
  check('--text', '--bg', 4.5);
  check('--text-dim', '--bg', 4.5);
  check('--text-faint', '--bg', 3);
  check('--green', '--bg', 4.5);
  check('--cyan', '--bg', 4.5);
  check('--yellow', '--bg', 4.5);
  check('--red', '--bg', 4.5);
  check('--magenta', '--bg', 4.5);
  check('--accent-ink', '--accent-strong', 4.5);
  check('--term-selection-ink', '--term-selection', 4.5);

  return { valid: errors.length === 0, errors, metadata, declarations };
}

function readCustomThemes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const valid = [], invalid = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.css') continue;
    const id = path.basename(entry.name, '.css');
    let css;
    try { css = fs.readFileSync(path.join(dir, entry.name), 'utf8'); }
    catch (error) {
      invalid.push({ id, file: entry.name, errors: [error.message] });
      continue;
    }
    const result = validateTheme(css, id);
    const item = { id, file: entry.name, css, declarations: result.declarations, ...result.metadata };
    if (result.valid) valid.push(item);
    else invalid.push({ ...item, errors: result.errors });
  }
  valid.sort((a, b) => a.name.localeCompare(b.name));
  invalid.sort((a, b) => a.id.localeCompare(b.id));
  return { valid, invalid };
}

function bundleCustomThemes(dir) {
  const { valid } = readCustomThemes(dir);
  return valid.map(theme => {
    const capabilities = [
      `--theme-mode: ${theme.mode}`,
      `--theme-motion: ${theme.motion === 'none' ? '0' : '1'}`,
      `color-scheme: ${theme.scheme}`,
    ].join('; ');
    return `${theme.css.trim()}\n:root[data-theme="${theme.id}"] { ${capabilities}; }`;
  }).join('\n\n') + (valid.length ? '\n' : '');
}

function declarationsForSelector(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(css).match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) return {};
  const declarations = {};
  for (const raw of match[1].split(';')) {
    const pair = raw.trim().match(/^(--[a-z0-9-]+)\s*:\s*(.+)$/i);
    if (pair) declarations[pair[1]] = pair[2].trim();
  }
  return declarations;
}

function rgbHex(rgb) {
  return '#' + rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
}

function manifestThemeColors(themeId, tokensCss, dir) {
  if (!themeId) themeId = DEFAULT_THEME;
  let declarations;
  if (themeId && !BUILTIN_THEME_IDS.has(themeId)) {
    const theme = readCustomThemes(dir).valid.find(item => item.id === themeId);
    declarations = theme && theme.declarations;
  } else if (themeId && themeId !== 'dark') {
    declarations = declarationsForSelector(tokensCss, `:root[data-theme="${themeId}"]`);
  }
  if (!declarations || !Object.keys(declarations).length) declarations = declarationsForSelector(tokensCss, ':root');
  const rgb = parseCssColor(declarations['--bg'], declarations) || [16, 20, 18];
  const color = rgbHex(rgb);
  return { backgroundColor: color, themeColor: color };
}

module.exports = {
  BUILTIN_THEME_IDS,
  DEFAULT_THEME,
  REQUIRED_COLOR_TOKENS,
  defaultThemeDir,
  parseCssColor,
  parseMetadata,
  readCustomThemes,
  validateTheme,
  bundleCustomThemes,
  manifestThemeColors,
  contrast,
};
