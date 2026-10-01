'use strict';
// Fixture commands model a shell, not direct tool arguments. Unquoted
// Windows separators escape the next character; spaces split the path.
const shellPath = file => "'" + String(file).replace(/'/g, "'\\''") + "'";
module.exports = { shellPath };
