# Vendored: acorn

`8.19.0/acorn.js` is acorn 8.19.0 (MIT, `LICENSE` beside it), the
JavaScript parser, unchanged from the npm package's `dist/acorn.js`
(sha256 b95392d79457d0357555c5ed3e56302d074b92dff119bcf3b44179500b10e9df).
Chattering keeps no npm dependencies.

Used by `scripts/disk-ratchet.js` (design/106): it reads the hub's code
as code, not as text, to find every place that touches files or starts
programs. A regular expression would count comments and strings and miss
aliases.

Update: `npm pack acorn@<version>`, copy `package/dist/acorn.js` and
`package/LICENSE` into `vendor/acorn/<version>/`, change the path in
`scripts/disk-ratchet.js`, check the hash here.
