'use strict';
// voice-vad.js — the listener's voice-activity model, run here in plain
// JavaScript: no native module, no GPU. For each 100 ms frame of 16 kHz
// 16-bit PCM it says how likely the frame is Maxime's speech, a pause (his
// channel's own quiet) or noise (a machine, other voices).
//
// The network is tiny (34k weights, trained in ~/Projects/myvoice,
// myvoice/vad/): a log-mel front end (10 windows of 25 ms per frame, 32 mel
// bands), two small convolutions, a GRU that carries context from frame to
// frame, three outputs. The weights file holds the filterbank too, so the
// numbers here equal the training side's exactly (checked in
// test/voice-vad.test.js against the reference output saved with the
// weights). Cost: about 150k multiply-adds and ten 512-point FFTs per frame,
// well under a millisecond on one core.
//
// Why not Silero VAD directly: it would need onnxruntime-node, a native
// module Chattering's runtime does not ship; this model is distilled from
// Silero's labels on his own recordings, with the wood mill and other noise
// mixed in, and measured against it (design/102).

const fs = require('fs');
const path = require('path');

const RATE = 16000;
const FRAME = 1600;

class Fft {
  // Real-input radix-2 FFT of size n (a power of two), in place on
  // preallocated arrays: the hot path allocates nothing.
  constructor(n) {
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }
  /** Power spectrum (n/2 + 1 bins) of `x` (length ≤ n, zero-padded), into `out`. */
  power(x, out) {
    const { n, re, im, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) { const j = rev[i]; re[i] = j < x.length ? x[j] : 0; im[i] = 0; }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k, b = a + half;
          const tr = re[b] * cos[t] - im[b] * sin[t], ti = re[b] * sin[t] + im[b] * cos[t];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }
}

class VoiceVad {
  /** @param {object|string} weights  the weights object, or a path to its JSON */
  constructor(weights) {
    const W = typeof weights === 'string' ? JSON.parse(fs.readFileSync(weights, 'utf8')) : weights;
    if (!W || W.format !== 'myvoice-tiny-vad-1') throw new Error('voice-vad: unknown weights format');
    const fe = W.frontend;
    this.classes = W.classes;
    this.win = fe.win; this.hop = fe.hop; this.nfft = fe.nfft; this.nMels = fe.n_mels; this.logFloor = fe.log_floor;
    this.mean = fe.mean; this.scale = fe.scale;
    this.steps = FRAME / this.hop;
    this.fb = fe.filterbank.map(r => Float32Array.from(r));     // nMels × (nfft/2+1), sparse rows
    this.fbRange = this.fb.map(r => { let a = 0; while (a < r.length && r[a] === 0) a++; let b = r.length; while (b > a && r[b - 1] === 0) b--; return [a, b]; });
    this.hann = new Float32Array(this.win);
    for (let i = 0; i < this.win; i++) this.hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.win);
    this.fft = new Fft(this.nfft);
    const f32 = a => Float32Array.from(a.flat(Infinity));
    this.c1w = f32(W.conv1.w); this.c1b = Float32Array.from(W.conv1.b); this.c1 = W.conv1.w.length;
    this.c2w = f32(W.conv2.w); this.c2b = Float32Array.from(W.conv2.b); this.c2 = W.conv2.w.length;
    this.fcw = f32(W.fc.w); this.fcb = Float32Array.from(W.fc.b); this.fcN = W.fc.w.length;
    this.wih = f32(W.gru.w_ih); this.whh = f32(W.gru.w_hh); this.bih = Float32Array.from(W.gru.b_ih); this.bhh = Float32Array.from(W.gru.b_hh);
    this.H = W.gru.w_hh[0].length;
    this.ow = f32(W.out.w); this.ob = Float32Array.from(W.out.b); this.nOut = W.out.w.length;
    // Work buffers.
    this.sig = new Float32Array(FRAME + this.win - this.hop);   // this frame, then the first win-hop samples of the next (zero: not known yet)
    this.spec = new Float32Array(this.nfft / 2 + 1);
    this.frameWin = new Float32Array(this.win);
    this.mel = new Float32Array(this.steps * this.nMels);
    this.a1 = new Float32Array(this.c1 * this.steps * this.nMels);
    this.p1 = new Float32Array(this.c1 * (this.steps / 2) * (this.nMels / 2));
    this.a2 = new Float32Array(this.c2 * (this.steps / 2) * (this.nMels / 2));
    this.p2 = new Float32Array(this.c2 * (this.steps / 2) * (this.nMels / 4));
    this.f = new Float32Array(this.fcN);
    this.h = new Float32Array(this.H);
    this.gi = new Float32Array(3 * this.H); this.gh = new Float32Array(3 * this.H);
    this.logits = new Float32Array(this.nOut);
    this.probs = new Float32Array(this.nOut);
  }

  reset() { this.h.fill(0); }

  /** Log-mel of one frame of 1600 int16 samples (Buffer or Int16Array), into this.mel. */
  features(pcm, offset = 0) {
    const sig = this.sig; sig.fill(0);
    if (Buffer.isBuffer(pcm)) for (let i = 0; i < FRAME; i++) sig[i] = pcm.readInt16LE(offset + i * 2) / 32768;
    else for (let i = 0; i < FRAME; i++) sig[i] = pcm[offset + i] / 32768;
    const { win, hop, hann, spec, frameWin, fb, fbRange, nMels, mel } = this;
    for (let s = 0; s < this.steps; s++) {
      const at = s * hop;
      for (let i = 0; i < win; i++) frameWin[i] = sig[at + i] * hann[i];
      this.fft.power(frameWin, spec);
      for (let m = 0; m < nMels; m++) {
        const row = fb[m], [a, b] = fbRange[m];
        let e = 0;
        for (let k = a; k < b; k++) e += row[k] * spec[k];
        mel[s * nMels + m] = Math.log(e + this.logFloor);
      }
    }
    return mel;
  }

  // 3×3 "same" convolution over (cin, hh, ww) → (cout, hh, ww) with ReLU.
  conv(x, cin, hh, ww, w, b, cout, out) {
    for (let o = 0; o < cout; o++) {
      for (let i = 0; i < hh; i++) {
        for (let j = 0; j < ww; j++) {
          let s = b[o];
          for (let c = 0; c < cin; c++) {
            const xb = c * hh * ww, wb = (o * cin + c) * 9;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di; if (ii < 0 || ii >= hh) continue;
              for (let dj = -1; dj <= 1; dj++) {
                const jj = j + dj; if (jj < 0 || jj >= ww) continue;
                s += w[wb + (di + 1) * 3 + (dj + 1)] * x[xb + ii * ww + jj];
              }
            }
          }
          out[(o * hh + i) * ww + j] = s > 0 ? s : 0;
        }
      }
    }
  }
  pool(x, c, hh, ww, ph, pw, out) {
    const oh = hh / ph, ow = ww / pw;
    for (let k = 0; k < c; k++) for (let i = 0; i < oh; i++) for (let j = 0; j < ow; j++) {
      let m = -Infinity;
      for (let a = 0; a < ph; a++) for (let b = 0; b < pw; b++) { const v = x[(k * hh + i * ph + a) * ww + j * pw + b]; if (v > m) m = v; }
      out[(k * oh + i) * ow + j] = m;
    }
  }

  /**
   * One 100 ms frame in; the class probabilities out ({speech, pause,
   * noise}, Float32Array in `this.probs`, and `speech` as a number). State
   * carries to the next frame.
   */
  step(pcm, offset = 0) {
    const mel = this.features(pcm, offset);
    for (let i = 0; i < mel.length; i++) mel[i] = (mel[i] - this.mean) * this.scale;
    const S = this.steps, M = this.nMels;
    this.conv(mel, 1, S, M, this.c1w, this.c1b, this.c1, this.a1);
    this.pool(this.a1, this.c1, S, M, 2, 2, this.p1);
    this.conv(this.p1, this.c1, S / 2, M / 2, this.c2w, this.c2b, this.c2, this.a2);
    this.pool(this.a2, this.c2, S / 2, M / 2, 1, 2, this.p2);
    const { f, fcw, fcb, fcN, p2, H, h, gi, gh, wih, whh, bih, bhh } = this;
    const n2 = p2.length;
    for (let o = 0; o < fcN; o++) { let s = fcb[o]; const wb = o * n2; for (let k = 0; k < n2; k++) s += fcw[wb + k] * p2[k]; f[o] = s > 0 ? s : 0; }
    for (let o = 0; o < 3 * H; o++) {
      let s = bih[o]; const wb = o * fcN; for (let k = 0; k < fcN; k++) s += wih[wb + k] * f[k]; gi[o] = s;
      let t = bhh[o]; const vb = o * H; for (let k = 0; k < H; k++) t += whh[vb + k] * h[k]; gh[o] = t;
    }
    for (let k = 0; k < H; k++) {
      const r = 1 / (1 + Math.exp(-(gi[k] + gh[k])));
      const z = 1 / (1 + Math.exp(-(gi[H + k] + gh[H + k])));
      const n = Math.tanh(gi[2 * H + k] + r * gh[2 * H + k]);
      h[k] = (1 - z) * n + z * h[k];
    }
    const { logits, probs, ow, ob, nOut } = this;
    let max = -Infinity;
    for (let o = 0; o < nOut; o++) { let s = ob[o]; const wb = o * H; for (let k = 0; k < H; k++) s += ow[wb + k] * h[k]; logits[o] = s; if (s > max) max = s; }
    let sum = 0;
    for (let o = 0; o < nOut; o++) { probs[o] = Math.exp(logits[o] - max); sum += probs[o]; }
    for (let o = 0; o < nOut; o++) probs[o] /= sum;
    return probs[0];
  }

  /** Every frame of a PCM buffer, from a fresh state: [{speech, pause, noise}]. */
  run(pcm) {
    this.reset();
    const out = [];
    for (let at = 0; at + FRAME * 2 <= pcm.length; at += FRAME * 2) {
      this.step(pcm, at);
      out.push({ speech: this.probs[0], pause: this.probs[1], noise: this.probs[2] });
    }
    return out;
  }
}

const DEFAULT_WEIGHTS = path.join(__dirname, 'models', 'voice-vad.json');

module.exports = { VoiceVad, Fft, DEFAULT_WEIGHTS, FRAME, RATE };
