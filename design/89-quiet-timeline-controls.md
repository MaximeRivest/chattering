# Quiet timeline controls

Keep the existing home Gantt drawing and gesture model. The header adds only
`Scale ▾`, `Now`, and `?`. Opening the scale control reveals Hours / Days /
Weeks, finer zoom, a date field and oldest-history navigation. Manual zoom
reads Custom rather than claiming to be a preset.

The expanded camera controls can be pinned to the header. The chart-only
shortcut guide can stay open while the user works. Both preferences are local
to this browser, not synchronized across differently sized devices. Below
700px the camera controls stay in the menu even if pinned on a larger screen;
the preference is retained for returning to the larger layout. Now replaces
the old floating phone recenter button. Popovers leave the phone navigation
bar accessible and reserve the desktop Files corner.

## Ownership

- `timeline-chart.js` owns all camera state, zoom anchoring, animation, wheel
  and touch behavior. A resize during an animated preset no longer cancels
  the destination; the anchor retains its fraction of the drawable viewport.
- `timeline-controls.js` owns the control surface, disclosure and saved
  preferences. It accepts camera callbacks, viewport clearance and keyboard
  availability from the application. It does not render conversation data.
- One action table supplies shortcut matching, labels and the contextual
  guide. The application's existing general help includes the same rows.
- Buttons move between menu and strip; they are not duplicated. Scale is
  reported back by the real chart, including wheel/pinch changes.
- `app.html` mounts one controller and tells it when the home route leaves or
  returns. Pinned help follows that route without taking focus on return.

## Keyboard and accessibility

Shift+H / Shift+D / Shift+W choose presets; + / − zoom; 0 selects Days;
N / End goes to now; B / Home goes to oldest; T focuses date entry; ? opens
the chart-only guide. Lowercase h retains the existing general-help binding.
These keys apply on the chart, its controls, or the otherwise unfocused home
page, not sidebar controls, text fields, composition, or another open dialog.
Clicking the chart establishes keyboard focus without scrolling it.

Escape closes the popover and returns focus to its opener. Native buttons
retain Tab, Space and Enter. Disclosure and selected presets expose their
state with ARIA attributes. The top-layer popover avoids clipping by chart
scroll containers. Theme colors and shared shape tokens cover light, dark
and binary e-ink; selection has a border and weight, not only color.

## Deliberate limits

The compact default costs a click to reach less-used controls. Pinning trades
header space for direct access; the guide covers part of the plot only when
explicitly requested. Presets reuse the existing pixels-per-day values; they
are not promises to fit a fixed number of calendar days on every screen.
The project-page chart keeps its existing local controls; this change targets
the home Gantt, without introducing another camera or changing its drawing.

Browser coverage: real app camera callbacks, typing/modifier protection,
Escape and native Space behavior, persistence, route changes, desktop corner
clearance, narrow portrait/landscape layouts, all three theme modes, and
animated camera anchoring across a resize. Tests use an isolated server and
browser profile, never the running user's sessions.
