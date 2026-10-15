#!/usr/bin/env node
// Every Chattering icon, composed from the two traced Rockfrog shapes in
// icons/source/ (design/61):
//
//   frog on an open book   the app icon: web app, desktop launcher, tray,
//                          iOS home screen, Android launcher
//   folded-paper frog      the favicon (browser tab) and the Android
//                          notification icon — the simpler silhouette,
//                          chosen because it still reads at 16 px
//
// Ink on paper, the light theme's own colours, so the icon matches the
// app and survives an e-ink screen. The favicon follows the browser's
// light/dark setting on its own (a media query inside the SVG).
//
// Run after changing a source shape or a colour:
//   node scripts/make-icons.js
// Needs Inkscape to rasterise (nix shell nixpkgs#inkscape).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const INK = '#101412';      // --bg of the dark theme; the app's darkest ink
const PAPER = '#f2f6f3';    // --bg of the light theme
const TEXT_LIGHT = '#1b211c';
const TEXT_DARK = '#dce3dd';

function shape(file) {
  const s = fs.readFileSync(path.join(ROOT, 'icons', 'source', file), 'utf8');
  const [, , w, h] = s.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  const inner = s.match(/<g transform="[^"]+">[\s\S]*?<\/g>/)[0];
  return { w, h, inner };
}

// Place a shape centred in a box (x, y, size), as large as fits.
function place(sh, box, { fill, dy = 0 } = {}) {
  const k = Math.min(box.size / sh.w, box.size / sh.h);
  const x = box.x + (box.size - sh.w * k) / 2;
  const y = box.y + (box.size - sh.h * k) / 2 + dy * box.size;
  return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(5)})"${fill ? ` fill="${fill}"` : ''}>${sh.inner.replace(/fill="#000000"/g, '')}</g>`;
}

const svg = (body, size = 512, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${extra}\n${body}\n</svg>\n`;

const book = shape('frog-book.svg');
const folded = shape('frog-folded.svg');

// The app icon: a paper tile with rounded corners, the frog on its book
// inside a comfortable margin. Transparent outside the tile.
const appIcon = svg(`<title>Chattering, by Rockfrog</title>
<rect x="16" y="16" width="480" height="480" rx="108" fill="${PAPER}"/>
<rect x="16.5" y="16.5" width="479" height="479" rx="107.5" fill="none" stroke="${INK}" stroke-opacity=".14"/>
${place(book, { x: 92, y: 92, size: 328 }, { fill: INK, dy: -0.01 })}`);

// Maskable (Android home screen, installed web app): full bleed; the
// launcher cuts its own shape, so the frog stays inside the central 80 %
// safe circle.
const maskable = svg(`<title>Chattering, by Rockfrog</title>
<rect width="512" height="512" fill="${PAPER}"/>
${place(book, { x: 116, y: 116, size: 280 }, { fill: INK })}`);

// iOS rounds the corners itself and wants no transparency.
const apple = svg(`<rect width="512" height="512" fill="${PAPER}"/>
${place(book, { x: 96, y: 96, size: 320 }, { fill: INK })}`);

// The favicon: the bare folded frog, no tile, coloured for the tab strip.
const favicon = svg(`<title>Chattering</title>
<style>path{fill:${TEXT_LIGHT}}@media (prefers-color-scheme: dark){path{fill:${TEXT_DARK}}}</style>
${place(folded, { x: 0, y: 0, size: 64 })}`, 64);

// A PNG favicon for browsers without SVG favicons: on a small paper tile so
// it reads on a light or a dark tab strip alike.
const faviconPng = svg(`<rect width="64" height="64" rx="14" fill="${PAPER}"/>
${place(folded, { x: 7, y: 7, size: 50 }, { fill: INK })}`, 64);

// The bare frog on its book, black on transparent, cropped to the shape:
// the app paints it in the current theme's colour through a CSS mask
// (the empty-conversation mark).
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${book.w} ${book.h}"><title>Rockfrog</title>\n${book.inner}\n</svg>\n`;

// Android notification icon: white on transparent, the system tints it.
const notify = svg(place(folded, { x: 8, y: 8, size: 80 }, { fill: '#ffffff' }), 96);

const write = (rel, text) => { fs.writeFileSync(path.join(ROOT, rel), text); console.log('wrote', rel); };
write('icon.svg', appIcon);
write('icons/favicon.svg', favicon);
write('icons/mark.svg', mark);

const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chattering-icons-'));
function png(svgText, rel, size) {
  const src = path.join(tmp, 'in.svg');
  fs.writeFileSync(src, svgText);
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
  execFileSync('inkscape', [src, '--export-type=png', `--export-width=${size}`, `--export-height=${size}`, `--export-filename=${path.join(ROOT, rel)}`], { stdio: 'ignore' });
  console.log('wrote', rel, size + 'px');
}
png(appIcon, 'icons/icon-192.png', 192);
png(appIcon, 'icons/icon-512.png', 512);
png(maskable, 'icons/icon-maskable-512.png', 512);
png(apple, 'icons/apple-touch-icon.png', 180);
png(faviconPng, 'icons/favicon-32.png', 32);
const RES = 'android/app/src/main/res';
for (const [dpi, launcher, stat] of [['mdpi', 48, 24], ['hdpi', 72, 36], ['xhdpi', 96, 48], ['xxhdpi', 144, 72], ['xxxhdpi', 192, 96]]) {
  png(appIcon, `${RES}/mipmap-${dpi}/ic_launcher.png`, launcher);
  png(notify, `${RES}/drawable-${dpi}/ic_stat_rockfrog.png`, stat);
}
// The same silhouette for web notifications (the status-bar "badge" of
// Chrome on Android, design/100): served by the relay and by Chattering.
png(notify, 'anywhere/public/notification-badge.png', 96);
fs.rmSync(tmp, { recursive: true, force: true });
