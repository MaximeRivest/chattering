'use strict';
// Chattering.exe runs this: the Start menu entry, the desktop icon, the end of
// Setup, the sign-in start (design/71). Chattering.exe is Node marked as a
// windowed program, so nothing flashes on screen; it starts the current
// version's launcher hidden and waits. If the launcher fails, the person
// sees why in a message box, not a console that closes before it can be read.
//
//   Chattering.exe open.js          open Chattering (start it if needed)
//   Chattering.exe open.js start    start it without a window (sign-in)
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const home = path.join(__dirname, '..');
function tell(message) {
  // Windows Forms by its assembly name: no cmdlet, so no module scan (processes.js).
  const script = "[void][Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [void][System.Windows.Forms.MessageBox]::Show($env:CHATTERING_MESSAGE, 'Chattering')";
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, CHATTERING_MESSAGE: message } });
}
let version;
try { version = fs.readFileSync(path.join(home, 'current.txt'), 'utf8').trim(); }
catch { tell('Chattering is not installed correctly (no current.txt in ' + home + '). Run its Setup again.'); process.exit(1); }
const dir = path.join(home, 'versions', version);
const args = process.argv.slice(2);
const child = spawn(path.join(dir, 'runtime', 'node', 'node.exe'), [path.join(dir, 'launcher.js'), ...(args.length ? args : ['open'])], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let err = '';
child.stderr.on('data', d => { err = (err + d).slice(-3000); });
child.on('error', e => { tell('Chattering could not start: ' + e.message); process.exit(1); });
child.on('exit', code => {
  if (code) tell('Chattering could not start.\n\n' + (err.trim() || 'The launcher stopped with code ' + code + '.'));
  process.exit(code || 0);
});
