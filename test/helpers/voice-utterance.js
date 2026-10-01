'use strict';
// A PCM pause or a heard update is not completion: wait for publication.
function waitForUtterance(socket, text, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const finish = (error, event) => {
      clearTimeout(timer);
      socket.removeEventListener('message', message);
      if (error) reject(error); else resolve(event);
    };
    const message = m => {
      const event = JSON.parse(m.data);
      if (event.type === 'utterance' && event.text === text) finish(null, event);
    };
    const timer = setTimeout(() => finish(new Error('utterance not published: ' + text)), timeoutMs);
    socket.addEventListener('message', message);
  });
}
module.exports = { waitForUtterance };
