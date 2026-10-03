# The frog (Chattering's mascot, design/93)

A felt-plush humanoid frog with a purple cape and a little spellbook (the
logo's frog sits on an open book). It appears beside selected text and
casts the person's programs as spells.

- `cut/` — the masters: 1024 px, transparent. Poses: `idle`, `blink`
  (idle with the eyes closed, pasted onto idle so a swap does not move
  anything), `base-gpt` (waving hello), `cast` (book open, sparkles),
  `happy` (done), `puzzled` (nothing selected, an error).
- `web/` — the same, cropped to one box (so a pose swap never jumps) and
  300 px tall WebP, about 11 KB each.
- `demo/` — the interaction, in a page: the frog in the margin by the end
  of the selection, the spell book under it, the answer with its changed
  words marked, Enter to replace.
- `gen.py MODEL OUT.png "PROMPT" [REF.png]` — how they were made:
  OpenRouter, `openai/gpt-5.4-image-2`, each pose with the first frog as
  its reference so it stays one character. About $0.23 an image.
- `shoot.js CHROMIUM URL DIR [dark]` — the demo driven headless (select,
  frog, spells, cast, answer, replace) with screenshots.

Background removal: a flood fill of the white from the corners (fuzz 7 %),
the alpha eroded by a pixel and softened, then the pale floor shadow under
the feet taken out (near-white pixels in the bottom fifth).
