# 96 — Groups in the side list: name them, fold what you set aside

## The ask (2026-10-08)

> it may be nice to group the tabs that are open on the left panel into
> custom groups … I have many conversations I'm keeping open because I need
> to go back to them, but they clutter the space and I go through them
> again and again; they should be on a back burner … I'm not sure that
> pattern is durable, so I want to name these things and organize as I see
> fit. Grouping by project folder could be a toggle, but without clutter.

The list (design/59) mixes two kinds of rows: the ones being steered now
(working, just replied) and the ones kept so as not to forget them. The
cost is re-reading the second kind every time one looks for the first.

The direction was chosen on a working prototype with the real list of that
evening (`prototypes/side-list-groups/`), against three others: folder
chips above the list (one folder at a time hides agents working in the
others), one fixed "set aside" drawer (the fixed back burner the ask
doubted), and separate spaces (far too heavy for "rows I'll come back to").

## What a person sees

- **A group is a name given to some open rows.** Loose rows (in no group)
  stay on top in the list's order, as before; groups follow, each a tray
  (its header and rows on a faint tint of the text colour; outlined on
  e-ink). Pinned rows stay on top whatever their group.
- **Folding is the back burner.** A click on the header folds it to one
  line: chevron, name, count, and, inside, what is going on (the typing dots
  of a working agent, `?` with a count for questions waiting). No fixed
  "back burner" exists: "Later" is only a name the picker offers.
- **A folded group lets through what needs the person**: a reply nobody
  read and a run that stopped show under the header, with a short accent
  rule on their left. So does the conversation on screen. Opening the reply
  reads it; it stays while it is on screen and tucks back in when the person
  moves on, never under their eyes. A question (`?`) does not peek once
  read: set-aside work often ends with a question, and it would never fold.
- **Making groups, quickly:**
  - ⊕ on a row (hover; keyboard `g`) opens the picker: the group used last
    first, then the others (folded, "nothing open"), a typed name makes a
    new group, a suggested name (below), "Later", "Take out of its group".
    `g` `Enter` sends a row where the previous one went.
  - Drag one row onto another: the two become a group, its name ready to
    edit. Onto a header or a grouped row: into that group. Onto the strip
    that appears under the loose rows: out. A header onto another: reorder.
  - Ctrl/⌘-click or Shift-click (keyboard `Space`) picks several; a bar at
    the bottom offers Group… and Close.
  - The row's ⋯ menu has "Move to a group…" and "Take out of …" (the way on
    a phone, where the picker is a bottom sheet and nothing drags).
- **The header's own actions:** + starts a conversation in the group (a
  draft that says it will join it, in the group's project when they all
  share one), ⋯ renames, folds, moves up or down, ungroups, closes all.
  Double-click the name, or `F2`, renames in place.
- **Arrange** (the button beside + new; `Shift+G`):
  - **By project**: the list in project sections, on this device only, with
    its own folds; the groups are not touched. A dot on the button and a
    line above the list ("By project · back to your groups") say it is on.
    Rows there do not repeat their project.
  - **Tidy up…**: a proposal shown in place, applied only on Apply, with
    Undo after. Rows in use stay loose (working, unread, stopped, on screen,
    active in the last hour); of the rest, two or more of one project gather
    into a folded group named after it (or the group of that name); what is
    left goes to "Later". Proposed groups say "new".
  - Fold / unfold every group (`Shift+←` / `Shift+→`).
- **Keyboard** in the list (`a`): `↑ ↓` cross rows and headers, `Enter`
  opens or folds, `←` folds the group under the cursor (and lands on its
  header), `→` unfolds; delegated work's own `← →` still comes first.
- **Undo** for every move, ungroup, tidy and close-all, in the toast.
- **Every device** shows the same groups and folds: they are the
  household's, like the list.

## Decisions, and what they cost

- **Names the person chooses, not a fixed bucket.** One decision the first
  time; the picker's suggestion makes it one key.
- **Peeking.** A reply in a group meant to be forgotten still shows. If that
  ever bothers, a per-group "quiet" switch is the next step, not this one.
- **Groups below the loose rows.** New conversations land loose, where the
  attention is, and a group never pushes a working row off screen. A group
  one is actively in sits below the loose rows; Pin lifts any row to the top.
- **By project is a view.** Two arrangements are two shapes of one list,
  so it is one click away and never the default; it has its own folds so it
  never disturbs the groups.
- **Tidy up uses plain rules, no model.** It cannot see efforts across
  projects; the suggested names are for that.
- **Suggested names.** Rows of one project: the project's name. Rows of
  several: one short model call (`group_name`, design/74) when the picker
  opens, or when two rows are dropped one on the other; it appears a moment
  later, never replaces what the person typed, and is remembered per page.
  No AI configured: no suggestion, nothing else changes.
- **Closing keeps the membership**, so a reply brings the row back into its
  group. Memberships of conversations closed for more than 30 days are let
  go (daily), and a group nobody is in is gone. A group whose rows are all
  closed is hidden but still offered in the picker ("nothing open").
- **New conversations.** One started with a group's + joins it (the draft
  carries the group); a fork joins the group of the conversation it comes
  from. The top's + new stays loose: it is where new work starts.
- **Concurrency.** A change sends only what differs (a fold does not resend
  the name), so a fold on the phone does not undo a rename on the laptop.
  Otherwise the last change to reach the server wins, as for the list.
- **A guest** (design/53) does not see the household's groups and cannot
  change them; their rows simply show ungrouped.
- **Pages** of 100 count loose rows only; groups always follow.

## State

Two maps in the shared list state, `agent-read.json` (`agentread.js`):

- `groups[id] = { name, order, folded }` — `id` is `g…`, made by the
  browser so a change applies at once; lower `order` is higher; names are
  trimmed to 60 characters; at most 300 groups.
- `member[key] = id`.

`POST /api/agent-read { grouping: { groups: { id: {…} | 0 }, member:
{ key: id | '' } } }` applies groups first, then members (so one change
makes a group and fills it), refuses members of unknown groups, removes a
group's members with it, and drops groups left empty. The broadcast delta
carries whole groups (0 when gone) and member ids ('' when out). Member
keys are checked against what the person may see.
`POST /api/agent-read/group-name { keys }` → `{ name }` (members only).

This device's own, in local storage: the arrangement, the project view's
folds, the group used last.

## Where it lives

- `agentread.js` — `applyGroups`, `pruneGroups`; the maps in `normalize`
  and `applyDelta`.
- `server.js` — the `grouping` change, the daily prune, `group-name`;
  `ai-programs.js` — `group_name`; `policy.js` — the route.
- `list-groups.js` / `list-groups.css` — the layout (loose rows, trays,
  peeking), headers, picker, menus, rename, selection, drag and drop,
  arrange, tidy up, keys. `app.html` keeps the rows: `renderAgentsPop()`
  asks for the layout and `reconcileList()` draws headers and rows as one
  flat keyed list (an item's classes draw the tray), so a row moving into a
  group slides there and hover and focus survive. A server started before
  these files existed answers 404 for them; `app.html` then draws the list
  as before until a restart.
- `conversation-draft.js` — a draft's `group`; forks in `app.html`
  (`ListGroups.follow`).
- Tests: `test/agentread.test.js` (the rules), `test/list-groups-app.test.js`
  (the journey: picker, `g Enter`, fold, working header, peek and tuck,
  rename, several at once, undo, close and return into the group, keys,
  drag, by project, tidy up, fork, a group's +, the phone's sheet).
