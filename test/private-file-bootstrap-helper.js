'use strict';
// Capture the real production dispatch; native controls reuse its compiler
// prefix rather than maintaining a second (potentially warmer) bootstrap.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const production = require.resolve('../private-file');
function capture(operation = 'read', file = path.resolve('synthetic key'), bytes = 'synthetic bytes', dispatch) {
  let call;
  const context = { module: { exports: {} }, __dirname: path.dirname(production), Buffer,
    process: { platform: 'win32', env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } },
    require(name) {
      if (name === 'node:fs') return { ...fs, mkdirSync() {} };
      if (name === 'node:child_process') return { execFileSync(exe, args, options) {
        call = { exe, args, options, script: Buffer.from(args.at(-1), 'base64').toString('utf16le') };
        return dispatch ? dispatch(call) : operation === 'read' ? 'ABSENT' : 'OK';
      } };
      return require(name);
    } };
  vm.runInNewContext(fs.readFileSync(production, 'utf8'), context);
  context.module.exports[operation + 'PrivateFileSync'](file, bytes);
  return call;
}
function nativeRequest(file, body, extra = {}) {
  const call = capture('read', file);
  const marker = '$file = $request.file; try {';
  const boundary = call.script.indexOf(marker);
  if (boundary < 0) throw new Error('Production dispatch boundary unavailable');
  const script = call.script.slice(0, boundary) + '$file = $request.file; ' + body;
  return { exe: call.exe, args: [...call.args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
    options: { ...call.options, input: JSON.stringify({ ...JSON.parse(call.options.input), ...extra }) } };
}
module.exports = { capture, nativeRequest };
