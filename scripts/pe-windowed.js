'use strict';
// A copy of a Windows console program that Windows starts without a console
// window: its PE header's subsystem set to "windows GUI" (the technique of
// nodew and create-nodew-exe). The copy's Authenticode signature is removed
// rather than left broken, since the header it covered changed: the copy is
// plainly unsigned. Used for Chattering.exe (install/windows/open.js).
//
//   node scripts/pe-windowed.js <node.exe> <Chattering.exe>
const fs = require('fs');

function windowed(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a Windows program (no MZ header)');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('not a Windows program (no PE signature)');
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('unknown optional header ' + magic.toString(16));
  const out = Buffer.from(buf);
  const SUBSYSTEM = opt + 68, CHECKSUM = opt + 64;
  const was = out.readUInt16LE(SUBSYSTEM);
  if (was !== 3 && was !== 2) throw new Error('unexpected subsystem ' + was);
  out.writeUInt16LE(2, SUBSYSTEM); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  out.writeUInt32LE(0, CHECKSUM);
  // Data directory 4, the certificate table: at the end of the file by rule.
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const certAt = out.readUInt32LE(dirs + 4 * 8), certSize = out.readUInt32LE(dirs + 4 * 8 + 4);
  out.writeUInt32LE(0, dirs + 4 * 8); out.writeUInt32LE(0, dirs + 4 * 8 + 4);
  const end = certAt && certSize && certAt + certSize >= out.length - 8 ? certAt : out.length;
  return { buffer: out.subarray(0, end), was, strippedSignature: end < out.length };
}

if (require.main === module) {
  const [from, to] = process.argv.slice(2);
  const r = windowed(fs.readFileSync(from));
  fs.writeFileSync(to, r.buffer);
  console.log(JSON.stringify({ to, subsystemWas: r.was, strippedSignature: r.strippedSignature, bytes: r.buffer.length }));
}
module.exports = { windowed };
