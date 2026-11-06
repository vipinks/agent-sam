# Workspace and panels

This page is the desktop around the conversation: the open folder and the explorer over it, the guarded
editor and the viewers beside it, the git panel, the terminal under the chat, and the layout that
remembers where you put things. The conversation itself is described in
[Conversations and consent](conversations-and-consent.md).

## The folder and the explorer

The workspace is one folder, opened from the home screen's picker, a recent folder, or the explorer's
own switcher. Up to eight roots are remembered, most recent first and with a way to forget one. A recent
root that has since been deleted, renamed or unmounted is refused under `WORKSPACE_MISSING` with a
readable explanation rather than a raw system error. Switching while the editor holds unsaved edits asks
first, offering **Keep editing** or **Discard and switch**.

The explorer is a file tree over the open folder. Known file types draw a Material file-type icon from a
vendored MIT subset — eighteen recolours, with attribution under `resources/third-party/`. A file or
folder row answers right-click with **Delete**, **Show in folder** and **Open in default app**; the menu
opens at the pointer rather than anchored to the row, because a tree is a stack of rows of the same width
and an anchored menu would say nothing about which row was clicked. Delete asks first, naming the row and
the cost, and refuses an absent path under `PATH_GONE` and the open folder itself under
`ROOT_UNREMOVABLE`. Double-clicking a file row opens the code panel.

## The guarded editor

The code viewer edits a file and saves it, with Tab inserting two spaces rather than moving focus. Read
mode has syntax highlighting and line numbers, and the editor highlights behind its textarea so editing
reads like the read view. The editor remembers the modification time it read: if something else writes
the file before you save, the save is refused as a conflict instead of discarding the other version, and
only a deliberate overwrite brings it back. A file deleted since it was read is a conflict too. The
refusal says outright that nothing on disk changed.

A read that arrives over a clean buffer is an ordinary refetch, and a change whose content still matches
what was loaded is not treated as a conflict. Leaving edit mode keeps the edits and the unsaved marker, so
re-entering finds the text as it was left. A file past the read cap stays read-only, since an editor over
an empty buffer would overwrite something nobody has seen.

## The viewers

A markdown preview, a spreadsheet grid you can edit and an image viewer are residents of the right rail,
and each is expandable over the chat column. Documents open in the app through one `previewKind` dispatch
— `pdf`, `docx`, `doc`, `image`, `markdown`, `spreadsheet` or `other` — so the Preview resident and the
Code panel's preview pane cannot disagree about what a file is. A PDF is drawn on `pdfjs-dist` with zoom,
page navigation and a download button; a DOCX goes through `mammoth` and reaches the pane as pruned HTML;
a legacy `.doc` gets a card offering **Open externally**; and a read that failed, or a file past the
reader's cap, gets a card naming the file and the code behind the refusal rather than an empty pane.

## The git panel

The git panel reads repository status, the current branch, the recent log and a per-file diff, and it can
stage, unstage and commit, discard worktree changes and check out a branch. It is a resident of the left
rail's drawer with its own panel, and it reads the repository the open folder belongs to.

## The terminal

A real shell runs in the workspace — PowerShell on Windows, bash elsewhere — rendered with xterm.js,
docked under the conversation and opened from the title bar. The shell is one persistent process per
folder, so its scrollback and its `cd` survive the panel being put away, and two windows looking at one
workspace reconnect to the same shell rather than starting a second. The working directory is validated
to stay inside the open folder. The terminal is not a right-rail resident: a shell is a panel under the
conversation, not a second view of the file beside it.

## The right rail and the layout

The right rail docks one resident at a time beside the conversation: **Code** for the open file's source
and diffs, **Preview** for the same file rendered, **Overview** for what the conversation has spent,
**Tools** for what the app is working from, and **Memory** for the project's standing notes. At launch
nothing is docked, so the conversation gets the column; the slot is memory only, and every launch opens
rail-only. While a panel is docked that column can be expanded to take the chat's width, and the control
is offered by whichever resident is docked.

Separator drags are remembered per window state — a windowed layout and a maximized one are separate sets
— and the bottom panel keeps its own height in each. The left drawer collapses the secondary panel while
the rail keeps only the way back; a window opens at its own state's proportions rather than at one fixed
split.

## Where in the code

- `conveyor/modules/workspace.ts` — the file tree read, the file cap and the guarded write.
- `conveyor/modules/git.ts` — repository status, diffs, staging and commit.
- `conveyor/modules/terminal-pty.ts` — the one persistent shell per folder and its validation.
- `conveyor/protocol/preview-kind.ts` — the one document-kind dispatch.
- `conveyor/protocol/recent-roots.ts` — the eight-root list and `WORKSPACE_MISSING`.
- `conveyor/protocol/write-guard.ts` — the conflict rule the editor saves through.
- `app/components/workbench/file-tree.tsx` — the explorer and its row menu.
- `app/components/workbench/code-viewer.tsx` — the guarded editor and the preview pane.
- `app/components/workbench/right-rail.tsx` — the resident registry and the dock rules.
- `app/components/workbench/workbench.tsx` — the columns, the drawer, the terminal slot and the rail.
- `app/components/workbench/layout-memory.ts` — the per-window-state layout memory.
