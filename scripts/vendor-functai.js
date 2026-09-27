#!/usr/bin/env node
'use strict';
// Build vendor/functai/<version>/functai.mjs: FunctAI for TypeScript, with
// lmcc and lm15, as one ES module Chattering loads with import() (design/74).
//
// FunctAI is not on npm yet, so Chattering carries a pinned build, like the
// other vendored libraries. When it is published, this becomes one line in
// runtime/package.json and this script goes.
//
//   node scripts/vendor-functai.js [path/to/functai]   (default: ../functai)
//
// Uses the esbuild that ships inside Chattering's Pi runtime (npm run runtime).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FUNCTAI = path.resolve(process.argv[2] || path.join(ROOT, '..', 'functai'));
const TS = path.join(FUNCTAI, 'ts');
const esbuild = require(path.join(ROOT, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', 'esbuild'));

const pkg = JSON.parse(fs.readFileSync(path.join(TS, 'package.json'), 'utf8'));
const lmccDir = fs.realpathSync(path.join(TS, 'node_modules', 'lmcc'));
const lm15Dir = fs.realpathSync(path.join(TS, 'node_modules', '@lm15', 'lm15'));
const version = pkg.version;
const out = path.join(ROOT, 'vendor', 'functai', version);
const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };

// FunctAI, plus the lm15 classes a router needs to answer in lm15's terms,
// from the same copy of lm15 FunctAI uses (instanceof must hold).
const entry = path.join(out, 'entry.mjs');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(entry, [
  `export * from ${JSON.stringify(path.join(TS, 'src', 'index.ts'))};`,
  `export { Message, Request, Response, streamStart, streamDelta, streamEnd, responseToEvents } from '@lm15/lm15';`,
  `export * as lmcc from 'lmcc';`,
  '',
].join('\n'));
try {
  esbuild.buildSync({
    entryPoints: [entry], outfile: path.join(out, 'functai.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node22',
    conditions: ['functai-source', 'lmcc-source'], nodePaths: [path.join(TS, 'node_modules')], legalComments: 'eof',
    // lm15's optional native lock is loaded by path at run time; never bundled.
    external: ['*.node'], logLevel: 'warning',
    // lmcc declares "sideEffects": false but its entry imports ./plan.ts and
    // ./serde.ts for their effects; honouring the flag would drop them.
    ignoreAnnotations: true,
    // lm15's one CommonJS file (the native credential lock) calls require().
    banner: { js: `// FunctAI ${version} for TypeScript, with lmcc and lm15, bundled for Chattering by scripts/vendor-functai.js. MIT licensed; see LICENSE.\nimport { createRequire as __functaiRequire } from 'node:module'; const require = __functaiRequire(import.meta.url);` },
  });
} finally { fs.rmSync(entry, { force: true }); }

// Patch (until FunctAI does it itself): FunctAI names where a program was
// defined by skipping its own frames, recognised by their path
// (/functai/ts/src/). Bundled, its frames are this file's: skip this file too,
// or every program says it was defined inside the bundle. Separators of either
// kind, for Windows.
const bundle = path.join(out, 'functai.mjs');
let code = fs.readFileSync(bundle, 'utf8');
const own = 'if (/\\/functai\\/(ts\\/)?(src|dist)\\//.test(file) || file.includes("node:")) continue;';
if (code.split(own).length !== 2) throw new Error('vendor-functai: the definedAt check changed; review the patch');
code = code.replace(own, 'if (/[\\\\/]functai[\\\\/](ts[\\\\/])?(src|dist)[\\\\/]/.test(file) || file === __functaiSelf || file.includes("node:")) continue; /* patched for Chattering */');
code = code.replace('const require = __functaiRequire(import.meta.url);', 'const require = __functaiRequire(import.meta.url); const __functaiSelf = new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, "$1");');
fs.writeFileSync(bundle, code);

const source = {
  patches: ['definedAt skips the bundle file itself and either path separator (FunctAI fn.ts)'],
  functai: { version, commit: git(FUNCTAI, ['rev-parse', 'HEAD']), dirty: !!git(FUNCTAI, ['status', '--porcelain', '--', 'ts', 'contract']) },
  lmcc: { version: JSON.parse(fs.readFileSync(path.join(lmccDir, 'package.json'), 'utf8')).version, commit: git(lmccDir, ['rev-parse', 'HEAD']) },
  lm15: { version: JSON.parse(fs.readFileSync(path.join(lm15Dir, 'package.json'), 'utf8')).version },
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify(source, null, 2) + '\n');
fs.copyFileSync(path.join(TS, 'LICENSE'), path.join(out, 'LICENSE'));
const size = fs.statSync(path.join(out, 'functai.mjs')).size;
console.log(`vendor/functai/${version}/functai.mjs: ${(size / 1024).toFixed(0)} KiB`, JSON.stringify(source));
