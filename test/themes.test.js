// Run: node --test test/
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BUILTIN_THEME_IDS,
  DEFAULT_THEME,
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
  // No choice yet means the default, Rockfrog's paper.
  assert.deepStrictEqual(manifestThemeColors('rockfrog', tokens, dir), { backgroundColor: '#f3f5f1', themeColor: '#f3f5f1' });
  assert.deepStrictEqual(manifestThemeColors('', tokens, dir), { backgroundColor: '#f3f5f1', themeColor: '#f3f5f1' });
  assert.deepStrictEqual(manifestThemeColors('rockfrog-light', tokens, dir), { backgroundColor: '#f3f5f1', themeColor: '#f3f5f1' });
  assert.deepStrictEqual(manifestThemeColors('rockfrog-dark', tokens, dir), { backgroundColor: '#101412', themeColor: '#101412' });
});

const ruleBody = (css, selector) => {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, 'no rule ' + selector);
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
};
// Capabilities live beside the tokens in tokens.css; theme files declare them as metadata.
const tokensOnly = body => body.replace(/\s*--theme-(mode|motion):[^;]*;|\s*color-scheme:[^;]*;/g, '');

test('both Rockfrog palettes pass the custom-theme validator', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  for (const [variant, scheme] of [['rockfrog-light', 'light'], ['rockfrog-dark', 'dark']]) {
    const body = ruleBody(tokens, `:root[data-theme="${variant}"]`);
    assert.match(body, new RegExp(`color-scheme: ${scheme};`));
    const css = `/* chattering-theme\nname: Rockfrog\nscheme: ${scheme}\nmode: color\nmotion: full\n*/\n:root[data-theme="check"] {${tokensOnly(body)}}`;
    assert.deepStrictEqual(validateTheme(css, 'check').errors, [], variant);
  }
  assert.ok(BUILTIN_THEME_IDS.has(DEFAULT_THEME) && DEFAULT_THEME === 'rockfrog');
});

// APCA-W3 0.1.9 (the WCAG 3 candidate): polarity-aware lightness contrast.
function apca(text, bg) {
  const Y = h => { const [r, g, b] = [1, 3, 5].map(i => (parseInt(h.slice(i, i + 2), 16) / 255) ** 2.4); return 0.2126729 * r + 0.7151522 * g + 0.0721750 * b; };
  const clamp = y => y > 0.022 ? y : y + (0.022 - y) ** 1.414;
  const t = clamp(Y(text)), b = clamp(Y(bg));
  const s = b > t ? (b ** 0.56 - t ** 0.57) * 1.14 : (b ** 0.65 - t ** 0.62) * 1.14;
  return Math.abs(s) < 0.1 ? 0 : Math.abs(s) * 100 - 2.7;
}

test('Rockfrog text stays readable by APCA, in both palettes', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  for (const variant of ['rockfrog-light', 'rockfrog-dark']) {
    const body = ruleBody(tokens, `:root[data-theme="${variant}"]`);
    const v = name => body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i'))[1];
    const lc = name => apca(v(name), v('--bg'));
    assert.ok(lc('--text') >= 88, `${variant} text Lc ${lc('--text').toFixed(0)}`);
    assert.ok(lc('--text-dim') >= 74, `${variant} secondary text Lc ${lc('--text-dim').toFixed(0)}`);
    assert.ok(lc('--text-faint') >= 58, `${variant} faint text Lc ${lc('--text-faint').toFixed(0)}`);
    const accents = ['--red', '--yellow', '--green', '--cyan', '--blue', '--magenta'].map(lc);
    assert.ok(Math.min(...accents) >= 60, `${variant} accents readable: ${accents.map(x => x.toFixed(0))}`);
    // Colored words never outshout secondary text.
    assert.ok(Math.max(...accents) <= lc('--text-dim'), `${variant} accents under secondary text`);
    if (variant === 'rockfrog-dark') {
      assert.ok(lc('--text') <= 93, 'dark text is not so bright it glows');
      assert.ok(Math.max(...accents) - Math.min(...accents) <= 3, 'dark accents share one lightness');
      assert.ok(lc('--border') >= 13, 'dark borders stay visible without shadows');
    }
  }
});

test('Rockfrog following a dark system shows exactly Rockfrog dark', () => {
  const tokens = fs.readFileSync(path.join(ROOT, 'design', 'tokens.css'), 'utf8');
  const dark = ruleBody(tokens, ':root[data-theme="rockfrog-dark"]');
  const media = tokens.slice(tokens.indexOf('@media (prefers-color-scheme: dark)'));
  const following = ruleBody(media, ':root[data-theme="rockfrog"]');
  const lines = body => body.split('\n').map(l => l.trim()).filter(Boolean);
  assert.deepStrictEqual(lines(following), lines(dark));
  // The light palette is the same rule for `rockfrog` and `rockfrog-light`.
  assert.match(tokens, /:root\[data-theme="rockfrog"\],\s*:root\[data-theme="rockfrog-light"\] \{/);
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
