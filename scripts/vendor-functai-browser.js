#!/usr/bin/env node
'use strict';
// Build vendor/functai-browser/<version>/: FunctAI for TypeScript, with lmcc
// and lm15's browser build, as one ES module a web page runs (design/92:
// AI programs published on the web, run with the visitor's own key in their
// own browser, or here with the owner's).
//
//   node scripts/vendor-functai-browser.js [path/to/functai]   (default: ../functai)
//
// Writes:
//   functai.mjs      the bundle (minified; FunctAI, lmcc, lm15 browser)
//   providers.json   the providers a page may call directly: their id, label,
//                    key variable, a default model and the address the
//                    browser connects to — from lm15's own registry, so the
//                    page and its Content-Security-Policy follow lm15
//   SOURCE.json      the FunctAI commit, lmcc and lm15 versions it was built from
//
// One patch, until FunctAI has a way for a runtime without files to keep
// its call log: where FunctAI would warn "no file system: calls are not
// logged", it hands the finished record (exactly the line it would have
// written) to globalThis.__functaiCallLog when a page set one. The record
// holds the request and the reply, never a key (keys travel in headers).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FUNCTAI = path.resolve(process.argv[2] || path.join(ROOT, '..', 'functai'));
const TS = path.join(FUNCTAI, 'ts');
const esbuild = require(path.join(ROOT, 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', 'esbuild'));
const git = args => { try { return execFileSync('git', ['-C', FUNCTAI, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };

if (git(['status', '--short', 'ts']) && !process.env.ALLOW_DIRTY) {
  console.error('FunctAI ts/ has uncommitted changes: commit them first (or ALLOW_DIRTY=1).');
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(TS, 'package.json'), 'utf8'));
const lm15Dir = fs.realpathSync(path.join(TS, 'node_modules', '@lm15', 'lm15'));
const lmccDir = fs.realpathSync(path.join(TS, 'node_modules', 'lmcc'));
const out = path.join(ROOT, 'vendor', 'functai-browser', pkg.version);
fs.mkdirSync(out, { recursive: true });

// The providers a page offers: those the lm15 playground offers a pasted key
// for (lm15-dev/website/src/playground/connections.ts), minus the local
// server and the judgments-only one; what each IS comes from the registry.
const OFFERED = [
  ['openai', 'OpenAI', 'gpt-4.1-mini'], ['anthropic', 'Anthropic', 'claude-haiku-4-5'], ['gemini', 'Google Gemini', 'gemini-2.5-flash'],
  ['xai', 'xAI', 'grok-4.20'], ['groq', 'Groq', 'llama-3.3-70b-versatile'], ['openrouter', 'OpenRouter', 'openai/gpt-4.1-mini'],
  ['deepseek', 'DeepSeek', 'deepseek-chat'], ['zai', 'Z.AI', 'glm-4.5'], ['moonshotai', 'Moonshot / Kimi', 'kimi-k2.5'],
  ['deepinfra', 'DeepInfra', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'], ['together', 'Together AI', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  ['fireworks', 'Fireworks AI', 'accounts/fireworks/models/deepseek-v4p1-flash'],
];

const entry = path.join(out, 'entry.mjs');
fs.writeFileSync(entry, [
  `export { fromManifest, describeSaved, withSettings, configure, capabilities, VERSION, Refusal, isRefusal } from ${JSON.stringify(path.join(TS, 'src', 'index.ts'))};`,
  `export { LMRouter, PROVIDERS } from '@lm15/lm15';`,
  '',
].join('\n'));
const patch = {
  name: 'functai-call-log-sink',
  setup(build) {
    build.onLoad({ filter: /[\\/]functai[\\/]ts[\\/]src[\\/]calllog\.ts$/ }, args => {
      let code = fs.readFileSync(args.path, 'utf8');
      const before = 'warnOnce("no-fs", "this runtime has no file system: calls are not logged");';
      if (!code.includes(before)) throw new Error('calllog.ts changed: update the call-log patch in vendor-functai-browser.js');
      code = code.replace(before, 'const sink = (globalThis as { __functaiCallLog?: (r: unknown) => void }).__functaiCallLog; if (typeof sink === "function") { try { sink(JSON.parse(line(rec))); } catch { /* a page\'s sink never breaks a call */ } } else ' + before);
      return { contents: code, loader: 'ts' };
    });
  },
};
(async () => {
  try {
    await esbuild.build({
      entryPoints: [entry], outfile: path.join(out, 'functai.mjs'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
      conditions: ['browser', 'functai-source', 'lmcc-source'], nodePaths: [path.join(TS, 'node_modules')],
      // lmcc declares "sideEffects": false but its entry imports modules for their effects.
      ignoreAnnotations: true, minify: true, legalComments: 'eof', logLevel: 'warning', plugins: [patch],
      banner: { js: `// FunctAI ${pkg.version} for TypeScript, with lmcc and lm15 (browser), bundled for Chattering by scripts/vendor-functai-browser.js. MIT licensed; see LICENSE.` },
    });
  } finally { fs.rmSync(entry, { force: true }); }
  // The providers, from the registry the bundle carries.
  const lib = await import(path.join(out, 'functai.mjs'));
  const providers = OFFERED.map(([id, label, model]) => {
    const def = lib.PROVIDERS.get(id);
    if (!def) throw new Error('lm15 has no provider ' + id);
    // The address its connector would call, asked of lm15 itself (no request is sent).
    let base = null;
    try { base = new lib.LMRouter({ apiKeys: { [id]: 'x' }, env: {} }).lm(id + ':m').base(); } catch {}
    return { id, label, model, env: (def.access && def.access.envKeys && def.access.envKeys[0]) || '', keyUrl: def.consoleUrl || null, origin: base ? new URL(base).origin : null };
  });
  const missing = providers.filter(p => !p.origin).map(p => p.id);
  if (missing.length) throw new Error('no address in the lm15 registry for: ' + missing.join(', ') + ' (look at PROVIDERS.get(id) and teach this script where it keeps it)');
  fs.writeFileSync(path.join(out, 'providers.json'), JSON.stringify(providers, null, 1) + '\n');
  const lmPkg = JSON.parse(fs.readFileSync(path.join(lm15Dir, 'package.json'), 'utf8'));
  const lmccPkg = JSON.parse(fs.readFileSync(path.join(lmccDir, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify({
    patches: ['call-log records handed to globalThis.__functaiCallLog where there is no file system (calllog.ts append)'],
    functai: { version: pkg.version, commit: git(['rev-parse', 'HEAD']), dirty: !!git(['status', '--short', 'ts']) },
    lmcc: { version: lmccPkg.version }, lm15: { version: lmPkg.version }, builtAt: new Date().toISOString(),
  }, null, 1) + '\n');
  fs.copyFileSync(path.join(FUNCTAI, 'LICENSE'), path.join(out, 'LICENSE'));
  const size = fs.statSync(path.join(out, 'functai.mjs')).size;
  console.log(`vendor/functai-browser/${pkg.version}: ${(size / 1024).toFixed(0)} KB, ${providers.length} providers`);
})().catch(e => { console.error(e.message); process.exit(1); });
