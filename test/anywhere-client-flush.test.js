'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../anywhere/client.js');

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

for (const reason of ['abort', 'connection failure']) {
  test(`Given two buffered ICE candidates, When ${reason} occurs during candidate one, Then candidate two never reaches the closed peer`, { timeout: 5000 }, async t => {
    const entered = deferred(), release = deferred();
    const abort = new AbortController();
    const applied = [];
    let peer, socket;
    // Only platform I/O is synthetic; the actual Client.connect owns buffering,
    // awaited flush, terminal errors and closing. No home/key fixture is involved.
    class Peer {
      constructor() { peer = this; this.closed = false; }
      createDataChannel() { return {}; }
      async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
      async setLocalDescription(sdp) { this.localDescription = sdp; }
      async setRemoteDescription(sdp) { this.remoteDescription = sdp; }
      async addIceCandidate(candidate) {
        applied.push({ id: candidate.candidate, closed: this.closed });
        if (candidate.candidate === 'one') {
          entered.resolve();
          await release.promise;
        }
        if (this.closed) throw new Error('candidate on closed peer');
      }
      close() { this.closed = true; }
    }
    class Socket {
      constructor() { socket = this; queueMicrotask(() => this.onopen()); }
      emit(message) { this.onmessage({ data: JSON.stringify(message) }); }
      send(text) {
        const message = JSON.parse(text);
        if (message.t === 'call') this.emit({ t: 'ice', servers: [] });
        else if (message.data?.sdp) {
          // Both candidates are queued before remote SDP starts the flush.
          for (const candidate of ['one', 'two']) this.emit({ t: 'signal', data: { candidate: { candidate, sdpMid: '0' } } });
          this.emit({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'fixture-answer' } } });
        }
      }
      close() { this.closed = true; }
    }
    const connecting = Client.connect({ relay: 'http://fixture.invalid', homeId: 'fixture',
      RTCPeerConnection: Peer, WebSocket: Socket, signal: abort.signal });
    // Observe rejection immediately so intentionally failing RED checks do not
    // leave an unhandled rejection or a live timeout behind.
    const outcome = connecting.then(() => ({ connected: true }), error => ({ error }));
    t.after(() => { abort.abort(); release.resolve(); });
    await entered.promise;
    assert.deepEqual(applied, [{ id: 'one', closed: false }], 'candidate one is suspended inside the real flush');
    if (reason === 'abort') abort.abort();
    else { peer.connectionState = 'failed'; peer.onconnectionstatechange(); }
    const { error } = await outcome;
    assert.equal(error?.code, reason === 'abort' ? 'aborted' : 'failed');
    assert.equal(error?.message, reason === 'abort' ? 'stopped' : 'no network path to your computer');
    assert.equal(peer.closed, true);
    assert.equal(socket.closed, true);
    release.resolve();
    // Drain the finite promise chain after releasing candidate one. This is an
    // event-loop checkpoint, not an elapsed-time assumption about readiness.
    await new Promise(setImmediate);
    assert.deepEqual(applied, [{ id: 'one', closed: false }], 'no buffered application after close, even when candidate one rejects');
  });
}
