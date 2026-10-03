#!/usr/bin/env python3
"""Cut a creature out of its white background, keeping glowing dust.

cutout.py IN.png OUT.png

The creature is solid: everything connected to it that is not near-white.
The rest (the background, and the gold dust floating in it) becomes
see-through by "un-mixing" white: a pixel that is white mixed with gold
becomes gold at that strength, so sparkles glow on any background with no
white halo. The grey floor shadow (colourless) is dropped.
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage

src, dst = sys.argv[1], sys.argv[2]
rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.float32) / 255.0
h, w, _ = rgb.shape

# Distance from white, and colourfulness.
dist = 1.0 - rgb.min(axis=2)
sat = rgb.max(axis=2) - rgb.min(axis=2)

# The background: near-white, or a light grey (the floor shadow), connected
# to the image border.
bgcand = (dist < 0.10) | ((sat < 0.06) & (dist < 0.40))
lab, _ = ndimage.label(bgcand)
border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
background = np.isin(lab, border[border > 0])

# The creature: found from its darker body (the pale gold dust around it
# never counts), its inside filled (glossy highlights are near-white),
# then grown back to its real edge.
seed = ~background & (dist > 0.30)
lab2, n = ndimage.label(seed)
sizes = ndimage.sum(seed, lab2, range(1, n + 1))
body = lab2 == (1 + int(np.argmax(sizes)))
body = ndimage.binary_closing(body, iterations=3)
body &= ~background  # smoothing must not claim the outer background
grown = ndimage.binary_dilation(body, iterations=3) & ~background & (dist > 0.24)
body = body | grown
# Holes: small ones are the eyes' highlights (kept, solid); big pale ones
# are background an arm closes in (beside the book, under a raised arm).
holes = ndimage.binary_fill_holes(body) & ~body
hl, hn = ndimage.label(holes)
if hn:
    hsize = ndimage.sum(holes, hl, range(1, hn + 1))
    for i, sz in enumerate(hsize, 1):
        region = hl == i
        # An eye's glint: bright, small, ringed by the dark eye. Background an
        # arm closes in: pale, ringed by green skin.
        ring = ndimage.binary_dilation(region, iterations=3) & ~region
        dark_ring = dist[ring].mean() > 0.6
        pale = ((dist[region] < 0.30) & (sat[region] < 0.10)).mean() > 0.5
        if dark_ring or not pale or sz < 60:
            body |= region
body = ndimage.binary_opening(body, iterations=1)
# Near the floor, grey is shadow, not toes: toes are clearly coloured.
floor = np.zeros_like(body); floor[int(h * 0.86):] = True
body &= ~(floor & (sat < 0.10))
body_a = ndimage.gaussian_filter(body.astype(np.float32), 0.9)

# Everything else: un-mixed from white. Alpha is how far from white it is;
# its colour is what, mixed with white at that alpha, gives the pixel.
# Only colourful dust stays (gold sparkles); pale haze and grey go.
a = np.clip(dist * 1.15, 0, 1) * np.clip((sat - 0.05) / 0.15, 0, 1)
# The floor shadow is grey (colourless): it goes. Gold dust is colourful: it stays.
shadowish = sat < 0.06
a = np.where(shadowish, 0.0, a)
a = np.where(a < 0.035, 0.0, a)

alpha = np.maximum(body_a, a)
safe = np.maximum(alpha, 1e-4)[..., None]
color = np.where(body_a[..., None] > 0.5, rgb, np.clip((rgb - (1.0 - safe)) / safe, 0, 1))

out = np.dstack([color, alpha])
Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").save(dst)
ys, xs = np.nonzero(alpha > 0.05)
print(f"{dst}: content box {xs.min()},{ys.min()} - {xs.max()},{ys.max()}")
