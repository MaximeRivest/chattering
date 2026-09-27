// Run: node --test test/*.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateTheme, contrast, parseCssColor } = require('../themes.js');
const {
  buildTheme, readAlacritty, readKitty, readGhostty, readFoot, readWal,
  ensureContrast, parseHex,
} = require('../themeimport.js');

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-import-')));

const CANDLE = {
  bg: parseHex('#120d08'), fg: parseHex('#d8c49a'),
  ansi: ['#120d08', '#a8503c', '#7d7a45', '#c9a227', '#5f7d94', '#96637a', '#6f8f80', '#d8c49a',
    '#6e5c44', '#c05a42', '#8f8c50', '#d9b23a', '#6f8da4', '#a6738a', '#7fa091', '#f0e2bf'].map(parseHex),
  selBg: parseHex('#3a2c1c'), selFg: parseHex('#f0e2bf'),
};

test('alacritty reader follows import chains and reads all colors', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'theme.toml'), [
    '[colors.primary]', 'background = "#120d08"', 'foreground = "#d8c49a"',
    '[colors.selection]', 'text = "#f0e2bf"', 'background = "#3a2c1c"',
    '[colors.normal]', 'red = "#a8503c"', 'green = "#7d7a45"', 'yellow = "#c9a227"',
    'blue = "#5f7d94"', 'magenta = "#96637a"', 'cyan = "#6f8f80"',
    'black = "#120d08"', 'white = "#d8c49a"',
    '[colors.bright]', 'red = "#c05a42"', 'green = "#8f8c50"', 'yellow = "#d9b23a"',
    'blue = "#6f8da4"', 'magenta = "#a6738a"', 'cyan = "#7fa091"',
    'black = "#6e5c44"', 'white = "#f0e2bf"',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'alacritty.toml'), '[general]\nimport = ["theme.toml"]\n[font]\nsize = 11\n');
  const palette = readAlacritty(path.join(dir, 'alacritty.toml'));
  assert.deepStrictEqual(palette.bg, CANDLE.bg);
  assert.deepStrictEqual(palette.fg, CANDLE.fg);
  assert.deepStrictEqual(palette.selBg, CANDLE.selBg);
  assert.strictEqual(palette.ansi.filter(Boolean).length, 16);
});

test('kitty, ghostty, foot, and wal readers extract full palettes', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'kitty.conf'),
    'background #101412\nforeground #dce3dd\nselection_background #53c8f1\n'
    + Array.from({ length: 16 }, (_, i) => `color${i} #a0b0c${i.toString(16)}`).join('\n'));
  const kitty = readKitty(path.join(dir, 'kitty.conf'));
  assert.deepStrictEqual(kitty.bg, parseHex('#101412'));
  assert.strictEqual(kitty.ansi.filter(Boolean).length, 16);

  fs.writeFileSync(path.join(dir, 'ghostty'),
    'background = #101412\nforeground = #dce3dd\n'
    + Array.from({ length: 16 }, (_, i) => `palette = ${i}=#a0b0c${i.toString(16)}`).join('\n'));
  const ghostty = readGhostty(path.join(dir, 'ghostty'));
  assert.deepStrictEqual(ghostty.fg, parseHex('#dce3dd'));
  assert.strictEqual(ghostty.ansi.filter(Boolean).length, 16);

  fs.writeFileSync(path.join(dir, 'foot.ini'),
    '[main]\nfont=x\n[colors]\nbackground=101412\nforeground=dce3dd\n'
    + Array.from({ length: 8 }, (_, i) => `regular${i}=aabb0${i}`).join('\n') + '\n'
    + Array.from({ length: 8 }, (_, i) => `bright${i}=ccdd0${i}`).join('\n'));
  const foot = readFoot(path.join(dir, 'foot.ini'));
  assert.deepStrictEqual(foot.ansi[9], parseHex('#ccdd01'));
  assert.strictEqual(foot.ansi.filter(Boolean).length, 16);

  fs.writeFileSync(path.join(dir, 'colors.json'), JSON.stringify({
    special: { background: '#101412', foreground: '#dce3dd' },
    colors: Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['color' + i, '#4477cc'])),
  }));
  const wal = readWal(path.join(dir, 'colors.json'));
  assert.deepStrictEqual(wal.bg, parseHex('#101412'));
  assert.strictEqual(wal.ansi.filter(Boolean).length, 16);

  // pi custom themes keep the same palette under "vars".
  fs.writeFileSync(path.join(dir, 'pi-theme.json'), JSON.stringify({
    name: 'x',
    vars: {
      background: '#120d08', foreground: '#d8c49a',
      selectionBackground: '#3a2c1c', selectionForeground: '#f0e2bf',
      ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['color' + i, '#96637a'])),
    },
  }));
  const pi = readWal(path.join(dir, 'pi-theme.json'));
  assert.deepStrictEqual(pi.bg, parseHex('#120d08'));
  assert.deepStrictEqual(pi.selFg, parseHex('#f0e2bf'));
  assert.strictEqual(pi.ansi.filter(Boolean).length, 16);
});

test('a real dark terminal palette becomes a valid theme', () => {
  const { css, scheme } = buildTheme(CANDLE, { id: 'victorian-study', name: 'Victorian Study' });
  assert.strictEqual(scheme, 'dark');
  const result = validateTheme(css, 'victorian-study');
  assert.strictEqual(result.valid, true, result.errors.join('\n'));
  assert.strictEqual(result.declarations['--accent-strong'], '#8f8c50');
});

test('a named OS accent stays separate from success green', () => {
  const { css } = buildTheme({ ...CANDLE, accent: parseHex('#c9822e') }, {
    id: 'victorian-study', name: 'Victorian Study',
  });
  const result = validateTheme(css, 'victorian-study');
  assert.strictEqual(result.valid, true, result.errors.join('\n'));
  assert.strictEqual(result.declarations['--accent'], '#c9822e');
  assert.strictEqual(result.declarations['--accent-strong'], '#c9822e');
  assert.strictEqual(result.declarations['--green'], '#8f8c50');
});

test('alacritty reader picks up a sibling Omarchy colors.toml accent', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'alacritty.toml'), [
    '[colors.primary]', 'background = "#120d08"', 'foreground = "#d8c49a"',
    '[colors.normal]', 'red = "#a8503c"', 'green = "#7d7a45"', 'yellow = "#c9a227"',
    'blue = "#5f7d94"', 'magenta = "#96637a"', 'cyan = "#6f8f80"',
    'black = "#120d08"', 'white = "#d8c49a"',
    '[colors.bright]', 'red = "#c05a42"', 'green = "#8f8c50"', 'yellow = "#d9b23a"',
    'blue = "#6f8da4"', 'magenta = "#a6738a"', 'cyan = "#7fa091"',
    'black = "#6e5c44"', 'white = "#f0e2bf"',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'colors.toml'), 'mode = "dark"\naccent = "#c9822e"\n');
  const palette = readAlacritty(path.join(dir, 'alacritty.toml'));
  assert.deepStrictEqual(palette.accent, parseHex('#c9822e'));
});

test('light palettes and low-contrast palettes get repaired, not rejected', () => {
  const light = {
    bg: parseHex('#fdf6e3'), fg: parseHex('#657b83'),
    // Solarized-style light palette: several accents fail 4.5:1 on paper.
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'].map(parseHex),
  };
  const { css, scheme } = buildTheme(light, { id: 'paper', name: 'Paper' });
  assert.strictEqual(scheme, 'light');
  const result = validateTheme(css, 'paper');
  assert.strictEqual(result.valid, true, result.errors.join('\n'));
  // The repaired yellow keeps its hue family but now passes contrast.
  const yellow = parseCssColor(result.declarations['--yellow'], result.declarations);
  assert.ok(contrast(yellow, parseHex('#fdf6e3')) >= 4.5);
});

test('ensureContrast moves lightness away from the background until it passes', () => {
  const fixed = ensureContrast(parseHex('#333333'), parseHex('#101412'), 4.5);
  assert.ok(contrast(fixed, parseHex('#101412')) >= 4.5);
  const fixedLight = ensureContrast(parseHex('#cccccc'), parseHex('#f5f5f5'), 4.5);
  assert.ok(contrast(fixedLight, parseHex('#f5f5f5')) >= 4.5);
});
