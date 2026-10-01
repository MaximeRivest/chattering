'use strict';
// Node after hooks run in registration order. A directory registered
// before a later SQLite handle must not be removed while that handle is
// open (Windows refuses the unlink). One hook joins all resource closes
// first; a failed close keeps the directory rather than hiding the leak.
function fixtureCleanup(t, remove) {
  const closes = [];
  t.after(async () => {
    for (const close of closes.reverse()) await close();
    await remove();
  });
  return { add: close => closes.push(close) };
}
module.exports = { fixtureCleanup };
