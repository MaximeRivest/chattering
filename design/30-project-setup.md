# Project setup

## Goal

Give work a folder, then put the person in front of the first message. Setup itself starts no agent.

Revised 2026-10-03. The 2026-09-06 version ended setup on the project page, and starting from there opened the "review the context" dialog. That made five steps and two dialogs before anyone could type. That dialog also always ran Pi and created an empty conversation before any message. The new flow keeps the rule "setup starts nothing" and removes the steps that protected nothing.

## Flow

- **Find it** where projects are chosen and where things are started:
  - the "+ New project" button heading the timeline's project column (a real button, the full height of the date strip);
  - "+ New project…" at the end of the side column's project picker. A search with no exact match offers that name.
  - "New project…" in the side column's "new ▾" menu, now always shown.
- **One form**, in the order of importance:
  - "Start from" as two tabs (a segmented control over native radio buttons): New folder · Folder I already have.
  - Name, the largest field.
  - One plain line under it: "Creates ~/Projects/My-Thesis · Git on · Change". "Change" reveals the parent folder (a folder search) and the Git option. The parent is remembered.
  - "What is it for? (optional)", two lines with an example.
  - The footer says what comes next ("Next: write your first message."), with Cancel and Create side by side.
- **After Create:** the ordinary new-conversation page (the draft) opens in the new folder, cursor in the message box. The new project becomes the side column's chosen project. A notice names the project and its folder and offers **Undo**. Agent, model, mode and reasoning are chosen there, exactly as for any new conversation.
- **The purpose travels as a chip.** A draft that will run in a project with a purpose carries a "‹project› purpose" chip, attached as project memory (`intent`). It is visible, removable, and stays removed for that project once removed. Moving the draft to another folder takes along only the chip it added itself. Claude Code in its own program takes no attached context, so no chip there.
- **A missing folder in a draft** offers "create it as a new project". The same form opens, filled in with the folder's name and parent. The draft keeps its words and moves into the new project.
- **An empty project's start** (the project page's Start conversation, "new here") opens the draft in its folder. The review dialog remains for projects with conversations, epics and areas, where there is memory to review.

## Folder search (folder-picker.js, folder-index.js)

One search box answers every folder question: the folder to add, the parent of a new folder, and a draft's working folder. It follows the WAI-ARIA combobox pattern:

- ↑↓ move through the results; Enter chooses.
- Tab opens the highlighted folder, showing what is inside it.
- Esc closes the list only, not the dialog or panel around it.
- The keys are handled before the page's own handlers on the same box.

Typing searches the whole home folder:

- Every word must appear in order, with letters allowed to be skipped ("sch thes" finds ~/Documents/school/thesis).
- Matches in the folder's own name, at word starts, and in runs rank higher, and deeper folders lower.
- Smart case: a typed capital prefers that capital.

What else counts depends on the question:

- **Adding:** a free folder ranks first, Git repositories higher. A folder that already is a project opens it on Enter. A folder that cannot be added is shown dimmed with the reason: its name is used by a project elsewhere, it is part of a project, or it is too general.
- **Parent:** places where projects already live rank higher.
- **Working folder:** folders conversations ran in rank higher.

Typing a path (`~/…`, `/…`) lists the folders inside it, matched against the part after the last slash. Hidden folders appear once the typed part starts with a dot.

With nothing typed, suggestions fit the question:

- **Adding:** Git repositories not in Chattering yet, then recently changed folders.
- **Parent:** where two or more projects live, plus ~/Projects and home.
- **Working folder:** recent conversation folders.

The server walks the home folder once (≈0.5 s for ≈21,000 folders on lambda) and refreshes the list in the background after five minutes. The first results arrive while the walk is still going. It skips:

- hidden folders;
- `node_modules`, `__pycache__`, `site-packages`;
- trees tagged with `CACHEDIR.TAG`, and Python virtual environments;
- Chattering's own data folders;
- anything deeper than 8 levels, or more than 2 levels inside a Git repository.

Typed paths reach the rest. A search takes ≈30–70 ms on the server. `GET /api/fs/folders?for=add|parent|run&q=` is for members only.

## Names

- Letters of any alphabet, digits, `.`, `_`, `-` and spaces. The name must start with a letter or digit, and is normalized to NFC.
- Spaces become hyphens in the folder name, because agents type these paths into shells. The name as typed becomes the project's display title (a manual title) when it differs from the folder name.

## Undo

`POST /api/project/undo-setup {project}` removes the registration, the purpose written at setup, and a title set at setup.

- The folder is deleted only when it still holds exactly what setup made: nothing, or a Git repository without a commit.
- A folder with anything else in it is kept, and the answer says why.
- An added folder is never touched.
- Once the project has conversations, undo refuses and points to "Remove from project list".
- On the draft, words already typed stay as a draft with no project. An empty draft is discarded.

## Safety and access

- New projects cannot silently reuse an existing folder.
- Existing folder names keep spaces and Unicode characters.
- Require absolute paths or `~/` paths. General, temporary and cache folders are not project identities. Cache means this host's `XDG_CACHE_HOME` or `~/.cache`, or macOS `~/Library/Caches`, unless that folder contains the home folder.
- A purpose already on disk is never overwritten by setup; the answer warns instead.
- Keep form entries after errors. Report a saved folder separately from a failed registration, Git setup, title or purpose.
- Keep the dialog open during save. Disable repeat submission.
- Trap keyboard focus, make the background inert, support Escape, and restore trigger focus.
- An outside click does not discard the form.
- Use 44-pixel targets in the form. The timeline entry is 168×32 pixels.

## API

`POST /api/project/create`

- `{operation: 'create', name, parent, git, purpose?}`
- `{operation: 'add', path, purpose?}`

The answer is `{project, cwd, adopted, title, purpose, warning}`.

`GET /api/project/setup` returns `{version: 2}`. The form refuses to write to an older server, which would silently drop the purpose.

Explicit operations ignore the legacy `intent` and `firstPrompt` fields.

`GET /api/conversation/folder-info` also reports `purpose` (the project has one) and `parentExists` (a missing folder could be created).

## Trade-offs

- **The search does not see everything:** hidden folders, folders more than 8 levels deep, and code more than 2 levels inside a Git repository are found only by typing their path. This keeps results useful and the walk fast.
- **The folder list can be up to five minutes old** (folders made through setup appear at once). A folder made in a terminal a moment ago may need its path typed.
- **Results reorder as history grows**, because conversations and recent changes count. Familiar folders get faster to reach, but they do not always appear in the same spot.
- **Search runs on the server, one request per pause in typing.** It is fast on the LAN or Tailscale, but a slow link adds its delay to each refinement.
- **The area dialog's folder list** (on a project page, "⊞ area") is still its own older component.

- **The project page is skipped right after setup.** "Remove from project list" lives there, so the draft's notice carries Undo instead.
- **Empty projects start without the review dialog.** It had nothing to review; the purpose is the only memory, and it shows as a chip. Projects with memory keep the dialog, so there are still two ways a project conversation starts.
- **Draft starts in any project now carry its purpose.** Before, drafts carried no work memory unless attached. The chip is visible and removable, and the setup panel says so.
- **Accented and non-Latin folder names.** A few older tools handle non-ASCII paths poorly. Spaces still become hyphens for the same reason.
- **Cache folders are host-specific.** A conversation recorded in another machine's cache folder is only recognized as temporary on that machine. Custom `TMPDIR` has the same limit.
- Keep Git enabled for new projects, as before.
- Keep the existing project identity rules. Two folders that map to the same project cannot be registered separately.

## Checks

```
node --test test/project-create.test.js test/project-setup-ui.test.js test/project-setup-app.test.js test/projectfolds.test.js test/side-panel.test.js
```

`project-setup-app.test.js` drives the whole app in Chromium against a server with a temporary home. It creates folders under a temporary directory in the real home, because temporary folders are never projects. It removes them afterwards and starts no agent.
