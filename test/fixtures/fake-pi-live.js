// Pi's stand-in for live-terminal tests (fake-terminal-agent.js drawing as
// Pi). Kept beside the other fixtures so it is inside the Chattering
// folder, which a guest's walls bind read-only: it runs inside them too.
if (process.argv.includes('--list-models')) process.exit(0);
process.env.FAKE_AGENT_STYLE = 'pi';
require('./fake-terminal-agent.js');
