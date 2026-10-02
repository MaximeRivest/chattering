'use strict';
// Pure setup unit generator. No filesystem, systemd or installation calls.
const MAX_BYTES = (1n << 64n) - 2n; // UINT64_MAX is systemd's infinity sentinel.
const SCALE = { '': 1n, K: 1024n, M: 1024n ** 2n, G: 1024n ** 3n, T: 1024n ** 4n };

function parseLimit(value, key) {
  if (value === undefined || value === '') return null;
  const invalid = () => { throw new Error(`${key}: use positive integer bytes (optional K/M/G/T) or 0.01–100% (up to two decimal places)`); };
  // In JS, `$` can match before a final newline. Reject all whitespace so
  // even trailing line breaks cannot escape the numeric-only grammar.
  if (typeof value !== 'string' || /\s/.test(value)) return invalid();
  const percent = value.match(/^(\d+)(?:\.(\d{1,2}))?%$/);
  if (percent) {
    const amount = BigInt(percent[1]) * 100n + BigInt((percent[2] || '').padEnd(2, '0'));
    if (amount < 1n || amount > 10000n) return invalid();
    return { value, basis: 'percent', amount };
  }
  const bytes = value.match(/^(\d+)([KMGT]?)$/);
  if (!bytes) return invalid();
  const amount = BigInt(bytes[1]) * SCALE[bytes[2]];
  if (amount < 1n || amount > MAX_BYTES) return invalid();
  return { value, basis: 'bytes', amount };
}

function parseResources(env = {}) {
  const high = parseLimit(env.CHATTERING_MEMORY_HIGH, 'CHATTERING_MEMORY_HIGH');
  const max = parseLimit(env.CHATTERING_MEMORY_MAX, 'CHATTERING_MEMORY_MAX');
  if (high && max) {
    // No host probe: converting a percent to bytes would depend on the target
    // systemd manager's RAM, not necessarily the generator's machine.
    if (high.basis !== max.basis) {
      throw new Error('CHATTERING_MEMORY_HIGH and CHATTERING_MEMORY_MAX must use the same basis: both percentages or both byte sizes');
    }
    if (high.amount > max.amount) {
      throw new Error('CHATTERING_MEMORY_HIGH must not exceed CHATTERING_MEMORY_MAX');
    }
  }
  return [high && `MemoryHigh=${high.value}`, max && `MemoryMax=${max.value}`].filter(Boolean);
}

function renderUnit({ nodeBin, repo, port, home, nodeDir, winPath = '', displayLines = '' }, env = {}) {
  const resources = parseResources(env);
  return `[Unit]
Description=Chattering (by Rockfrog) — the workspace server

[Service]
ExecStart=${nodeBin} ${repo}/server.js
Environment=PORT=${port}
Environment=PATH=${home}/.local/bin:${nodeDir}:/usr/local/bin:/usr/bin:/bin${winPath}
${displayLines}
${resources.length ? resources.join('\n') + '\n' : ''}Restart=on-failure

[Install]
WantedBy=default.target
`;
}

module.exports = { parseResources, renderUnit };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') {
      parseResources(process.env);
    } else {
      if (args.length !== 7) throw new Error('Expected nodeBin repo port home nodeDir winPath displayLines, or --check');
      const [nodeBin, repo, port, home, nodeDir, winPath, displayLines] = args;
      process.stdout.write(renderUnit({ nodeBin, repo, port, home, nodeDir, winPath, displayLines }, process.env));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
