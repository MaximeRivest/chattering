#!/usr/bin/env node
'use strict';
// The installer a person double-clicks, from the download that
// build-release.js made on this system (design/71):
//
//   macOS    dist/Chattering-mac-<arch>.dmg: Chattering.app and a link to
//            Applications, to drag it onto. The app carries the download as
//            one archive (install/macos/Chattering unpacks it on first open).
//   Windows  dist/Chattering-Setup-<arch>.exe: a per-person Inno Setup
//            (install/windows/chattering.iss), no administrator rights.
//   Linux    nothing more: the archive and install.sh are the install.
//
// Names carry no version, so https://github.com/<repo>/releases/latest/
// download/<name> always answers with the newest. Each gets a .sha256.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const built = JSON.parse(fs.readFileSync(path.join(DIST, 'build-result.json'), 'utf8'));
const pkg = require(path.join(ROOT, 'package.json'));
const archive = built.archive;
const payload = archive.replace(/\.(tar\.gz|zip)$/, ''); // the unpacked build beside it
const arch = /-arm64\./.test(path.basename(archive)) ? 'arm64' : 'x64';
const run = (file, args, opts = {}) => execFileSync(file, args, { stdio: 'inherit', ...opts });
function checksum(file) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(file + '.sha256', `${sha}  ${path.basename(file)}\n`);
  return sha;
}

function macApp() {
  const stage = path.join(DIST, 'mac-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  const app = path.join(stage, 'Chattering.app'), contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'install', 'macos', 'Chattering'), path.join(contents, 'MacOS', 'Chattering'));
  fs.chmodSync(path.join(contents, 'MacOS', 'Chattering'), 0o755);
  fs.copyFileSync(archive, path.join(contents, 'Resources', 'chattering.tar.gz'));
  fs.writeFileSync(path.join(contents, 'Resources', 'version.txt'), pkg.version + '\n');
  // The icon, every size macOS asks for, from the 512-pixel master.
  const iconset = path.join(DIST, 'Chattering.iconset');
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset);
  const master = path.join(ROOT, 'icons', 'icon-512.png');
  for (const [name, size] of [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128], ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]]) {
    run('sips', ['-z', String(size), String(size), master, '--out', path.join(iconset, `icon_${name}.png`)], { stdio: 'ignore' });
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(contents, 'Resources', 'Chattering.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });
  const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Chattering</string>
  <key>CFBundleIconFile</key><string>Chattering</string>
  <key>CFBundleIdentifier</key><string>dev.rockfrog.chattering</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Chattering</string>
  <key>CFBundleDisplayName</key><string>Chattering</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${x(pkg.version)}</string>
  <key>CFBundleVersion</key><string>${x(pkg.version)}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Rockfrog</string>
</dict></plist>
`);
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  const dmg = path.join(DIST, `Chattering-mac-${arch}.dmg`);
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', 'Chattering', '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', dmg]);
  fs.rmSync(stage, { recursive: true, force: true });
  return dmg;
}

function winSetup() {
  const stage = path.join(DIST, 'win-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
  // Node, marked as a windowed program: the Start menu opens no console.
  const { windowed } = require('./pe-windowed.js');
  fs.writeFileSync(path.join(stage, 'Chattering.exe'), windowed(fs.readFileSync(path.join(payload, 'runtime', 'node', 'node.exe'))).buffer);
  fs.copyFileSync(path.join(ROOT, 'install', 'windows', 'open.js'), path.join(stage, 'bin', 'open.js'));
  // The commands, as install.ps1 writes them: they follow current.txt.
  for (const [cmd, entry] of [['chattering-app', 'launcher.js'], ['chattering', 'chattering']]) {
    fs.writeFileSync(path.join(stage, 'bin', cmd + '.cmd'), `@echo off\r\nsetlocal\r\nset /p V=<"%~dp0..\\current.txt"\r\n"%~dp0..\\versions\\%V%\\runtime\\node\\node.exe" "%~dp0..\\versions\\%V%\\${entry}" %*\r\n`);
  }
  const iscc = [process.env.ISCC, 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe'].find(f => f && fs.existsSync(f));
  if (!iscc) throw new Error('Inno Setup 6 (ISCC.exe) is needed to build the Windows Setup');
  const name = `Chattering-Setup-${arch}`;
  run(iscc, ['/Qp', `/DVersion=${pkg.version}`, `/DArch=${arch}`, `/DPayload=${payload}`, `/DStage=${stage}`,
    `/DIcon=${path.join(ROOT, 'icons', 'chattering.ico')}`, `/DOutDir=${DIST}`, `/DOutName=${name}`, path.join(ROOT, 'install', 'windows', 'chattering.iss')]);
  fs.rmSync(stage, { recursive: true, force: true });
  return path.join(DIST, name + '.exe');
}

const out = process.platform === 'darwin' ? macApp() : process.platform === 'win32' ? winSetup() : null;
const result = out ? { installer: out.split(path.sep).join('/'), sha256: checksum(out), bytes: fs.statSync(out).size } : { installer: null };
fs.writeFileSync(path.join(DIST, 'installer-result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
