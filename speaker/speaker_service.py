"""Chattering's voice-print service: "is this the person speaking?"

A small HTTP server around NVIDIA's TitaNet-large speaker model (NeMo,
CC-BY-4.0): audio in, a voice embedding out. It knows no one: Chattering
keeps each person's voice print and does the comparing (voice-speaker.js).

    POST /embed            raw PCM (16 kHz, mono, 16-bit) -> {secs, embedding, windows}
                           windows: embeddings of 3 s pieces (enrolment: their mean is
                           the print; their agreement says whether the recording was clean)
    POST /check            raw PCM, header X-Voice-Prints: base64 of float32 N×192
                           -> {secs, score, windows: [{start, end, score}]}
                           score: best cosine over the prints, whole utterance;
                           windows: 1 s pieces every 0.5 s (to split an utterance where
                           voices switch), when the audio is longer than 1.5 s
    GET  /health           -> {model, device, dim}

Run with the environment that has NeMo (on lambda the Parakeet one):

    CUDA_VISIBLE_DEVICES=1 ~/Projects/parakeet-stream/.venv/bin/python speaker_service.py --port 8079

Measured on an RTX 3090 (design/102): 6–15 ms an embedding, ~0.35 GB.
"""
import argparse, base64, json, logging, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np

logging.disable(logging.WARNING)
RATE = 16000
DIM = 192
WIN, HOP, MIN_FOR_WINDOWS = 1.0, 0.5, 1.5
ENROL_WIN = 3.0

class Model:
    def __init__(self, device):
        import torch
        from nemo.collections.asr.models import EncDecSpeakerLabelModel
        self.torch = torch
        self.device = device
        self.m = EncDecSpeakerLabelModel.from_pretrained("nvidia/speakerverification_en_titanet_large", map_location=device).eval().to(device)
        self.lock = threading.Lock()
        self.embed_many([np.zeros(RATE, np.float32)])  # warm

    def embed_many(self, clips):
        """Unit embeddings of clips of (nearly) one length, one forward pass.
        Clips of very different lengths go in separate calls: padding a batch
        to the longest costs memory for nothing."""
        torch = self.torch
        n = max(len(c) for c in clips)
        x = np.zeros((len(clips), n), np.float32)
        lens = []
        for i, c in enumerate(clips):
            x[i, :len(c)] = c; lens.append(len(c))
        with self.lock, torch.inference_mode():
            xt = torch.from_numpy(x).to(self.device)
            _, e = self.m.forward(input_signal=xt, input_signal_length=torch.tensor(lens, device=self.device))
            e = torch.nn.functional.normalize(e.float(), dim=1)
            return e.cpu().numpy()

def pcm_to_float(raw):
    if len(raw) % 2: raw = raw[:-1]
    return np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0

def pieces(n, win, hop):
    w, h = int(win * RATE), int(hop * RATE)
    if n <= w: return [(0, n)]
    starts = list(range(0, n - w + 1, h))
    if starts[-1] + w < n: starts.append(n - w)
    return [(s, s + w) for s in starts]

class Handler(BaseHTTPRequestHandler):
    model: Model = None
    def log_message(self, *a): pass
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self.rfile.read(n) if n else b''
    def do_GET(self):
        if self.path.startswith('/health'): return self._json(200, {'model': 'nvidia/speakerverification_en_titanet_large', 'device': self.model.device, 'dim': DIM})
        self._json(404, {'error': 'not found'})
    def do_POST(self):
        t0 = time.time()
        try:
            x = pcm_to_float(self._body())
            secs = len(x) / RATE
            if secs < 0.2: return self._json(400, {'error': 'too short: %.2f s' % secs})
            if self.path.startswith('/embed'):
                ps = [(s, e) for s, e in pieces(len(x), ENROL_WIN, ENROL_WIN) if e - s >= RATE]
                whole = self.model.embed_many([x[:60 * RATE]])[0]  # the first minute is plenty for one clip
                ws = self.model.embed_many([x[s:e] for s, e in ps]) if ps else np.zeros((0, DIM), np.float32)
                return self._json(200, {'secs': round(secs, 2), 'embedding': whole.round(5).tolist(), 'windows': ws.round(5).tolist(), 'ms': round((time.time() - t0) * 1000)})
            if self.path.startswith('/check'):
                raw = self.headers.get('X-Voice-Prints')
                if not raw: return self._json(400, {'error': 'X-Voice-Prints header missing'})
                prints = np.frombuffer(base64.b64decode(raw), dtype='<f4').reshape(-1, DIM)
                ps = pieces(len(x), WIN, HOP) if secs > MIN_FOR_WINDOWS else []
                whole = self.model.embed_many([x])
                es = np.concatenate([whole, self.model.embed_many([x[s:e] for s, e in ps])]) if ps else whole
                scores = es @ prints.T  # clips × prints
                best = scores.max(1)
                out = {'secs': round(secs, 2), 'score': round(float(best[0]), 4), 'ms': round((time.time() - t0) * 1000),
                       'windows': [{'start': round(s / RATE, 2), 'end': round(e / RATE, 2), 'score': round(float(v), 4)} for (s, e), v in zip(ps, best[1:])]}
                return self._json(200, out)
            self._json(404, {'error': 'not found'})
        except Exception as e:
            self._json(500, {'error': str(e)})

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1'); ap.add_argument('--port', type=int, default=8079)
    ap.add_argument('--device', default='cuda')
    a = ap.parse_args()
    t = time.time()
    Handler.model = Model(a.device)
    print(f'speaker service: TitaNet-large on {a.device}, loaded in {time.time()-t:.1f} s, http://{a.host}:{a.port}', flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()

if __name__ == '__main__':
    main()
