// Explore an agent's real screens: start it on a pseudoterminal, script keys, print what the reader makes of each moment.
// Used to discover what a profile needs (design/91). const P = require('./probe') with argv: agent cwd [args…].
const { TerminalHost } = require('../../harness/terminal/host');
const { readDocument } = require('../../harness/terminal/reader');
const { profileFor } = require('../../harness/terminal/profiles');
const { choose, waitFor, quiet } = require('../../harness/terminal/actions');
const [agent, cwd, ...args] = process.argv.slice(2);
const profile = profileFor(agent);
const bin = { claude: 'claude', pi: 'pi', codex: 'codex' }[agent];
// PROBE_RECORD=FILE.cast.gz keeps the session (recorder.js) for a replay test.
const recorder = process.env.PROBE_RECORD ? require('../../harness/terminal/recorder').createRecorder(process.env.PROBE_RECORD) : null;
const host = new TerminalHost({ command: bin, args, cwd, cols: 100, rows: 34, scrollback: 200, recorder });
const doc = () => readDocument(host.snapshot({ screenOnly: true }), profile);
const show = (label) => { const d = doc(); console.log(`--- ${label}: mode=${d.mode} box=${JSON.stringify(d.composer && d.composer.text)} ph=${JSON.stringify(d.composer && d.composer.placeholder)} status=${JSON.stringify(d.status && d.status.text)} footer=${JSON.stringify(d.footer.map(f => f.text))} menu=${d.menu ? d.menu.items.map(i => (i.selected ? '*' : '') + i.label).slice(0, 8).join(',') : ''} choice=${d.choice ? JSON.stringify(d.choice.options.map(o => o.label)) : ''} live=${d.live.length}`); return d; };
const screen = () => console.log(host.snapshot({ screenOnly: true }).lines.map((l, y) => String(y).padStart(2) + '|' + l.text).filter(l => l.length > 3).join('\n'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Ends the program and waits for the recording to be written.
const end = async () => { host.kill(); if (recorder) await recorder.close(); };
module.exports = { end, host, doc, show, screen, sleep, profile, choose, waitFor, quiet };
