# The voice-print service: only my voice

Tells the person's voice from other voices while Chattering listens
(design/102, "only my voice"). One small HTTP server around NVIDIA's
TitaNet-large speaker model (NeMo, CC-BY-4.0): audio in, a 192-number voice
embedding out. It knows nobody: Chattering keeps each person's print
(`~/.local/share/chattering/voice-prints.json`, 0600) and sends it along with
every check (`voice-speaker.js`).

Needs an environment with NeMo. On lambda the Parakeet one has it:

    CUDA_VISIBLE_DEVICES=1 ~/Projects/parakeet-stream/.venv/bin/python speaker/speaker_service.py --port 8079

Then Settings → sound → voice services → voice-print server:
`http://127.0.0.1:8079` (or `SPEAKER_URL` in the service environment), and
Settings → sound → voice commands → only my voice → Record my voice.

`chattering-speaker.service` here is a plain user unit for other machines
(`systemctl --user enable --now`). On lambda it is declared in Home Manager:
`~/Projects/os/machines/hm/chattering-speaker.nix` (deployed 2026-10-17).

Cost on an RTX 3090: ~0.35 GB of GPU memory; 6–15 ms per embedding;
a check (whole utterance plus its 1 s pieces) 15–35 ms round trip, ~90 ms
for a long one that holds two voices (then Parakeet transcribes the
person's part again, ~55 ms).

The API and the measurements are in `speaker_service.py`'s header and in
design/102.
