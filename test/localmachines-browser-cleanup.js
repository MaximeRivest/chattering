'use strict';
const { stopAndRemove } = require('./helpers/cleanup');

function gracefulExit(browser, ws, closeBrowser, graceMs) {
  return new Promise((resolve, reject) => {
    let settled = false, disconnected = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      browser.removeListener('exit', onExit);
      ws?.removeEventListener('close', onDisconnect);
      ws?.removeEventListener('error', onDisconnect);
      if (error) reject(error); else resolve();
    };
    const onExit = (code, signal) => finish(code === 0 && !signal ? null : new Error(`browser exited code=${code}, signal=${signal}`));
    // Chrome can drop CDP *before* normal exit. Still allow that exit within
    // the bounded window, but retain disconnect diagnostics if it never comes.
    const onDisconnect = () => { disconnected = true; };
    const timer = setTimeout(() => finish(new Error('graceful window expired' + (disconnected ? ' after CDP disconnected' : ' without browser exit'))), graceMs);
    browser.once('exit', onExit);
    ws?.addEventListener('close', onDisconnect);
    ws?.addEventListener('error', onDisconnect);
    if (!closeBrowser || ws?.readyState !== 1) return finish(new Error('CDP unavailable/disconnected'));
    try {
      // Never await the reply: a normal exit is proof even without one.
      Promise.resolve(closeBrowser()).then(reply => {
        if (reply?.error) finish(new Error('CDP Browser.close failed: ' + (reply.error.message || JSON.stringify(reply.error))));
      }, error => finish(error));
    } catch (error) { finish(error); }
  });
}

async function closeLocalBrowser({ browser, profile, ws, closeBrowser, primaryError, graceMs = 3000 }, { remove = stopAndRemove } = {}) {
  const failures = []; let graceful = false;
  if (browser.exitCode === null && browser.signalCode === null) {
    try { await gracefulExit(browser, ws, closeBrowser, graceMs); graceful = true; }
    catch (error) { failures.push(error); }
  } else if (browser.exitCode !== 0 || browser.signalCode) {
    failures.push(new Error(`browser already exited code=${browser.exitCode}, signal=${browser.signalCode}`));
  }
  try { ws?.close(); } catch (error) { failures.push(error); }
  // Always joined, including CDP errors, disconnects, and a browser hang.
  try { await remove(browser, profile); } catch (error) { failures.push(error); }
  if (browser.exitCode === null && browser.signalCode === null) failures.push(new Error('fallback returned before browser exit'));
  if (failures.length) {
    const diagnostic = 'local browser shutdown: ' + failures.map(e => e.message || String(e)).join('; ');
    const error = primaryError || new Error(diagnostic, { cause: failures[0] });
    if (primaryError) error.message += '\n' + diagnostic;
    error.cleanupDiagnostics = failures;
    throw error;
  }
  return { graceful };
}
// One failed shutdown must not prevent the other owned homes from closing.
function localMachinesCleanup(t, remove) {
  const closes = [];
  t.after(async () => {
    const failures = [];
    for (const close of closes.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    try { await remove(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'local-machine fixture cleanup failed');
  });
  return { add: close => closes.push(close) };
}
module.exports = { closeLocalBrowser, localMachinesCleanup };
