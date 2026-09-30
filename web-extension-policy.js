'use strict';
// Discovery policy only: not a permission boundary. Skills, prompts, themes,
// context, settings and credentials retain Pi's normal discovery behavior.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { piAgentDir } = require('./runtime.js');
const REQUIRED_EXTENSIONS = Object.freeze(['delegation', 'records', 'modes', 'artifacts', 'image-budget']
  .map(name => path.join(__dirname, 'extensions', name + '.ts')));

function parseExtensionArgs(extraArgs = []) {
  const out = { extensionPaths: [], noExtensions: false, name: null, appendSystemPrompt: undefined, flags: new Map() };
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i];
    if (a === '--no-extensions' || a === '-ne') { out.noExtensions = true; continue; }
    if (a === '-e' || a === '--extension') {
      if (!extraArgs[i + 1] || extraArgs[i + 1].startsWith('-')) throw new Error(a + ' requires a path');
      out.extensionPaths.push(extraArgs[++i]); continue;
    }
    if (a.startsWith('--extension=')) { out.extensionPaths.push(a.slice(12)); continue; }
    if (a === '--name' || a === '-n' || a === '--append-system-prompt') {
      if (extraArgs[i + 1] === undefined) throw new Error(a + ' requires a value');
      const value = extraArgs[++i];
      if (a === '--append-system-prompt') out.appendSystemPrompt = value; else out.name = value;
      continue;
    }
    if (a === '--no-session') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) { out.flags.set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const next = extraArgs[i + 1];
      if (next !== undefined && !next.startsWith('-') && !next.startsWith('@')) { out.flags.set(a.slice(2), next); i++; }
      else out.flags.set(a.slice(2), true);
    }
  }
  return out;
}

// Provider paths must already be authorized by the caller; never discover or
// guess one here. Keep mode/context/name flags outside this fixed prefix.
function webExtensionArgs({ discovery = 'all', providerExtension } = {}) {
  if (!['all', 'minimal'].includes(discovery)) throw new Error('web extension discovery must be all or minimal');
  return [...(discovery === 'minimal' ? ['--no-extensions'] : []),
    ...REQUIRED_EXTENSIONS.flatMap(file => ['-e', file]),
    ...(providerExtension ? ['-e', providerExtension] : [])];
}

function extensionPolicyFingerprint(target, env = target.env || process.env) {
  const parsed = parseExtensionArgs(target.extraArgs);
  return createHash('sha256').update(JSON.stringify({
    cwd: path.resolve(target.cwd), agentDir: piAgentDir(env, env.HOME || undefined),
    // --name and --no-session are startup-only, not discovery policy. New
    // sessions drop --name on their first prompt without needing a rebuild.
    noExtensions: parsed.noExtensions, extensions: parsed.extensionPaths,
    flags: [...parsed.flags].sort(([a], [b]) => a.localeCompare(b)),
    appendSystemPrompt: parsed.appendSystemPrompt,
    generation: target.extensionPolicyGeneration ?? null,
  })).digest('hex');
}
function requiredExtensionError(event) {
  const file = String(event.extensionPath || '');
  return file === '<inline:workspace-checkpoints>' || REQUIRED_EXTENSIONS.includes(path.resolve(file));
}

// Sole integrator owns palette cache storage and browser state. A ticket from
// an old generation must neither populate the cache nor clear a new request.
function createPaletteGeneration() {
  let generation = 0;
  return { current: () => generation, invalidate: () => ++generation, isCurrent: ticket => ticket === generation };
}
module.exports = { REQUIRED_EXTENSIONS, parseExtensionArgs, webExtensionArgs,
  extensionPolicyFingerprint, requiredExtensionError, createPaletteGeneration };
