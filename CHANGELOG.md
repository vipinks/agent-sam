# Changelog

All notable changes to Agent Sam are listed here, newest first. This app started life as the
`electron-react-app` shell; the entries below are the work that turned it into a local-first desktop
coding assistant.

<br>

## 2026-09-29: v1.1.0 — Buddies

- A **Buddy** is a way of working rather than a preset: a record with a name, a role section, a starter
  set and the MCP servers it may use, held in main's own store and mirrored to the renderer, because a
  fact main acts on cannot live in a window's memory. The built-ins are pure data in the protocol, which
  is why no file can edit, delete or corrupt one, and the SamAi default is not a record at all — it is
  what every conversation that named nobody runs as.
- A Buddy's role section is injected into its turn, and its server list is read as an intersection with
  what the user has trusted and left switched on. A ceiling and never a grant: a record cannot hand
  itself a server the user never enabled.
- Settings gains a **Buddies** section, with the editor behind the records and a switch on every row. The
  built-ins are listed and can be switched off but carry no pencil and no bin; the user's own records
  carry both, and a draft is checked by the protocol's own rule before it is written, so a refusal is a
  sentence beside the field rather than a failure to interpret. What a switch writes is an id in the
  store's disabled set, which is how a built-in — having no record to carry a flag — is switched back on.
- The header's left carries a **Buddy Select**: the SamAi default first, then every Buddy that is switched
  on, in the order the list rule returns them. The choice is per conversation and locks at the first send,
  because the two are different facts — before it, a choice that can still change; after it, a record
  that cannot. A conversation whose Buddy was deleted since runs on under the role it was created with.
- Home's starters swap with the choice, and the record's fields are seeded into the session at that same
  first send rather than at the click that picked it: a Buddy that declares a way in is what home offers,
  and the app's own three are what is left for SamAi or for a Buddy that offers none.
- The product is renamed: **Sam AI** is now **Agent Sam**, its identifiers move from `sam-ai` to `agent-sam`,
  and the app ships a new logo. Historical entries keep the name they shipped under.
- The v1.0.0 baseline is everything before this entry: Phases 1 through 57, which shipped under the
  standing versioning rule that a release names the work since the last one. This entry is v1.1.0 —
  Phase 58's three turns, which are the Buddies work described above.

<br>

## 2026-09-27: the composer takes images, as chips nobody has to keep

- The composer takes an image three ways — a paste into the box, a drop on it, or the picker beside the
  paperclip — and each one puts a chip under the message: a thumbnail from the bytes, the name, the
  size, and a button that takes it off. The chips and their pictures ride the same lift as the draft
  text, so a maximize no longer throws away a screenshot.
- Nothing is written until the message is sent. The chips are bytes in memory, and a draft that is
  abandoned or an app that is closed leaves no folder behind — which is the point, since a pasted
  screenshot is often something private.
- A send stores each image first and then dispatches the turn that names them, in the order they were
  attached. An image that cannot be stored aborts the send with the store's own sentence, and the draft
  stays exactly where it was, so nothing has to be retyped or repasted.
- A provider takes images only if it has been told to. Settings → Providers carries an **Image support**
  switch per provider, off until it is turned on, and the composer refuses all three capture paths with a
  sentence saying where to switch it on. A model that cannot see was the failure nobody would have
  understood from a provider error.
- The rules the composer refuses by are main's own: the 8 MB limit, the allowed types and the four-image
  cap come from the store's protocol rather than a second copy, so the sentence shown while choosing an
  image is the sentence a write would be refused with.
- What a sent message shows is a reference — the name and the size, no picture — because the bytes live
  in the attachment store rather than in the transcript. Thumbnails on the sent message are the next
  step, and so is sending the images on to the model.

<br>

## 2026-09-26: the composer's skill picker keeps its own scroll

- The picker's rows scroll inside a bounded region, instead of the popover growing to the height of
  the whole skill library.
- The type-to-filter input stays pinned above the rows, and the cap line stays pinned below, so
  neither can scroll out of reach.

## 2026-09-26: a README, and the turn that ends without saying anything

- A README covering what Sam AI is, what it can do, and how to run it.
- A turn that ends because the model stopped without writing anything is named as its own ending and
  gets its own card, instead of ending the conversation on the last tool result with no cause shown.
- An empty stop is picked up again on the same terms as a plain stop, inside the existing
  auto-continue budget.

## 2026-09-25: Home in the rail, and one Recent projects row

- The left rail leads with a Home affordance, which returns to the launch screen from anywhere in the
  workbench.
- Home lists recent projects as a single row, in place of the two separate surfaces it replaced.

## 2026-09-25: the Tools dock

- A Tools resident in the rail, and the panel it docks beside the conversation.
- A Skills tab listing the library a session can activate.
- A second tab for MCP servers.
- The view rules behind both tabs, stated separately from the views they drive.

## 2026-09-25: managing skills

- A Skills settings tab, and a filter on the composer's picker.
- Four skill tiers discovered from the project and user directories, one manifest parser, and a skill
  body read only when the skill is activated.
- Enabling, disabling and removing a skill, with its availability stated per skill.
- A cap of ten active skills per session, stated where the picker can see it and enforced at
  activation.
- The settings tab row reads as three sections rather than one long run.

## 2026-09-25: MCP servers in the settings panel

- A per-server auto-approve flag, honoured by the consent gate.
- The per-server control, a marker in the transcript, and the shield's copy on the call card.
- The MCP settings row's middle cluster, which wraps instead of clipping.
- Double-clicking a file row opens the code panel.

## 2026-09-24: MCP

- MCP server configuration, per-server trust, and secrets the renderer never holds.
- stdio servers launched from the main process, and their tools bridged into the agent.
- A running server's tool call put to the user in the consent card they already know.
- A settings shell, and the way back out of it.
- The running set, trust stated in words, and the start gate.
- The MCP settings section, and everything a row can do.

## 2026-09-24: skills

- Read-only skill discovery from the project and user directories.
- Session-scoped activation, resolved when a turn starts.
- A Skills control in the composer, with type-to-filter.

## 2026-09-24: the right rail

- A right rail whose Code, Preview and Terminal residents each dock one panel beside the
  conversation.
- Nothing is docked at launch, and docking restores the split a previous drag left.
- The right rail pays for its width out of the main column's budget, so the drawer keeps the
  proportions it saved.

## 2026-09-24: home

- A launch lands on home rather than on the conversation that happened to be open when the app last
  closed.
- Home is built from the real composer, drawn as a centred card, so its send path cannot drift from
  the conversation's.
- Sending from home creates the conversation and records the folder on screen.
- New chat returns to home instead of creating an empty conversation.

## 2026-09-24: the drawer and the terminal

- The drawer's collapse control moves to the drawer header, with the rail keeping only the way back.
- A terminal session outlives the pane that shows it.
- The expanded rail reads Sessions, Explorer and Git; the collapsed one leads with the expand glyph
  in the same slot.

## 2026-09-24: conversations by project

- The conversation list is organized by the project each conversation belongs to, under headers that
  fold.
- The open project comes first, the rest by how recently they were used, and conversations with no
  project sit at the foot.
- A group's identity is the project's path, so a group that moves because another project was opened
  last is still the same group.
- A fold states whether it is open to assistive technology, rather than being drawn only.

## 2026-09-24: a conversation remembers its folder

- A conversation remembers the folder it was used in.
- Selecting a conversation opens that folder, or says why it cannot.
- A folder that is no longer there says so, rather than failing silently.

## 2026-09-23: the endings a long turn dies of

- A truncated reply, a cut-off reply and a step ceiling are all picked up rather than left for a
  click, with the auto-continue budget reset per nudge.
- A pending decision survives maximizing the window, instead of leaving a card whose buttons do
  nothing.
- The consent setting survives a turn's own write to the transcript.
- The composer's draft survives a window-state swap.

## 2026-09-23: continuing a turn the model stopped mid-plan

- A turn the model stopped with work left on its plan is continued automatically, up to a budget.
- The endings are split by cause: the ones the loop can pick up are picked up, and the rest keep the
  one-click Continue on the card.

## 2026-09-23: tool calls serialize behind a pending decision

- A pending decision freezes the whole turn: nothing behind the call being asked about runs, an
  approval-exempt call included.
- An approval resumes the frame where it stopped; a denial ends the turn with the refused call
  answered and nothing behind it executed.

## 2026-09-23: the consent pause

- A consent pause is held per conversation, and the turn it is denied in ends there.
- A turn that ended with its plan unfinished is announced on the card above the composer.

## 2026-09-22: custom providers

- A custom provider can be described, and the list of them is remembered.
- A turn runs against the provider it names, and the app asks that provider for its model list.
- A provider is added from Settings, and a turn is then run against it.

## 2026-09-22: the drawer and the rail

- The drawer can be put away, and the choice is remembered across a restart with no flash of the
  wrong state.
- The collapse control takes the slot the rail head's status dot already held, and its glyph and
  tooltip name the direction on offer.
- Three triggers act on that one flag: the rail head, a second click on the panel already showing,
  and any activity icon while the drawer is away.
- Collapsed removes the drawer panel from the layout rather than hiding it, so the drawer comes back
  at the width its window state was dragged to.
- The rail's residents are reordered to Sessions, Explorer, Git, Terminal.

## 2026-09-22: window state and layout

- A window opens at its own state's proportions.
- Each window state's layout is remembered and applied when the state swaps.

## 2026-09-22: themes

- A theme registry and engine, so a theme is data rather than a stylesheet.
- Applying a theme and remembering the choice.
- Choosing a theme and setting its brightness.

## 2026-09-22: editing a message

- A user message is edited in place.
- An edited message is resent through the ordinary send path.
- An agent reply is regenerated through the ordinary run path.

## 2026-09-22: git, and the shape of the workbench

- Git gets a rail item and its own panel.
- The workbench opens at 20/80 and 62.5/37.5.
- The composer is fixed at 96px, and its top edge can be dragged.
- A message is copied from its bubble.
- Auto-approve is kept with the conversation it was set for.

## 2026-09-22: live-use polish

- Narration between tool calls is joined at the seam instead of running together into one wall of
  prose.
- A Windows session is told which shell it is in, instead of spending a step finding out.
- The paragraph break is written into the stored transcript, so a reloaded turn renders the same way.

## 2026-09-22: a dead turn announces itself

- A reply the provider cut off at its output limit, or a connection that dropped mid-reply, is named
  as the cause instead of being left to look like a clean stop.
- The card above the composer words the cause and offers Continue, which sends the resume as an
  ordinary message through the ordinary send path.
- The tools such a reply asked for are not run, since a reply the provider had already stopped
  writing is half a request.
- A transcript read back from disk keeps the cause and loses the button, because the run behind it is
  gone.
- The standing system prompt asks the model to keep narration between tool calls short, addressing
  the truncation at its source.

## 2026-09-21: the plan checklist

- The model declares what it is doing as an ordered list, pinned as a checklist above the composer.
- A step reads as pending, in progress, done or interrupted, with the status named in the row rather
  than carried by colour alone.
- A plan that stops mid-turn is marked interrupted when the turn ends, so a stored plan can never
  claim to be running.
- A session with no plan shows nothing: absence is the quiet state, and it never blocks or reserves
  space.

## 2026-09-21: the viewer over the chat

- Markdown opens in preview.
- The viewer expands over the chat, and collapses back to the split.

## 2026-09-21: spreadsheets

- A spreadsheet is previewed in the code viewer.
- A workbook's cell values are edited in the code viewer.

## 2026-09-21: what the viewer can show

- Line numbers in the code viewer's read view and edit mode.
- The editor highlights behind its textarea, so editing reads like the read view.
- An image is previewed in the code viewer.
- Markdown is rendered in the code viewer, with GitHub-Flavored Markdown in the shared renderer.

## 2026-09-21: syntax highlighting

- The code viewer's read view is syntax highlighted.
- The diff pane fills its height.

## 2026-09-21: recent folders

- A control in the Explorer header switches to a folder that was recently open, most recent first.
- The list holds up to eight folders, and a folder can be forgotten from it.
- A recent folder that has since been deleted, renamed or unmounted is refused with a readable
  explanation rather than a raw system error.
- Switching while the editor holds unsaved edits asks first, offering Keep editing or Discard and
  switch.

## 2026-09-21: a save that cannot clobber

- A save is refused as a conflict when the file changed underneath it, rather than silently
  discarding the other version.
- A file deleted since it was read is a conflict too, and only a deliberate overwrite brings it back.
- The refusal says outright that nothing on disk changed, so the reader knows what they are looking
  at.

## 2026-09-21: an editable code viewer

- The code viewer edits a file and saves it, with Tab inserting two spaces rather than moving focus.
- A read that arrives over a clean buffer is an ordinary refetch, and a change whose content still
  matches what was loaded is not treated as a conflict.
- Leaving edit mode keeps the edits and the unsaved marker, so re-entering finds the text as it was
  left.
- A file past the read cap stays read-only, since an editor over an empty buffer would overwrite
  something nobody has seen.

## 2026-09-20: git and the Changes panel

- The repository's state is read, and acted on: stage, unstage, commit.
- The Changes panel shows what changed and lets it be staged.

## 2026-09-20: the project's own instructions, and file mentions

- A workspace's own instructions file is read and spoken with.
- A message points at the files it is about (`@`-mentions), with the composer attaching them.
- The instructions file is read to its budget, not past it.
