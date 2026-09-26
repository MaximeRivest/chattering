'use strict';
// The Pi package tests load: the one the app itself would use
// (pisdk-runtime.piPackageDir), unless PI_CODING_AGENT_PACKAGE names one.
// null when Pi is not installed here; tests that need it skip and say so.
const path = require('node:path');
function piPackageForTests() {
  if (process.env.PI_CODING_AGENT_PACKAGE) return path.resolve(process.env.PI_CODING_AGENT_PACKAGE);
  try { return require('../../pisdk-runtime.js').piPackageDir(); } catch { return null; }
}
module.exports = { piPackageForTests };
