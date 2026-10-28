# Changelog

All notable changes to Agent Sam are listed here, newest first. This app started life as the
`electron-react-app` shell; the entries below are the work that turned it into a local-first desktop
coding assistant.

<br>

## 2026-10-28: v1.14.0 — Phase 103 fixes

- fix(agent): bound run_command on child exit, tree-kill on abort, wall-clock wedge guard
- fix(turn-end): mid-work notice on a planless tool-using stop; tighten set_plan discipline
- fix(providers): derive active model from enabledModels; stop on stale/unenabled model

<br>

## 2026-10-20: v1.13.1 — Controls read against whatever they sit on, and the chrome tells the truth

- **Controls read against whatever they sit on, and the chrome tells the truth.** A new surface module
  declares the page and card families and one fill table, so inputs, select triggers and
  outline/secondary buttons take the Recent-projects pill fill on page-grey parents and the recessed
  page fill on white cards — a control never dissolves into its surface in either context, in light
  mode; dark mode keeps its raised tint. The titlebar's centred title text is gone. The MCP tools
  rail's play/stop and toggle now sit in one fixed trailing cluster so both columns align identically
  across every row. The Buddy picker is disabled and shows the default identity while a non-Sam engine
  is selected, because a Buddy's role prompt, skills and MCP ceiling are Sam-loop machinery an external
  engine never receives; switching back restores the prior Buddy. The default identity's mark is now
  the app's own logo — the robot artwork the window icon, installers and README banner are built
  from — replacing the old red square the picker had worn since before the rebrand.

- The v1.13.0 baseline is everything before this entry; this entry is v1.13.1 — the two commits,
  2139ab0 and 09abe37, which are the work described above.

<br>

## 2026-10-20: v1.13.0 — The menu bar is gone and the chrome becomes one grid

- **The menu bar is gone and the chrome becomes one grid.** The File, Edit and View menus leave the
  titlebar for good, including the Alt toggle; their six actions survive as keyboard shortcuts — Ctrl+R
  reload, Ctrl+Shift+I devtools, Ctrl+Plus and Ctrl+Minus zoom, Ctrl+0 actual size, F11 fullscreen —
  through a menu-independent pure key-to-command mapping that reuses the same window commands, and Reload
  also gains a titlebar icon before the zoom controls. The titlebar and both side rails now share one
  measure (a 40-pixel band with 32-pixel icons and a single gap token), the rail icons sit at one
  consistent pitch on both rails, and the titlebar's functional groups divide with visible vertical
  hairlines — reload, zoom, layout, theme, update, terminal. Those hairlines had in fact never rendered
  since their first introduction: the shared separator primitive's vertical form collapsed to zero height
  under a cascade specificity win, so the element existed and painted nothing; the rules are now
  fixed-geometry spans painted in the theme's own ink, and the suite asserts visible geometry and paint
  rather than mere existence. Native editing chords are unaffected by the menu removal; only the
  clickable Edit menu entries are gone.

- The v1.12.1 baseline is everything before this entry; this entry is v1.13.0 — the two commits,
  4c132da and 9a1e1b9, which are the work described above.

<br>

## 2026-10-19: v1.12.1 — Light-mode inputs recessed, and nine other polish items

- **Light-mode inputs gain recessed backgrounds, and nine other polish items land across the settings,
  composer and MCP surfaces.** Input fields and select triggers in light mode take a recessed page-family
  tone so they read as fields rather than as borders on the white card; dark mode keeps the raised tint from
  the previous pass. The updates screen stops shouting: the version string states regular weight, the status
  becomes a badge whose tone is the state (green only for up-to-date, warm for every other state), and the
  check button becomes the design system's outline variant. Active states now say so: the auto-approve chip
  paints the theme accent while it is on and stays neutral while it is Manual; the MCP tools rail's stop is
  the row's one danger red and play stays muted; the MCP settings row turns play into a status light (green
  while a process is there to report) with stop red and withheld when there is nothing to stop. The providers
  page's add control moves into the section header beside the heading it grows, mirroring the MCP section,
  and loses the second plus its label doubled against its icon. No schema, token, behavior or runner change.

- The v1.12.0 baseline is everything before this entry; this entry is v1.12.1 — the one commit, 811a8b1,
  which is the work described above.

<br>

## 2026-10-19: v1.12.0 — Buddies draw their chosen glyph, and their cards carry the description

- **Buddies draw their chosen glyph wherever they appear, and their descriptions show on the cards.** One
  shared registry resolves a buddy's glyph id to a lucide icon at every avatar site — the settings card plate,
  the chat header chip, and the picker rows — in the plate the letter monogram used to fill. The custom-buddy
  glyph picker grows from 12 to 32 marks spanning documents, writing, analysis, communication, tools, science,
  nature and shapes; the growth is strictly additive so every saved buddy's stored glyph id keeps resolving
  forever, and the shared registry is the single source of truth for the picker, every render site, and any
  store validation. The three built-in buddies (Writer / Editor, Study Tutor, Analyst) ship fitting marks —
  PenLine, GraduationCap, ChartLine — and stay locked. Settings cards draw the buddy's description under the
  title row, clamped to two lines in a slot every card reserves, so all buddy cards keep one uniform height
  whether or not a buddy has a description. The one schema-level change is the glyph-id field's character bound
  (2 to 24), forced by the new ids being lucide icon names rather than single letters; field shape, trust rules
  and locked-built-in rules are untouched.

- The v1.11.2 baseline is everything before this entry. This entry is v1.12.0 — the one commit, which is the
  work described above.

<br>

## 2026-10-19: v1.11.2 — Inputs separate from the surface, and popup forms get room

- **Inputs pop out of the dark surface, and popup forms get room.** In dark mode an input takes a raised tint of
  the same `--input` token — the dark-only opacity moves from 30% to 50% — so it no longer dissolves into the
  surface it sits on, and it gains a taller touch target (h-9 to h-10). Popup forms widen from sm:max-w-md to
  md:max-w-xl at tablet width and lg:max-w-2xl at desktop, behind the existing viewport-bounded mobile cap
  (max-w-[calc(100%-2rem)]) that keeps them fitting on narrow screens. Light mode's input treatment is unchanged
  and the popup primitive keeps its structure — border, radius, padding, shadow and animation all stand. No
  functionality, no new tokens, no surface grammar changes.

- The v1.11.1 baseline is everything before this entry. This entry is v1.11.2 — the one commit, which is the
  work described above.

<br>

## 2026-10-19: v1.11.1 — Dark mode reads at github.com's depth

- **Dark mode now reads at github.com's depth.** The dark room moves from the lifted charcoal of v1.11.0 to
  GitHub's own ladder — canvas at 7%, plate at 11%, hairline at 21% — each carrying the theme's own hue at a
  whisper of saturation, so the five themes keep their identities on a room that reads like GitHub's. The
  foreground family follows: primary text replaces the near-white with a 93% rung in the theme hue, and muted
  text moves with it. The muted rung sits brighter than GitHub's own by necessity — this app holds every text
  pair to the 4.5:1 floor, and GitHub's muted text does not clear it — so muted reads slightly lighter than a
  github.com page, by design. Crimson's dark surfaces, which had carried a neutral hue, now take the theme's
  own. Light mode is byte-identical, and no surface, radius, shadow, border or behaviour changes.

- The v1.11.0 baseline is everything before this entry. This entry is v1.11.1 — the one commit, which is the
  work described above.

<br>

## 2026-10-18: v1.11.0 — The whole application speaks one design language, and dark mode leaves pure black

- **The whole application gets one design language.** Every surface now speaks a single grammar: one accent
  per theme on every selected and active state, borderless plates with a hairline shadow instead of outlined
  cards, one radius scale, and inputs keeping their borders because a border is an input affordance. The home
  screen is one centred stack with bounded gaps instead of a growing void; chips, cards and transcript
  containers all read as plates.
- **Dark mode leaves pure black for a lifted charcoal canvas,** authored per theme in that theme's own hue at
  a whisper of saturation, so plates separate from the page and light ink stops blooming; every brand-coloured
  text token is re-tuned against the new surfaces and held to the 4.5:1 floor by the contrast suite in both
  modes, closing light-mode contrast gaps that shipped earlier.
- **The shell reads in groups:** the titlebar's icon cluster gains hairline separators between its functional
  groups, the icon rail's active indicator and the session group headers adopt the pass's radius and plate
  treatment, and nothing about behaviour, layout structure or functionality changes — this is a token and
  surface pass, verified by structure suites and by the running window in both modes and all five themes.

- The v1.10.0 baseline is everything before this entry. This entry is v1.11.0 — the three Phase 96
  commits, which are the work described above.

<br>

## 2026-10-18: v1.10.0 — Session rows tab under their project, and the hover actions paint over the title

- **The conversation list rows sit under their project, and the hover actions sit on the title.** Session
  rows are tabbed inside the project's open angle icon in every group including the no-project group, and
  the hover action cluster overlays the title's right edge instead of reserving a gutter beside it. The
  cluster paints an opaque plate in its own right (the accent token, in both themes) with a short fade at
  its left edge, so no fragment of a title shows through or between the icons in the hover and focus
  states; the row paints the same accent under hover and focus-within so the plate and the row always
  agree.

- The v1.9.0 baseline is everything before this entry. This entry is v1.10.0 — the three Phase 95
  commits, which are the work described above.

<br>

## 2026-10-17: v1.9.0 — Old turns fold into a summary, and a long conversation compacts itself

- **A turn may now stand for turns that came before it, and the transcript keeps every one of them.** A turn
  carries `summarizesTurns`, the ids of the turns it stands for at send time. Compaction adds one such turn at
  the head of the transcript and leaves every turn it names exactly where it was: the file and the pane keep
  the whole conversation, and only the send-time projection leaves the summarized turns out and travels the
  summary in their place. The pane draws a seam where the summary sits, naming the range and expanding to the
  turns it replaced on demand. `TRANSCRIPT_VERSION` stays 3 — the key is additive and optional, so an older
  build reads the conversation whole rather than refusing it.
- **The summary is the Sam loop's answer, and the fold can happen on its own.** A compaction's summary is
  whatever the loop answers to a prompt built from the range's own turns; the stub remains the fallback when
  the loop is unavailable or answers nothing. A send that leaves the conversation at or past the Overview
  meter's compact point folds it once the reply lands, and a compacted conversation can be folded again from
  the first turn after the previous summary's range. The meter row now states the threshold in percent and
  tokens and whether the conversation is compacted, naming the range.
- The v1.8.0 baseline is everything before this entry. This entry is v1.9.0 — the two Phase 94 commits,
  which are the work described above.

<br>

## 2026-10-17: v1.7.1 — Edit and regenerate become branch points, and one switcher moves the whole trail

- **A conversation is a trail with branches now, and the record's `turns` array is the trail that is checked
  out.** An edit and a regenerate park the tail they replace — the question, its answer, and every turn after
  them — in `branchPoints` on the turn that is the branch point, in creation order, and `branch` says which
  position is on screen. Checking a branch out swaps the whole trail from that turn onward, so the conversation
  moves as a conversation rather than one bubble changing its words.
- **The two pagers are one branch switcher.** A message's own action row used to draw a version pager on each
  half of the pair; the turn that holds the branch point now draws one `‹ n/m ›` control, on whichever side of
  the pair it is. It is drawn only when the turn has more than one branch and only while the pane says the
  conversation is settled, and it asks the pane for a position rather than editing the bubble: a branch is more
  than one message's words.
- **An edit parks the tail it stood at the head of.** The checked-out trail becomes the edited question plus the
  reply being written again for it, and nothing after that reply. The reply keeps its id, so the run fills the
  turn it always filled; the message that followed the old answer was written from words this edit changed, and
  it is one switch away rather than shown beside a new answer.
- **A regenerate parks the tail it stood at the head of.** The checked-out trail becomes the same question plus
  a reply written from nothing, and every turn that followed the old answer goes with it — the answer it used
  to be, the question after it, the answer to that, and the card and checklist that answer's work left behind.
- **The divergence v1.7.0 accepted is retired.** A conversation no longer keeps answers that were written from
  words it no longer holds: a parked tail keeps the words it was written from, and checking it out is what
  shows them. Everything that reads the conversation — the pane, the re-run's history, the export, the
  clipboard, the search, a reopen, the plan — reads the checked-out trail, which is exactly the `turns` array.
- **The record's two version arrays are gone, and `TRANSCRIPT_VERSION` stays 3.** `userVersions` and
  `replyVersions` were optional-additive when they landed; a stored file that still carries them is read with
  the keys stripped, which reads as the version that was live at the branch point and loses the ones parked
  behind it. That is a read rather than a rewrite: no file on disk is touched by this build opening it.

<br>

## 2026-10-16: v1.7.0 — Edited and regenerated messages keep every version, a conversation moves between projects, and the explorer row answers right-click

- **An edit and a regenerate rewrite in place, and what was there is kept beside what is.** Both used to cut: an
  edit removed the edited message and every turn that followed it and sent the words again, and a regenerate did
  the same from the reply it was standing on. Neither removes anything now. The turn keeps its id and its place,
  and the message it used to be — its text, and the chips it was carrying at that moment — is kept as a previous
  version beside the new one, reachable from the message's own action row: a left arrow, the count, a right
  arrow, drawn whenever a message has been through more than one version, on the user's own bubble and on a reply
  alike. A turn with no versions reads as the single version it is, so an ordinary conversation is unchanged.
- **Nothing is asked first, because nothing is removed.** The confirmation dialog is retired from both paths: the
  count it named was the only warning a user got about a removal they could not watch happen, and there is no
  removal left to warn about. Editing a message still re-runs the reply that answered it, as a new reply version,
  and a message with no reply yet still gets one.
- **The divergence this accepts is that a later reply stays what it was.** With nothing dropped, a conversation
  rewritten in its middle keeps answers that were written from the older words, and the pane shows them rather
  than re-deriving them: a run for a rewritten turn is handed the turns up to the question it is answering and
  nothing after it, while the transcript on screen keeps every turn. Every reader that only wants a message's
  text — the export, the search, the clipboard, the provider payload — takes the version in force, never one parked
  behind the pager.
- **The record grows two optional-additive arrays.** `userVersions` on a user's message and `replyVersions` on a
  reply, each holding the versions that are not live, oldest first, each entry carrying the text and the chips
  that version had. `TRANSCRIPT_VERSION` stays 3: an absent optional key is stripped rather than defaulted, and a
  reader that has never heard of these keys shows the live message, which is what it showed before. An array is
  written only when a message has been through more than one version, and a save that changes nothing commits no
  version at all.
- **A session opens at its last message, and the transcript's edges carry a way back.** Opening a conversation
  used to leave the pane at the top, which on a long one showed the oldest words first; it now lands at the
  bottom, by the same move the jump control makes, and the landing is keyed on the open session's id, so a
  conversation opened after another lands at its own bottom rather than wherever the last one was left. The
  transcript then draws a control per edge rather than one for "in the middle" — the top arrow whenever the top is
  somewhere to go, the bottom arrow whenever the bottom is — so a transcript sitting at a midpoint offers both, a
  transcript at either end offers only the control that still does something, and one that has not drawn a turn yet
  offers neither. `EDGE_SLACK_PX` is how close to an edge counts as being at it, slack rather than zero because a
  fractional offset from a zoomed device pixel otherwise reads as "not at the bottom" and draws a control nothing
  needs.
- **A conversation can be moved into another project.** A row's existing action surface — the one beside rename —
  gains Move, which lists the folders the app remembers minus the row's own project, with the open folder first.
  Main checks the destination before anything is written: a folder that is not there, or that cannot be read, is
  refused under `WORKSPACE_MISSING`, the code a folder switch already refuses under, and the session, its
  transcript and the store are left exactly as they were. The destination is handed back resolved, so a row's new
  project is one spelling of the folder, which is what the recents comparison and the project grouping both rest
  on. **No file is renamed, because there is nothing to rename:** a transcript lives at
  `userData/sessions/<id>.json` — one directory for every project, named by the session id alone — and a snapshot
  records nothing about the folder a conversation happened in, so a moved transcript is already where it belongs
  and the disk half of a move is the destination check. Moving the _open_ conversation also switches the window's
  folder, for the reason the per-turn project stamp exists: a turn run in the old folder would record that folder,
  and the move would be undone by the next message.
- **An explorer row answers right-click.** A file or folder row now offers Delete, Show in folder and Open in
  default app, from a menu opened at the pointer rather than anchored to the row — a tree is a stack of rows of the
  same width, so an anchored menu would draw in the same place for every row and say nothing about which one was
  clicked. Delete asks first, naming the row and the cost, and refuses under `PATH_GONE` when nothing is on disk at
  that path any more, at which point the explorer reads the folder again rather than keeping a row that is not
  there; Show in folder is `shell.showItemInFolder`, the OS's own file manager with the row selected; and Open in
  default app is offered only for the names the document hand-off accepts, read off that command's own rule rather
  than restated, because an item whose only possible answer is a refusal is worse than no item. The open folder
  itself heads the tree as a path line rather than a row, so it cannot be right-clicked at all, and the removal
  refuses it under `ROOT_UNREMOVABLE` for a caller that names it. Nothing in the menu is a new capability except
  the two the trace found missing entirely: the removal and the file-manager hand-off had no boundary in the app
  before.
- **The title bar's controls explain themselves, and a contrast control sits beside brightness.** Every icon in
  the right cluster now wears one tooltip shape from a single `ControlTooltip` — the mode toggle, the brightness
  control, the terminal toggle, the view actions, the window controls and the update badge — with one placement
  (bottom, centred) and one delay, stated in that module rather than inherited from the primitive's default, so a
  change to that default cannot quietly stagger every hover in the row. The mode toggle names the mode the window
  is in instead of repeating "Toggle theme", and the terminal toggle's native title moved into the same shape, so
  one control has one description. Contrast joins brightness as its twin: a `contrast` slot in the theme
  preference beside `themeId` and `brightness`, each setter writing all three so nothing can drop a half, and the
  engine applies it the way it applies brightness — as a multiplier on the document's own custom properties, never
  as a filter — so each surface's distance from the page is multiplied while the ink stays where the theme put it.
  Zero is the identity on a 0–100 slider, which is why a window that never touches the control renders exactly
  what it rendered before; the terminal follows on the route it already followed the brightness, and the
  brightness control now wears the sun glyph, leaving the contrast mark to the control it names.
- The v1.6.0 baseline is everything before this entry: Phases 1 through 88, which shipped under the standing
  versioning rule that a release names the work since the last one. This entry is v1.7.0 — the five Phase 90
  commits, which are the work described above.

<br>

## 2026-10-15: v1.6.0 — A conversation's first turn runs the engine it was created as, and the model control waits for a catalogue

- **The model control waits for a catalogue.** The rule was stated the wrong way round: no engine here
  publishes a list of valid ids to choose from, and a field whose value no runner acts on is a promise nothing
  keeps while the turn quietly runs the engine's own default. `engineTakesModel` now answers true only for an
  engine that advertises a model list, `ENGINE_MODEL_ENGINES` is empty, and the per-engine control draws
  nowhere, for any engine and at home — Codex runs on the model its own configuration resolves.
  `CODEX_MODEL_FLAG` and the argv push are gone, and the Codex array is the shipped launch config plus the
  prompt for every state the turn's model field can hold. The field itself stays on the turn, so one input
  shape crosses the boundary for every engine, and the control and its store slot keep their place for the
  engine that answers with a catalogue.
- **OpenCode gets a searchable model picker.** OpenCode is the engine that does advertise a list — its session
  sends 1367 ids — so the header's control is drawn for it and is now the search over that list: typing filters
  the advertised ids, and a pick records the model in the workbench store, from where it rides the turn input's
  `model` field. The ACP client reads the advertisement off `session/new` and holds it as `AcpClient.models`;
  `setModel` sends `session/set_model` with `{ sessionId, modelId }`; and the runner validates the chosen id
  against the catalogue _before_ the engine is told anything, because the Phase 82 probe measured
  `session/set_model` answering success for a garbage id, which makes a client-side check the whole of the
  defence. The session's own `currentModelId` is always a valid choice, even when the catalogue omits it.
- **The send that creates an engine conversation runs as that engine.** Phase 84 fixes the hop the engine read
  was lost at. The pane read the conversation's engine off the value of the last render, which is `null` on the
  send that creates the conversation, because the record carrying that engine is written by that same send and
  reaches this window a round trip later — so `conveyor.engine.turn` was never built, the per-engine model
  control's value reached no runner at all, and the app's own loop answered under the header's
  `provider::model`. The create now hands back what it wrote, `CreatedSession { id, engineId }`, and the run
  takes the engine as a parameter, so the first turn of a codex conversation actually runs under codex.
- **The send that creates a buddy conversation carries its role and server ceiling.** The same render-value read
  was feeding the buddy's role prompt and MCP subset off `null` on a creating send, so the create now hands
  those back as parameters, and a buddy conversation's first turn actually runs under its chosen Buddy's role
  and server list.
- **Transcripts and sessions record their engine and its model.** A transcript said nothing about the engine
  that wrote it — none of the 62 stored files named one — and the per-engine model pick was renderer-local, so
  a reopened conversation showed an empty field while its turns ran a chosen model. The transcript record gains
  `engineId` at creation and `engineModel` on any turn that carried one, both optional-additive, so
  `TRANSCRIPT_VERSION` stays 3 and the existing files are untouched; the chat-sessions record gains
  `engineModel`, written at a turn start from the value the runner is handed; and the header control hydrates
  that value when a conversation opens, which is the only place it survives a relaunch.
- **Two tracked probes land in the probe suite.** `tests/probes/codex-model-flag-probe.mjs` reads
  `codex exec --help` verbatim for the model flag's own shape and then records the engine's own refusal for an
  impossible id, and `tests/probes/acp-model-surface-probe.mjs` measures the ACP model surface for kimi and
  opencode by asking initialize, `session/new`, and each candidate `set_model` spelling and recording every
  frame. Both spawn installed binaries and can talk to the network through a signed-in one, so neither is a
  seat inside the six gates: `tests/run-probes.mjs` is the registration site that names them, runs them with
  node, and exits non-zero on a probe's own failure.
- The v1.5.1 baseline is everything before this entry: Phases 1 through 81, which shipped under the standing
  versioning rule that a release names the work since the last one. This entry is v1.6.0 — Phases 82 through 88.

<br>

## 2026-10-09: v1.5.1 — The installer-cache sweep runs in the state an install reaches, and waits out the lock

- **The startup sweep now runs in the state a completed install actually reaches.** Phase 80 lets the gate
  accept `up-to-date` alongside `idle`, because `up-to-date` is precisely the mirror state the launch after an
  install reports: the sweep runs at a launch's start, but its deferred pass can land after the launch's first
  check has finished, and a check that finds nothing newer answers `update-not-available`, which reads as
  `up-to-date`. A gate that admitted only `idle` refused a state it had no argument against, and on that
  launch refused the very sweep the install's own startup had asked for.
- **A sweep the OS is holding earns exactly one deferred pass.** Windows keeps the setup exe locked for a
  moment after it has started the app that replaced it, and `unlink` answers `EPERM` or `EBUSY`; that lock
  lifts on its own, so it buys one retry rather than being abandoned. Anything else — a read-only directory, a
  path that vanished — stays the non-event it has always been and is never retried. Nothing is ever created,
  so a machine whose updater has never run is left byte-for-byte as it was, and the 130MB setup exe is
  reliably cleared after a successful update.
- The v1.5.0 baseline is everything before this entry: Phases 1 through 79, which shipped under the standing
  versioning rule that a release names the work since the last one. This entry is v1.5.1 — Phase 80.

<br>

## 2026-10-08: v1.5.0 — The header announces an update, installs it silently, and clears the installer it ran

- **The header now mentions an update, and it leads to the screen that can act on it.** Phase 78 draws a
  badge in the window chrome's right cluster for the three states the rule names — an update available,
  one downloading, and one ready to install — and a press opens Settings _at_ the Updates rail entry
  through the store's own deep link, so the notice and the action are one step apart. A check that found
  nothing says nothing, and a failed check stays on the screen that can explain it and offer a retry
  rather than nagging the title bar about something it cannot fix.
- **Both install paths now run the installer without a wizard and come back up.** The Updates section's
  Install-and-restart and the install performed on quit both call `quitAndInstall(true, true)`, so the
  assisted NSIS installer runs silently and the app relaunches once it has finished.
- **The installer that ran is cleared out of the updater's own cache.** A packaged startup sweeps the
  downloaded setup, its `.blockmap` baseline and the cache's `current.blockmap` out of
  electron-updater's pending directory — but only while the mirror is `idle`, because a download in
  flight is a file being written, and a sweep that fails is not an event. Nothing is ever created, so a
  machine whose updater has never run is left byte-for-byte as it was.
- The v1.4.1 baseline is everything before this entry: Phases 1 through 77, which shipped under the
  standing versioning rule that a release names the work since the last one. This entry is v1.5.0 —
  Phase 78.

<br>

## 2026-10-08: v1.4.1 — A silent assistant turn never reaches the wire

- **The continue/resume provider-400 defect is fixed at the two ends of one fact.** Phase 76 puts the
  rule in the shared outbound mapper: the history is sanitized before either dialect body is built, so
  an assistant message that says nothing and asks for nothing is dropped from the request — and where
  dropping it would leave two turns of one role side by side, which both dialects refuse, it stays and
  carries a neutral marker saying the turn produced no content. A turn that carries `tool_calls` is
  never a candidate, so no tool result is ever left answering a call that is no longer in the request.
  The agent loop stops pushing zero-content assistant turns in the first place, while still recording
  every turn that asked for something, because the provider expects the turn that asked for tools to be
  present when its results come back. The repair is on the wire and never on disk: a stored transcript
  is the user's record of what was said, so those turns are left exactly as they were written — no
  transcript version moves, and old and new sessions are repaired alike. The wire-level regression suite
  pins the messages array a run actually puts in a request body and was recorded red on the defective
  tree: three failures, each naming an assistant message with empty content.
- The v1.4.0 baseline is everything before this entry: Phases 1 through 75, which shipped under the
  standing versioning rule that a release names the work since the last one. This entry is v1.4.1 —
  Phase 76.

<br>

## 2026-10-07: v1.4.0 — Command-line engines, an Engines rail entry and the consent shield

- **A command-line engine is a first-class execution path beside the Sam loop.** Phase 70 carries the
  spawn law in one place: the spawn happens in main only, arguments are handed over as arrays,
  `shell: true` is never used, the binary is resolved from an allowlist with a user override, and its
  version is probed before a turn. An ACP client was proven against a fixture peer, and the ChatGPT
  (Codex) pilot rides the JSONL dialect that probe proved — marking via-Codex tool calls and taking its
  consent from the sandbox flag. The engine picker locks at session start, a consent bridge carries the
  prompt, the child's stdin is closed when the turn ends, the session list row names the engine that
  ran the turn, and engine sessions are left unpriced in the Cost tile.
- **Engines becomes the ninth settings rail entry.** Phase 71 re-probes the binary path override when
  it is saved and exposes each engine's permission mode over the three traced sandbox values.
- **The Kimi (Moonshot) engine arrives on the ACP path.** Phase 72 rides the path the live probe
  proved, with the shield's per-call consent as its whole consent surface, and a refused turn is
  rendered legible — the peer's error is retained and no failed turn is left thinking.
- **The OpenCode engine arrives on the ACP path.** Phase 73 rides the path the probe proved with the
  shield's per-call consent, states the spawn law's one-name-per-engine rule with an empty install
  pattern and the desktop GUI named as a binary the law refuses, and the ACP second-turn lifecycle fix
  ends the child's whole tree and bounds every call so no engine turn is ever silent.
- **The chat pane is polished in three places.** The transcript scrolls vertically only, and the
  containment that keeps it inside the box is on the prose itself: a long inline code span inside a list
  item, a heading or a blockquote was an unbreakable run that painted past its bubble and left a
  horizontal scrollbar under the answer, so every block markdown can draw prose in now wraps — while the
  fenced code block and the table wrapper keep their own horizontal scroll exactly as they were. The Tools
  panel opens on the MCP servers tab when nothing has been chosen yet, with the tab order and the panel's
  own memory of a reader's choice unchanged. And the chat header names the session's working folder in a
  compact chip between the pickers and the auto-approve control, carrying the whole root path in its
  tooltip and drawing nothing at all for a session with no project.
- The v1.3.0 baseline is everything before this entry: Phases 1 through 69, which shipped under the
  standing versioning rule that a release names the work since the last one. This entry is v1.4.0 —
  Phases 70 through 75.

<br>

## 2026-10-06: v1.3.0 — Settings rail, buddy avatars and auto-update

- **Settings becomes a rail down the left.** The sections are chosen from a fixed vertical column of
  compact stacked entries rather than a strip across the top, so the list stays put in its own column
  while the section beside it scrolls, and the back control above it returns to the workbench.
- **Every buddy draws a face in the picker**, on the trigger and in each row of the dropdown: a letter
  badge taken from the buddy's own name, and the app's own logo mark for the default Agent Sam entry
  that has no letter to give.
- **Each MCP server in the Tools rail carries one stateful start/stop button** in place of the pair it
  used to carry, and its glyph is the status itself — the transitioning states and the retry state
  included — so the control and the answer to what a server is doing cannot disagree.
- **The app updates itself.** A check runs on `electron-updater` over the github publish configuration
  this packaging already writes, stays on the non-prerelease channel, and happens only in a packaged
  build: the first check is delayed past launch rather than run during it, then repeats on a four-hour
  interval. A download runs in the background when the persisted auto-download preference says so, and
  an update that has arrived is installed on quit by default.
- **Updates becomes the eighth settings rail entry**, carrying the version it speaks for, when the last
  check was, the status word the rule gives the current state, and the toggle with the check, download
  and install controls beside it.
- **A downloaded update is announced once**, by a notice over the main area with its restart-to-install
  action: the one updater state that needs an answer is announced where it will be seen rather than
  filed under the rail entry with the settings nobody has to act on.
- The v1.2.0 baseline is everything before this entry: Phases 1 through 66, which shipped under the
  standing versioning rule that a release names the work since the last one. This entry is v1.3.0 —
  Phases 67 and 68, which are the two groups above.

<br>

## 2026-10-05: v1.2.0 — Documents, view acts and appearance

- **Documents open in the app.** A name is read once by a pure `previewKind` dispatch — `pdf`, `docx`,
  `doc`, `image`, `markdown`, `spreadsheet` or `other` — and that one answer is what both the Preview
  resident and the Code panel's preview pane mount from, so the two surfaces cannot disagree about what a
  file is. A **PDF** is drawn on `pdfjs-dist`, loaded as its own lazy chunk against a same-origin worker,
  with zoom, page navigation and a download button in its toolbar; a **DOCX** goes through `mammoth` and
  reaches the pane as pruned HTML rather than as the converter's raw output; a legacy **`.doc`** — a
  different container that this app cannot render at all — gets a card offering **Open externally**; and
  a read that failed, or a file past the reader's cap, gets a card naming the file and the code behind
  the refusal rather than an empty pane.
- **The titlebar carries four view acts**, immediately before the theme toggle and in the order the View
  menu lists them: **Zoom In**, **Zoom Out**, **Actual Size** and **Toggle Fullscreen**, over a bounded
  zoom ladder whose step and ceiling are declared in the protocol rather than inside the button.
- **Appearance becomes a settings section**, holding the two preferences that are about a conversation as
  drawn: **bubble alignment**, split as it has always been or both sides on the same side, and the **chat
  font preset** — 12.5, 13, 15 or 17 pixels, with 13 the default because that is the size a message body
  was already painted at. The transcript gains a **hover action row at the bottom of every bubble** —
  **Copy** on both kinds, **Edit** on the user's own, **Regenerate** on the agent's — and every step
  becomes a **collapsible row** with its own status glyph: folded shut when it lands, opened again while
  the turn is in flight, a manual toggle left where the user put it, and never the answer — the prose a
  turn wrote stays visible whether or not a step is folded.
- The v1.1.0 baseline is everything before this entry: Phases 1 through 62, which shipped under the
  standing versioning rule that a release names the work since the last one. This entry is v1.2.0 —
  Phases 63, 64 and 65, which are the three groups above.

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
