// Run: node --test test/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REQUIRED_COLOR_TOKENS,
  bundleCustomThemes,
  manifestThemeColors,
  readCustomThemes,
  validateTheme,
} = require('../themes.js');

const ROOT = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(ROOT, 'design', 'theme-template.css'), 'utf8');

test('custom theme template passes the full validator', () => {
  const result = validateTheme(template, 'theme-template');
  assert.strictEqual(result.valid, true, result.errors.join('\n'));
  for (const token of REQUIRED_COLOR_TOKENS) assert.ok(result.declarations[token], token);
});

test('themes accept the shared shape scale and independent semantic radii', () => {
  const square = validateTheme(template.replace('--roundness: 1;', '--roundness: 0;'), 'theme-template');
  assert.equal(square.valid, true, square.errors.join('\n'));
  assert.equal(square.declarations['--roundness'], '0');
  const override = validateTheme(template.replace('--roundness: 1;', '--roundness: 0.5; --r-dialog: 20px; --r-menu: 12px;'), 'theme-template');
  assert.equal(override.valid, true, override.errors.join('\n'));
  assert.equal(override.declarations['--r-dialog'], '20px');
});

test('validator rejects missing tokens, unsafe CSS, and weak contrast', () => {
  const missing = template.replace(/\s*--ansi-15:[^;]+;/, '');
  assert.match(validateTheme(missing, 'theme-template').errors.join('\n'), /missing required token --ansi-15/);

  const unsafe = template.replace('--ink: #c0392b;', '--ink: url(https://example.test/ink);');
  assert.match(validateTheme(unsafe, 'theme-template').errors.join('\n'), /unsafe value for --ink/);

  const weak = template.replace('--text: #dce3dd;', '--text: #202522;');
  assert.match(validateTheme(weak, 'theme-template').errors.join('\n'), /--text on --bg/);
});

test('validator rejects values that escape the token rule', () => {
  // A brace in any value (even an optional extra token) must fail: it would
  // break out of the :root rule and inject arbitrary CSS into the bundle.
  const brace = template.replace('--ink-halo: #ffffff;',
    '--ink-halo: #ffffff;\n  --extra: red } body { display: none } :root[data-theme="x"] { --y: 1;');
  const result = validateTheme(brace, 'theme-template');
  assert.strictEqual(result.valid, false);
  assert.match(result.errors.join('\n'), /unsafe value for --extra/);

  // An unclosed comment marker would swallow the CSS that follows the bundle.
  const comment = template.replace('--ink-halo: #ffffff;', '--ink-halo: #ffffff;\n  --extra: red /* x;');
  assert.match(validateTheme(comment, 'theme-template').errors.join('\n'), /unsafe value for --extra/);
});

test('theme catalog serves only valid theme files', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-themes-')));
  fs.writeFileSync(path.join(dir, 'theme-template.css'), template);
  fs.writeFileSync(path.join(dir, 'broken.css'), 'not css');
  const catalog = readCustomThemes(dir);
  assert.deepStrictEqual(catalog.valid.map(theme => theme.id), ['theme-template']);
  assert.deepStrictEqual(catalog.invalid.map(theme => theme.id), ['broken']);
  const bundle = bundleCustomThemes(dir);
  assert.match(bundle, /data-theme="theme-template"/);
  assert.match(bundle, /--theme-mode: color/);
  assert.doesNotMatch(bundle, /data-theme="broken"/);
});

test('manifest colors follow built-in and custom theme backgrounds', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-manifest-themes-')));
  fs.writeFileSync(path.join(dir, 'theme-template.css'), template);
  const tokens = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  assert.deepStrictEqual(manifestThemeColors('dark', tokens, dir), { backgroundColor: '#101412', themeColor: '#101412' });
  assert.deepStrictEqual(manifestThemeColors('light', tokens, dir), { backgroundColor: '#f2f6f3', themeColor: '#f2f6f3' });
  assert.deepStrictEqual(manifestThemeColors('theme-template', tokens, dir), { backgroundColor: '#101412', themeColor: '#101412' });
});

test('tokens.css is the only core token source used by app.html', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const tokens = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  assert.match(app, /<link rel="stylesheet" href="\/tokens\.css">/);
  assert.doesNotMatch(app, /\/\* ---- design tokens/);
  assert.doesNotMatch(app, /data-theme="eink"/);
  assert.doesNotMatch(app, /#[0-9a-f]{3,8}\b/i);
  for (const token of REQUIRED_COLOR_TOKENS) assert.match(tokens, new RegExp(`${token.replaceAll('-', '\\-')}\\s*:`));
});
