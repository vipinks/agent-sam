# Conversations and consent

This page covers what a conversation is on disk, how the consent shield decides which calls may run, what
a turn looks like while it is running, how a turn can end and continue, and how a message is edited,
branched or deleted. It is the behavioural half of the app; the files themselves are listed in
[Data and troubleshooting](data-and-troubleshooting.md).

## The record and the list

A conversation is a transcript record, saved as one JSON file per session under
`userData/sessions/<uuid>.json`. The transcript is written at turn boundaries, not per token: a store
broadcast per token would push the whole conversation over IPC while a model streams. The write is
atomic — a temp sibling then a rename over the target — so a reader sees the old bytes or the new ones,
never a half-written file.

The session list groups conversations under the folder they are about, under headers that fold. Search,
rename, move, delete and export (Markdown or JSON) are on the rows. A move checks the destination before
anything is written and refuses a missing or unreadable folder under `WORKSPACE_MISSING`; moving the open
conversation also switches the window's folder, because a turn run in the old folder would record that
folder and undo the move. The open folder follows the conversation when it is reopened, and a folder
switch is refused while a decision is pending rather than silently applied.

## The consent shield

Every acting call is gated per conversation by the shield in the chat header. Its two positions are
**Manual** and **Auto-approve**: in Manual each write and each command waits for an answer, and reads are
always allowed; in Auto-approve the built-in acting tools run without asking. The shield's own copy names
the exception rather than leaving it to be discovered: a call to a running MCP server is normally asked
about whatever the shield says, and runs without a pause only when that server's own auto-approve is on.

A turn's calls run in the order the model wrote them, and the walk stops at the first call that needs a
decision. Calls queued behind an undecided one neither run nor record an outcome. The pause is held per
conversation; denying ends the turn with the refused call answered and nothing behind it executed, and
approving resumes the frame where it stopped rather than restarting the turn. The decision survives
maximizing the window, and the consent setting survives the turn's own write to the transcript.

## A turn on screen

A live turn with nothing on screen yet draws a working row — three pulsing dots and "Thinking…". It is
derived from the turn's own emptiness rather than stored or timed: the first `text_delta` writes the
content, the first tool frame appends a step, and either one dismisses the row on the same render. It is
a status row for assistive technology, and its pulse is gated under reduced motion.

The turn's blocks are drawn in the order they happened: tool cards, prose, and the seams between them.
Each tool call is its own collapsible row, in flight or folded once it lands, with the user's own toggle
kept. The answer itself is never folded — the work folds, the words do not. The plan checklist above the
composer tracks declared steps by status rather than colour, and a session with no plan draws nothing at
all.

The chat header carries the model picker, the consent shield and a chip naming the working folder: the
folder's own name, the whole path in its title, and the theme's accent as its ink and rule. A
conversation with no project draws no chip.

## Endings and continuation

A turn that ends without a usable answer says what ended it on a turn-end card, and the card carries the
way to resume where resuming is possible. The endings are a closed set: the model stopped on its own
(`model_stop`), stopped without writing anything (`empty_stop`), was cut off at its output limit
(`truncated`), lost the stream mid-reply (`stream_error`), was stopped from outside (`interrupted`), or
never got an answer from any member of a model combo (`combo_failed`).

A turn that stops mid-plan is picked back up rather than left hanging, for a bounded number of segments.
The auto-continue budget is eight nudges per turn, counted across consent pauses rather than reset by
them, and each segment may spend at most ten model round-trips. Every seam is marked on screen so the
reader can see that the machine kept going and why. A reply the provider had already cut short asks for
no tools — half a request is not run — and the Continue button sends the resume as an ordinary message
through the ordinary send path. A transcript read back from disk keeps the cause and loses the button,
because the run behind it is gone.

## Editing, branches and deletion

An edit rewrites the user's message in place and a regenerate writes the reply again; neither removes
anything. The tail they replace — the question, its answer and every turn after them — is parked in
`branchPoints` on the turn that is the branch point, and a single `‹ n/m ›` switcher on that turn moves
the whole trail rather than one bubble's words. Checking a branch out swaps the trail from that turn
onward. The transcript version does not move; a stored file that still carries the retired version
arrays is read with those keys stripped rather than rewritten.

The one verb that removes rather than parks is the from-here delete, on either kind of message. It
removes the named turn and everything after it, and it asks first: the dialog names the turn count and
any parked trails that go with it, because a delete is the one message action a branch switch cannot undo.
The save is awaited directly rather than through the debounce, and the save carries the removed turn ids
so main prunes the episode blocks the range captured instead of minting a new episode. A live run, a held
pause, no active session or an id that names no turn all refuse the delete and leave the screen and the
disk exactly as they were. A save that fails says so plainly: the turns are still on disk and will come
back when the conversation is reopened.

Copy sits on both kinds of message, and export leaves through main as Markdown or JSON. The context menu
on selected chat text offers Copy as a native role; the composer's right-click offers the platform's own
six.

## Where in the code

- `conveyor/protocol/transcript.ts` — the transcript record, its turns and its branch points.
- `conveyor/protocol/message-versions.ts` — the version arrays and their read rules.
- `conveyor/protocol/turn-end.ts` — the closed set of endings, the auto-continue rule and its budget.
- `conveyor/modules/agent.ts` — the loop, the consent walk, the combo walk and the step budget.
- `conveyor/modules/sessions.ts` — transcript storage, the delete-save's episode prune and the sweeps.
- `app/components/workbench/use-chat-sessions.ts` — the pane's save paths, the delete and its four guards.
- `app/components/workbench/message-bubble.tsx` — the message row, the delete dialog and the branch switcher.
- `app/components/workbench/session-list-panel.tsx` — the project-grouped rows and their actions.
