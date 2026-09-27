'use strict';
// The environment that makes `home` the home folder of a process started by
// a test, on every system: HOME for Unix, USERPROFILE for Windows (where
// Node's os.homedir() reads it and ignores HOME), and Windows' per-user
// application folders inside it, so nothing reaches the real profile.
const path = require('node:path');
function homeEnv(home) {
  return { HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    // The FunctAI call log Chattering's AI programs write to (design/74). The
    // default follows XDG_DATA_HOME, which a test inherits from the machine.
    FUNCTAI_LOG_CALLS: path.join(home, 'functai', 'calls') };
}
// What any program needs to start on this system, for tests that give a
// child an otherwise minimal environment: nothing on Unix; on Windows the
// system folder, temp folder, and executable extensions.
function systemEnv() {
  if (process.platform !== 'win32') return {};
  const out = {};
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec', 'COMSPEC', 'SystemDrive', 'ProgramFiles', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'])
    if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}
// Where a server started with homeEnv(home) keeps its config or data folder:
// the same rule it uses (platform.appDirs). Folders a test created before
// starting it (the Linux names) are where it looks; otherwise this system's.
function appDir(home, kind) { return require('../../platform.js').appDirs(homeEnv(home), home)[kind]; }
module.exports = { homeEnv, systemEnv, appDir };
