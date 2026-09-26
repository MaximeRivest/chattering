#!/usr/bin/env node
'use strict';
// Build the Chattering download for the system this runs on (design/71):
//
//   dist/chattering-<version>-<linux|macos|win>-<x64|arm64>/
//     the app (what git tracks, minus tests, design notes and platform
//       helpers that do not ship), its vendored browser libraries,
//     runtime/node/…        this Node (the pinned .node-version), whole
//     runtime/node_modules/ Pi and its dependencies, exactly as locked
//     BUILD.json            version, commit, Node, Pi, when, for what
//     THIRD_PARTY.md        the licenses of what ships beside the app
//   dist/<name>.tar.gz (.zip on Windows) and <name>.sha256
//
// Run on each system (CI does): Pi's dependencies carry native parts
// (esbuild) that npm picks for the system it installs on.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const pinned = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
const osName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
if (!osName || !arch) throw new Error('no download is built for ' + process.platform + '/' + process.arch);
if (process.version !== 'v' + pinned && !process.env.CHATTERING_BUILD_ANY_NODE) throw new Error(`build with Node ${pinned} (.node-version), not ${process.version}: the download ships the Node that builds it`);

const name = `chattering-${pkg.version}-${osName}-${arch}`;
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, name);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- the app: tracked files, minus what does not ship ----
const SKIP = [/^test\//, /^android\//, /^manual-test\//, /^scratch\//, /^semantic\//, /^windows\//, /^\.github\//, /^scripts\//,
  /^design\/.*\.(md|html)$/, /^TODO\.md$/, /^(setup|update|tray|open)\.sh$/, /^\.gitignore$/, /^runtime\/node_modules\//, /\.apk$/];
const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean).filter(f => !SKIP.some(r => r.test(f)));
for (const f of files) {
  const from = path.join(ROOT, f), to = path.join(OUT, f);
  if (!fs.existsSync(from)) continue; // deleted in the working tree
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ---- Pi, exactly as locked ----
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const ci = spawnSync(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund', '--prefix', path.join(OUT, 'runtime')], { stdio: 'inherit', shell: process.platform === 'win32' });
if (ci.status !== 0) throw new Error('npm ci failed');

// Pi's bundled npm-shrinkwrap installs esbuild's binary for every system
// (26 of them, 280 MB). esbuild loads @esbuild/<platform>-<arch> at run
// time: keep that one only.
const keepEsbuild = `${process.platform}-${process.arch}`;
const pruneEsbuild = dir => {
  for (const base of [path.join(dir, 'node_modules', '@esbuild')]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) if (n !== keepEsbuild) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  }
};
pruneEsbuild(path.join(OUT, 'runtime'));
pruneEsbuild(path.join(OUT, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent'));
if (!fs.existsSync(path.join(OUT, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@esbuild', keepEsbuild))
  && !fs.existsSync(path.join(OUT, 'runtime', 'node_modules', '@esbuild', keepEsbuild))) throw new Error('esbuild has no binary for ' + keepEsbuild);

// ---- Node ----
const nodeDest = process.platform === 'win32' ? path.join(OUT, 'runtime', 'node', 'node.exe') : path.join(OUT, 'runtime', 'node', 'bin', 'node');
fs.mkdirSync(path.dirname(nodeDest), { recursive: true });
fs.copyFileSync(process.execPath, nodeDest);
fs.chmodSync(nodeDest, 0o755);
const nodeLicense = [path.join(path.dirname(process.execPath), 'LICENSE'), path.join(path.dirname(process.execPath), '..', 'LICENSE')].find(f => fs.existsSync(f));
if (nodeLicense) fs.copyFileSync(nodeLicense, path.join(OUT, 'runtime', 'node', 'LICENSE'));

// ---- what it is ----
const piPkg = require(path.join(OUT, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'));
let commit = null;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch {}
fs.writeFileSync(path.join(OUT, 'BUILD.json'), JSON.stringify({ version: pkg.version, commit, os: osName, arch, node: process.version, pi: piPkg.version, builtAt: new Date().toISOString() }, null, 2) + '\n');

// ---- licenses of what ships beside the app ----
const notices = ['# Third-party software in this download', '', `Node.js ${process.version}: MIT license and its bundled components (runtime/node/LICENSE).`, ''];
const walk = dir => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(p); continue; }
    const j = (() => { try { return JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')); } catch { return null; } })();
    if (j && j.name) notices.push(`- ${j.name} ${j.version || ''}: ${typeof j.license === 'string' ? j.license : (j.license && j.license.type) || 'see its package'}`);
    walk(path.join(p, 'node_modules'));
  }
};
walk(path.join(OUT, 'runtime', 'node_modules'));
notices.push('', 'Browser libraries in vendor/ carry their licenses in their folders. Chattering itself: LICENSE (Apache-2.0).', '');
fs.writeFileSync(path.join(OUT, 'THIRD_PARTY.md'), notices.join('\n'));

// ---- the archive and its checksum ----
const archive = path.join(DIST, name + (process.platform === 'win32' ? '.zip' : '.tar.gz'));
fs.rmSync(archive, { force: true });
// bsdtar (macOS, Windows 10+) writes zip with -a; GNU tar writes tar.gz.
const tarArgs = process.platform === 'win32' ? ['-a', '-cf', archive, '-C', DIST, name] : ['-czf', archive, '-C', DIST, name];
// On Windows, Windows' own tar.exe (bsdtar, writes zip); another tar earlier on
// PATH (Git's GNU tar) would write a tar file named .zip.
const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const t = spawnSync(tarBin, tarArgs, { stdio: 'inherit' });
if (t.status !== 0) throw new Error('tar failed');
const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(archive + '.sha256', `${sha}  ${path.basename(archive)}\n`);
const result = { archive, sha256: sha, bytes: fs.statSync(archive).size, files: files.length, pi: piPkg.version, node: process.version };
fs.writeFileSync(path.join(DIST, 'build-result.json'), JSON.stringify(result, null, 2) + '\n'); // for CI
console.log(JSON.stringify(result));
