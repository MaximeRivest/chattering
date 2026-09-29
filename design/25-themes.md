# Custom themes

Custom themes are user files. App updates do not overwrite them.

## Location

Put each theme in:

```text
~/.config/chattering/themes/<theme-id>.css
```

Use a lowercase file name. Use letters, numbers, and hyphens only. The file
name without `.css` is the theme ID. The selector must use the same ID.

The fastest start: import your terminal or OS colors with
`node themeimport.js` (see `26-theme-import.md`).

Or copy `design/theme-template.css` to start by hand:

```bash
mkdir -p ~/.config/chattering/themes
cp design/theme-template.css ~/.config/chattering/themes/my-theme.css
```

Then change `theme-template` to `my-theme` inside the file. Change the theme
name and colors. Refresh Chattering. The theme appears under **custom themes**.
Focusing the theme selector also refreshes the catalog.

## File contract

A theme contains one metadata comment and one CSS rule:

```css
/* chattering-theme
name: My Theme
scheme: dark
mode: color
motion: full
*/
:root[data-theme="my-theme"] {
  /* required color tokens */
}
```

Metadata values:

- `name`: Label shown in the app.
- `scheme`: `dark` or `light`. This controls native form and browser colors.
- `mode`: `color`, `gray`, or `binary`.
- `motion`: `full` or `none`.

`gray` makes project identities use gray steps. `binary` enables all e-paper
behavior. This includes hatch marks, solid content, static controls, and
transcript pages. `motion: none` disables animations and transitions.

The server rejects extra selectors, normal CSS properties, `@import`, `url()`,
and `!important`. Values must not contain braces or comment markers. This
keeps theme files limited to design tokens.

## Required tokens

A theme must define these groups:

- Surfaces: `--bg`, `--surface-1`, `--surface-2`, `--surface-3`
- Borders: `--border`, `--border-strong`
- Text: `--text`, `--text-dim`, `--text-faint`
- App colors: `--red`, `--yellow`, `--green`, `--cyan`, `--blue`, `--magenta`
- Filled controls: `--accent-strong`, `--accent-ink`
- Terminal selection: `--term-selection`, `--term-selection-ink`
- Ink: `--ink`, `--ink-ai`, `--ink-halo`
- Terminal palette: `--ansi-0` through `--ansi-15`

Values can use hex, `rgb()`, `hsl()`, or a direct `var(--token)` reference.
Other semantic aliases inherit from `design/tokens.css` and follow these base
colors automatically.

Set `--accent` when the accent must differ from `--green`. Use this for an OS
or brand color. Keep `--green` for success. `--live`, `--src-pi`, and
`--role-user` also accept overrides.

Themes can optionally change project color weight:

```css
--project-fill-s: 62%;
--project-fill-l: 44%;
--project-stroke-s: 78%;
--project-stroke-l: 68%;
--project-gray-base: 60;
--project-gray-step: 7;
--project-gray-stroke-offset: 30;
```

## Validate a theme

Run:

```bash
node test/theme-check.js ~/.config/chattering/themes/my-theme.css
```

The validator checks:

- Metadata and selector structure
- Required tokens
- Safe token-only CSS
- Resolvable colors
- Text, accent, status, and terminal-selection contrast

Invalid themes do not enter the selector. The browser console lists their
validation errors. The `/api/themes` response also includes these errors.

## Runtime design

`design/tokens.css` is the only built-in token source. The server exposes it as
`/tokens.css`. The app loads all valid user themes from `/api/themes.css` before
body paint. This prevents a custom-theme flash.

Built-in themes: `rockfrog` (the default), `rockfrog-light`, `rockfrog-dark`,
`dark`, `light`, `gray`, and `eink`. Custom theme files cannot reuse these IDs.

Rockfrog has two palettes: the brand's paper, and its night from the dark deck
slides. The dark levels come from APCA, the WCAG 3 candidate contrast
model, because WCAG 2 overrates light text on dark: each role (text,
secondary, faint, accents, borders) reads about as it does in the light
palette (see the comment in `design/tokens.css`). `rockfrog` follows the system's light or dark setting with them, in
CSS alone (a `prefers-color-scheme` block), so nothing flashes at load;
`rockfrog-light` and `rockfrog-dark` stay put. The classic palettes work the
same way: `auto` follows the system, `light` and `dark` stay put. Script that
copies theme colors (diagrams, the document editor, the PWA manifest) repaints
when the system turns, for both following themes.

The active theme stays in browser local storage, one choice per device. An
empty store means nobody has chosen, and the device shows `rockfrog` (since
2026-09-29; before, the default was the classic `auto`). `auto` is therefore
stored explicitly.
The Android app sets `eink` on e-ink tablets and Rockfrog on phones that have
no choice yet. The app copies theme
capabilities to `data-theme-mode` and `data-theme-motion`. Components and JavaScript
read capabilities instead of checking a theme name. Custom binary and gray
themes therefore get the same behavior as built-in themes.

The active `--bg` value updates the browser `theme-color` and the served PWA
manifest. Hosted terminal views use the active `--ansi-0` through `--ansi-15`
palette. Gantt colors and ink canvases also read theme tokens.
