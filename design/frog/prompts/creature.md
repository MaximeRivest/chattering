# How the creature was made

Model: `openai/gpt-5.4-image-2` through OpenRouter (`gen.py`). Each pose
was made with `raw/hp/b.png` (the first creature, waving) as its reference.

The creature (the reference):

> Creature design in the style of the magical beasts from the wizarding-world
> fantasy films: a small, friendly, frog-like magical creature, photoreal film
> CG with charm. Its skin looks like soft green lichen and moss with tiny
> glowing star-shaped specks, its throat glows faintly gold when it smiles,
> enormous dark glossy eyes with golden rims, round cheeks, a sprig of tiny
> clover growing on its head. It hugs a tiny old leather book with brass
> corners against its chest with one arm. It stands upright on two short legs
> like a little person and waves one tiny four-fingered hand hello. Big head
> and big eyes so it still reads when shown very small. No clothes, no hat,
> no glasses, no wand. Centered, full body, plain pure white background,
> faint soft contact shadow only, no text.

Each pose: "Same creature as the reference image: identical mossy lichen skin
with tiny glowing gold star specks, same clover sprout on its head, same big
glossy dark eyes with golden rims, same proportions and size, same photoreal
film-CG style and lighting, same camera distance, full body centered. No
clothes, no hat, no glasses. Plain pure white background…" then:

- idle: hugging the book against its chest with both arms, gentle content smile.
- cast: the book floats open, pages glowing gold, a swirl of tiny golden stars
  rising around its raised hands, throat glowing bright, eyes wide, mouth a small "o".
- happy: both arms raised, eyes shut in happy arcs, big smile, a burst of gold stars.
- puzzled: head tilted, scratching its head, clover drooping, unsure mouth.
- blink: an edit of idle with the eyes closed; only the eyes are pasted onto
  idle (a soft mask), so a blink never moves anything else.

No character, crest, colour scheme or name from the films: only the style of
their creatures.
