'use strict';
// API identities remain native paths. Match a fixture's known suffix using
// portable separators, without changing the path sent back by the UI.
function changedFile(selector, suffix) {
  return [...document.querySelectorAll(selector)].find(el =>
    (el.dataset.fileDiff || el.dataset.scCard || '').replace(/\\/g, '/').endsWith(suffix));
}
async function installChangedFiles(evaluate) {
  await evaluate(`window.scFile = ${changedFile.toString()}`);
}
module.exports = { changedFile, installChangedFiles };
