# The frog (Chattering's mascot, design/93)

A small, friendly magical creature in the style of the wizarding-film
beasts: a mossy frog with glowing gold star freckles, a clover sprout and an
old leather spellbook (the logo's frog sits on an open book). It appears beside selected text and
casts the person's programs as spells.

- `cut/` — the masters: 1024 px, transparent. Poses: `idle` (hugging its
  book), `blink` (idle with the eyes closed, pasted onto idle so a swap does
  not move anything), `wave` (hello), `cast` (the book floating open, gold
  stars), `happy` (done), `puzzled` (nothing selected, an error).
- `web/` — the same, all in one frame (so a pose swap never jumps), 320 px
  tall WebP, 13–25 KB each.
- `demo/` — the interaction, in a page: the frog in the margin by the end
  of the selection, the spell book under it, the answer with its changed
  words marked, Enter to replace. Parchment by day, candlelight by night.
- `prompts/creature.md` — what the image model was asked, pose by pose.
- `gen.py MODEL OUT.png "PROMPT" [REF.png]` — OpenRouter image generation
  (`openai/gpt-5.4-image-2`, about $0.23 an image).
- `cutout.py IN.png OUT.png` — the white background taken out while the
  gold dust stays: the creature is the large dark solid thing, the rest is
  "un-mixed" from white so sparkles glow on any background with no halo;
  background an arm closes in is cut, an eye's glint is kept. Needs numpy,
  pillow and scipy: `nix shell --impure --expr 'with import (builtins.getFlake
  "nixpkgs") {}; python3.withPackages (p: [ p.numpy p.pillow p.scipy ])'`.
- `shoot.js CHROMIUM URL DIR [dark]` — the demo driven headless (select,
  frog, spells, cast, answer, replace) with screenshots.

The first frog (a felt plush with a purple cape) is in this folder's history
(commit f899e61); the wizarding-creature style replaced it.
