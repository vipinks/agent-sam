import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Braces, FileCode, GitCompare, Lock, Pencil, Save, TriangleAlert, X } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { DiffView } from './diff-view'
import { gitErrorMessage } from './changes'
import { canEdit, decideConflict, insertTab, isDirty, writeErrorMessage } from './editing'
import { gutterText } from './gutter'
import { editorHighlightPlan, skipNote, utf8Bytes } from './highlight'
import { useHighlightedCode } from './use-highlight'
import { formatBytes, imageOf, type ImageRead } from './image'
import { MarkdownContent } from './markdown'
import { previewablePath } from './preview'
import { lossNotice, recordEdit, savedLossNotice, spreadsheetOf, type SpreadsheetEdit } from './spreadsheet'
import { SpreadsheetView } from './spreadsheet-view'
import { useWorkbenchStore } from './store'

/**
 * The main area's second half: whichever of a file or a change the user asked for last.
 *
 * The path comes from the explorer's selection and the contents from `workspace.readFile` in main; a
 * change selected in the Changes section takes over with `git.diff`, which main computes with the same
 * line-level diff the agent's write card renders. A failure is reported as an inline state, never
 * thrown at the React tree — the viewer is a panel, not a crash boundary.
 *
 * A change and a file are mutually exclusive by construction: each selection clears the other, so the
 * pane has one answer to "what is it showing" rather than two that could disagree about which was
 * clicked most recently.
 *
 * The editing rules live in `editing.ts`. What is here is the state they operate on — the baseline (the
 * content last known to be on disk), the buffer, and the two banners — plus the two things the rules
 * cannot express: that leaving edit mode keeps unsaved text, and that a save must not raise a conflict
 * banner against itself.
 */
export function CodeViewer() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)
  const selectedChange = useWorkbenchStore((s) => s.selectedChange)
  const setSelectedChange = useWorkbenchStore((s) => s.setSelectedChange)
  const setEditorDirty = useWorkbenchStore((s) => s.setEditorDirty)

  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)

  const file = conveyor.workspace.readFile.useQuery({
    input: { path: selectedFile ?? '' },
    enabled: selectedFile !== null,
    retry: false,
  })

  const diff = conveyor.git.diff.useQuery({
    input: {
      rootPath,
      path: selectedChange?.path ?? '',
      side: selectedChange?.side ?? 'unstaged',
      ...(selectedChange?.origPath ? { origPath: selectedChange.origPath } : {}),
    },
    enabled: selectedChange !== null,
    retry: false,
  })

  const save = conveyor.workspace.writeFile.useMutation()
  const saveSpreadsheet = conveyor.workspace.writeSpreadsheet.useMutation()

  /** True while the textarea is showing rather than the read-only render. */
  const [editing, setEditing] = useState(false)
  /**
   * Which of the two read-only views is showing: the source, or the file rendered.
   *
   * `code` is the default, so a markdown file looks exactly as it did before this existed, and a path
   * that cannot be previewed has nothing to switch to. Ephemeral UI state rather than store state: it
   * says how this pane is drawing one file, which is nobody else's business and not worth persisting.
   */
  const [view, setView] = useState<'code' | 'preview'>('code')
  /** The buffer. Null until something has been loaded to edit. */
  const [buffer, setBuffer] = useState<string | null>(null)
  /** What is believed to be on disk: the content last loaded, or last saved. */
  const [baseline, setBaseline] = useState<string | null>(null)
  /** A failed save, named by code. Cleared by the next attempt. */
  const [saveError, setSaveError] = useState<string | null>(null)
  /** A real conflict: the disk moved while the buffer held edits. */
  const [conflicted, setConflicted] = useState(false)
  /**
   * The mtime of the bytes this buffer is based on.
   *
   * Sent with every guarded save, and updated from the write that succeeds — so the second save in a
   * row is guarded against what the first one wrote rather than against the content that was loaded
   * before it. Null means there is no baseline to compare against, and the save goes unguarded, which
   * is the same thing an absent field means on the wire.
   */
  const [baselineMtime, setBaselineMtime] = useState<number | null>(null)
  /**
   * The conflict the last save reported, as opposed to the one a read reported.
   *
   * Kept apart from `conflicted` because the two are raised by different events and answered by
   * different buttons: a conflict on *read* means the disk already holds something else, and Refetch
   * content plus Reload are the ways out; a conflict on *write* means the disk changed between the
   * read and this save, and the way out is to overwrite deliberately or reload. Collapsing them would
   * make Keep mine claim to be deciding something it had not been told.
   */
  const [saveConflict, setSaveConflict] = useState(false)
  /**
   * Whether the workbook's grid is editable, and the edits typed into it.
   *
   * The list lives here rather than inside the grid for the same reason the text buffer does: the dirty
   * dot, the Save button and the conflict banner are this pane's chrome, and each of them needs one answer
   * to "is this file unsaved". The grid is handed the list to draw and a callback to add to it — never a
   * save, and never the file on disk.
   */
  const [workbookEditing, setWorkbookEditing] = useState(false)
  const [workbookEdits, setWorkbookEdits] = useState<SpreadsheetEdit[]>([])
  /**
   * The mtime the workbook's edits are based on.
   *
   * Sent with every guarded save and moved to what a write reported, exactly as the text editor's is, so
   * that a second save in a row is checked against what the first one left rather than against the bytes
   * that were loaded before it.
   */
  const [workbookMtime, setWorkbookMtime] = useState<number | null>(null)
  /**
   * The fidelity warning, and whether it has been answered.
   *
   * Two flags rather than one because the confirmation is one-time per file: cancelling leaves the grid
   * read-only and asks again on the next attempt, while continuing is remembered so that a user who goes
   * back into the grid does not have to agree to the same sentence twice. Both are dropped when the path
   * changes — a confirmation about one file says nothing about the next.
   */
  const [workbookPrompt, setWorkbookPrompt] = useState(false)
  const [workbookConfirmed, setWorkbookConfirmed] = useState(false)
  /** What the last save did not keep, for the caption. Wording is `savedLossNotice`'s. */
  const [workbookSaveNote, setWorkbookSaveNote] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // The edit-mode gutter, moved by copying the textarea's scroll offset rather than by scrolling itself:
  // the textarea owns the scroll position in that mode, and this is the element told about it.
  const gutterRef = useRef<HTMLDivElement>(null)
  // The edit-mode backdrop, moved the same way: the tokens for the buffer, painted underneath the field
  // that holds it. It is only ever painted and scrolled — never read back — which is what keeps it from
  // becoming a second source of truth for the text on screen.
  const backdropRef = useRef<HTMLPreElement>(null)

  // Mirrors of the two contents, so a decision can be read synchronously when a read lands. React
  // state alone would mean nesting one updater inside another to see both at once, which is a shape
  // that gets the wrong answer under batching.
  const bufferRef = useRef<string | null>(null)
  const baselineRef = useRef<string | null>(null)
  const mtimeRef = useRef<number | null>(null)
  // Mirrored from state on every render, the way the chat pane mirrors its transcript. Without this the
  // refs would only move when a read or a save set them, so a keystroke would leave `applyRead`
  // comparing against the content that was loaded — reading the user's edits as "no edits" and taking
  // the clean branch, which throws the edits away. That was a real bug here, caught by the suite.
  bufferRef.current = buffer
  baselineRef.current = baseline
  mtimeRef.current = baselineMtime
  // The window-level Ctrl+S is registered once per mounted viewer and reads the latest handler through
  // a ref, so binding it does not re-attach the listener on every keystroke.
  const saveRef = useRef<() => void>(() => {})

  const readCode = file.error instanceof ConveyorError ? file.error.code : null
  /**
   * The image being shown, or null when what is open is text — or when nothing has arrived yet.
   *
   * A second kind rather than a flag, and deliberately not derivable from the error: everything this
   * pane branches on is either "is there an image" or "what error came back", and keeping those apart
   * is what lets the text branches stay exactly as they were. A file the pane cannot render either way
   * — an image that is gone, an image over the cap — is an error, not an image, so it lands in the
   * states that were already here.
   */
  const image = imageOf(file.data) ? file.data : null
  /**
   * The workbook being shown, or null when what is open is something else.
   *
   * A third kind alongside the image, and it is a kind rather than a flag for the same reason: the pane
   * branches on which of the three shapes arrived, not on a boolean that could disagree with what is
   * actually in `file.data`. A workbook the viewer could not read — over the cap, locked, unparseable —
   * is an error rather than a workbook, so it lands in the states that were already here instead of
   * drawing an empty grid over a failure.
   */
  const spreadsheet = spreadsheetOf(file.data) ? file.data : null
  // Neither an image nor a workbook has characters to put in a textarea, so neither offers the editor.
  // This is the only place the two are treated alike, and they are alike for exactly this reason.
  const editable = selectedFile !== null && image === null && spreadsheet === null && canEdit(readCode)
  // A workbook's unsaved work is its edit list and a text file's is its characters, and only one of the
  // two is ever non-empty — so the dot, the Save button and the store's dirty flag all mean the same thing
  // in both panes without either of them having to know which kind is open.
  const dirty = isDirty(baseline, buffer) || workbookEdits.length > 0
  /**
   * What a save of this workbook would not preserve, or null when nothing is at risk.
   *
   * Assembled from the fidelity of the read the grid was drawn from, and from the probe's measurements
   * rather than from a general fear of writers — see `lossNotice`. This is the sentence the confirmation
   * shows, and it exists as a value here so the same one is used to decide whether to ask at all.
   */
  const workbookLoss = spreadsheet === null ? null : lossNotice(spreadsheet.fidelity)

  const showingDiff = selectedChange !== null

  /**
   * Whether this file offers the Code | Preview switch at all.
   *
   * Four things have to be true, and each of them is about what is actually on screen rather than
   * about the path alone: the path has to be markdown (`previewablePath`), the pane has to be showing a
   * file rather than a diff, the read has to have succeeded — a file the viewer could not read has
   * nothing to render, so a preview of it would be a second way to show the same error — and it must
   * not be an image or a workbook, which this pane draws through branches of their own. A markdown
   * preview of a spreadsheet is the rendering that would make least sense.
   */
  const previewable =
    !showingDiff &&
    !file.error &&
    !file.isLoading &&
    image === null &&
    spreadsheet === null &&
    selectedFile !== null &&
    previewablePath(selectedFile)
  const preview = previewable && view === 'preview'

  /**
   * The read view's text, and its tokens.
   *
   * `buffer ?? disk` is the string this pane has always shown in its read-only branch, so the tokens
   * describe exactly what is on screen — including a buffer holding unsaved edits, which is still what
   * the user is reading after leaving edit mode.
   *
   * Nothing is tokenized while the textarea or the diff is showing. The diff already carries its own
   * meaning per line, and colouring its tokens too would be two encodings competing for the same
   * channel; the editor is the user's own text, where highlighting would cost work on every keystroke
   * for output a textarea cannot render anyway. Passing null is how that is said once, here, rather
   * than as a condition inside the render.
   *
   * The string is read only from a result that actually carries one, and *checked* rather than assumed.
   * The client's inferred result type carries the three kinds' fields as optional — `mime` and `dataUrl`
   * on the image result, `sheets` on the workbook one, and `content` here — so the compiler sees
   * `string | undefined` where the domain says a text result always has a string. The check is what
   * reconciles the two, and it is the same shape `imageOf` and `spreadsheetOf` use: ask at runtime, then
   * use.
   */
  const readText = file.data !== undefined && typeof file.data.content === 'string' ? file.data.content : ''
  const readContent = buffer ?? readText
  // The preview and the workbook are drawn, not tokenized: there are no tokens to paint, so none are
  // computed while either is on screen — and, for the same reason, no note about a cap neither of them
  // has either.
  const plainView = showingDiff || editing || preview || spreadsheet !== null
  const { plan, html } = useHighlightedCode(plainView ? null : selectedFile, plainView ? null : readContent)
  const highlightNote = plan === null ? null : skipNote(plan)

  /**
   * The editor's own tokens: the same buffer the textarea holds, through the same module and memo.
   *
   * The plan is asked for by *size*, because size is the editor's only question about a file here: a
   * keystroke in a file over the cap must not pay for tokenizing, and must not render a layer that
   * could not be kept in step with the field for nothing. A language the viewer has no grammar for
   * lands in the same place for a different reason — there are no tokens to paint — and the note is
   * what tells the reader which of the two happened.
   *
   * The render branches on `editBackdrop` rather than on the mode: `sync` and `async` both paint
   * tokens, and differ only in whether they are ready for the render that asked for them. The deferred
   * ones are handled in the render itself, where the buffer stands in until they arrive.
   */
  const editPlan = useMemo(
    () =>
      editing && buffer !== null && selectedFile !== null ? editorHighlightPlan(selectedFile, utf8Bytes(buffer)) : null,
    [editing, buffer, selectedFile]
  )
  const editBackdrop = editPlan !== null && editPlan.mode !== 'plain'
  const editNote = editPlan === null ? null : skipNote(editPlan)
  const { html: editHtml } = useHighlightedCode(editBackdrop ? selectedFile : null, editBackdrop ? buffer : null)

  /**
   * The two gutters' text, one per view, each the lines of the string that view is showing.
   *
   * Memoized on the content rather than built during the render: numbering a half-megabyte file is a
   * string of thousands of numbers, and this pane re-renders for reasons that have nothing to do with
   * its text — tokens arriving, a store change elsewhere.
   *
   * The edit gutter is the buffer's; `''` only stands in while no file is loaded, when the textarea and
   * therefore the gutter are not on screen at all.
   */
  const readGutter = useMemo(() => gutterText(readContent), [readContent])
  const editGutter = useMemo(() => gutterText(buffer ?? ''), [buffer])

  /**
   * Adopt freshly read content, or refuse to.
   *
   * The three-way decision is the point. A read arriving while the buffer is clean is the ordinary
   * refetch this viewer always did — the disk is simply what the file is now. A read whose content
   * still matches the baseline is not a conflict however it was triggered: the disk did not move, so
   * the unsaved edits stay exactly where they are and nothing is said. Only a real divergence raises
   * the banner, and a real divergence is never silently dropped.
   *
   * Adopting on the middle branch would throw away the user's edits, which is the bug this branch
   * exists to avoid.
   */
  const applyRead = useCallback((content: string, mtime: number | null) => {
    const current = bufferRef.current
    const base = baselineRef.current

    // No buffer yet: this is the file being opened, so the read is simply what it is now.
    if (current === null || base === null) {
      bufferRef.current = content
      baselineRef.current = content
      setBuffer(content)
      setBaseline(content)
      setBaselineMtime(mtime)
      setConflicted(false)
      return
    }

    const decision = decideConflict({ baseline: base, local: current, disk: content })

    if (decision === 'conflict') {
      // The buffer is deliberately left alone — the user's text is what is at stake — while the
      // baseline moves to what is actually on disk, so a later "Keep mine" overwrites the real
      // current content rather than a stale idea of it. The mtime moves with it, so the overwrite is
      // guarded against the bytes that are genuinely there.
      baselineRef.current = content
      setBaseline(content)
      setBaselineMtime(mtime)
      setConflicted(true)
      return
    }

    if (decision === 'dirty') {
      // Nothing to adopt and nothing to warn about: the disk still holds what was loaded. The mtime is
      // left as it is for the same reason as the content — the buffer is still based on those bytes,
      // and that is exactly what its next save should be checked against.
      setConflicted(false)
      return
    }

    // Clean: nothing of the user's is unsaved, so the fresh content is adopted along with its mtime.
    bufferRef.current = content
    baselineRef.current = content
    setBuffer(content)
    setBaseline(content)
    setBaselineMtime(mtime)
    setConflicted(false)
  }, [])

  // Every arriving read: the first one, a refetch after an external change, a reload after a conflict.
  useEffect(() => {
    if (file.data === undefined || selectedFile === null) return
    // An image read carries no text, and the buffer machinery below is about characters: there is
    // nothing to adopt, nothing to compare against, and no way for an external change to conflict with
    // a picture. Skipping it here is what keeps the buffer's states out of the image branch entirely.
    if (imageOf(file.data)) return
    // A workbook is the same case for a different reason: a sheet is not characters either, so there is
    // no buffer to hold it and no edit to lose. It is skipped rather than adopted as a string, which is
    // also why opening a workbook over an unsaved buffer cannot raise a conflict banner — the buffer is
    // dropped when the path changes, and a path change is the only way to reach this branch.
    if (spreadsheetOf(file.data)) {
      // A workbook's grid holds no characters to adopt, but it does have a baseline: every arriving read
      // is the current state of the file, so its mtime is what the next save from this grid has to be
      // checked against. Without this the first save would be unguarded.
      setWorkbookMtime(file.data.baselineMtime ?? null)
      return
    }
    const content = file.data.content
    // A read with no text is a read this machinery has nothing to do with. The two guards above cover the
    // kinds this pane draws itself; this one covers the shape of the result rather than the kind, and it
    // is a check rather than a cast because the field is optional in the client's inferred result type.
    if (typeof content !== 'string') return
    setSaveError(null)
    // A read that lands is also the way out of a save conflict: the content and the mtime have just
    // been refreshed, so the banner's question has been answered.
    setSaveConflict(false)
    applyRead(content, file.data.baselineMtime ?? null)
  }, [file.data, file.dataUpdatedAt, selectedFile, applyRead])

  /** Everything the buffer holds, dropped when the file changes. A buffer belongs to one path. */
  useEffect(() => {
    bufferRef.current = null
    baselineRef.current = null
    setBuffer(null)
    setBaseline(null)
    setBaselineMtime(null)
    setSaveError(null)
    setConflicted(false)
    setSaveConflict(false)
    setEditing(false)
    // A workbook's editing state belongs to one path for exactly the same reason, and the confirmation
    // goes with it: it was about the file that has just been closed.
    setWorkbookEditing(false)
    setWorkbookEdits([])
    setWorkbookMtime(null)
    setWorkbookPrompt(false)
    setWorkbookConfirmed(false)
    setWorkbookSaveNote(null)
    // A new file starts in Code, the way an opened file always has: the preview is a choice about the
    // file in front of the user, and a choice made about one file is not a default for the next.
    setView('code')
  }, [selectedFile])

  // Publish the dirty flag for the change handler, which lives outside React and cannot read state.
  useEffect(() => {
    setEditorDirty(selectedFile, dirty)
  }, [dirty, selectedFile, setEditorDirty])

  /**
   * Save the buffer, guarded by the mtime it is based on.
   *
   * `force` is only ever true on the second, deliberate attempt after a conflict was shown — never
   * inferred from a failure. Two failures in a row are an ordinary failure, not a licence to overwrite
   * whatever is on disk.
   */
  const onSave = useCallback(
    async (force = false) => {
      if (selectedFile === null || buffer === null) return
      setSaveError(null)
      try {
        const written = await save.mutateAsync({
          path: selectedFile,
          content: buffer,
          rootPath: rootPath ?? '',
          // Absent rather than null when there is no baseline: the field means "compare against this",
          // and an absent field is what an unguarded write looks like on the wire.
          ...(mtimeRef.current === null ? {} : { baselineMtime: mtimeRef.current }),
          ...(force ? { force: true } : {}),
        })

        // The saved content is what is on disk now, so it becomes the baseline and the buffer stops
        // being dirty. This is also what makes our own event harmless: the read it triggers carries the
        // bytes the baseline already holds, so it resolves as clean and raises no banner. The self-write
        // case is handled by the decision rather than by a flag saying "this one was mine".
        baselineRef.current = buffer
        setBaseline(buffer)
        // The mtime the write reported, so the next save in a row is guarded against what this one
        // left rather than against what was loaded before it.
        setBaselineMtime(written.mtimeMs)
        setConflicted(false)
        setSaveConflict(false)
      } catch (err) {
        // Branched on the code, never on the message. The code rides along in the banner too, because it
        // is the half that does not move when the wording does.
        const code = err instanceof ConveyorError ? err.code : 'UNKNOWN'
        // A refused write is its own state: the buffer is still the user's, the disk still holds the
        // other version, and the ways out are to overwrite deliberately or to take the disk. Every
        // other failure keeps the existing banner, which says the edits are still here.
        if (code === 'WRITE_CONFLICT') setSaveConflict(true)
        else setSaveError(code)
      }
    },
    [buffer, rootPath, save, selectedFile]
  )

  /**
   * Record one cell's typing.
   *
   * Stable across renders on purpose: the grid's rows are memoized on their props, and a callback whose
   * identity changed every render would redraw every row on every keystroke — which is the cost the memo
   * exists to avoid. What the cell displayed is passed along with the typing, because only the pane knows
   * it and the collector needs it to tell a real edit from a cell typed back to what it already said.
   */
  const onWorkbookEdit = useCallback((edit: SpreadsheetEdit, displayed: string) => {
    setWorkbookEdits((current) => recordEdit(current, edit, displayed))
  }, [])

  /**
   * Save the workbook's edits, guarded by the mtime the grid was drawn from.
   *
   * The same shape as the text save and for the same reasons: `force` is only ever true on the second,
   * deliberate attempt after a conflict has been shown, a failure is branched on by code rather than by
   * message, and a success clears the edits so the file stops being dirty while main's own change event
   * refetches it — which is what redraws the grid from the bytes that are actually on disk.
   *
   * The caption note is computed here, from the fidelity that was in hand when the edits were made.
   * This is the only moment at which the loss is knowable: once the new bytes have been read, a chart the
   * save did not write back is simply a chart the file does not have, and nothing in the fresh read can
   * say it was ever there.
   */
  const onSaveWorkbook = useCallback(
    async (force = false) => {
      if (selectedFile === null || workbookEdits.length === 0) return
      setSaveError(null)
      try {
        const written = await saveSpreadsheet.mutateAsync({
          path: selectedFile,
          edits: workbookEdits,
          // Absent rather than null when there is no baseline, exactly as the text save sends it: the field
          // means "compare against this", and an absent one is what an unguarded write looks like.
          ...(workbookMtime === null ? {} : { baselineMtime: workbookMtime }),
          ...(force ? { force: true } : {}),
        })

        setWorkbookSaveNote(
          savedLossNotice({
            // From the read the edits were made against, because the refetch that follows describes the
            // file as it now is — and a chart is absent from it either way.
            hadCharts: spreadsheet?.fidelity.hasCharts === true,
            replacedFormulas: written.replacedFormulas,
          })
        )
        setWorkbookEdits([])
        // The mtime this write reported, so the next save in a row is guarded against what it left rather
        // than against the bytes the grid was originally drawn from.
        setWorkbookMtime(written.mtimeMs)
        setSaveConflict(false)
        // Asked for explicitly rather than waited for. The text editor does not need this — its buffer
        // already holds the text it just wrote — but a grid's displayed values come from the read, so
        // clearing the edits leaves it showing the file as it was until a read lands. Main's own change
        // event would usually bring one; this makes the grid correct whether or not it arrives.
        void conveyor.workspace.readFile.invalidate({ path: selectedFile })
      } catch (err) {
        // Branched on the code, never on the message. A refused write is its own state here too: the edits
        // are still the user's, the disk still holds the other version, and the banner's two answers are
        // to take the disk or to overwrite it deliberately.
        const code = err instanceof ConveyorError ? err.code : 'UNKNOWN'
        if (code === 'WRITE_CONFLICT') setSaveConflict(true)
        else setSaveError(code)
      }
    },
    [saveSpreadsheet, selectedFile, spreadsheet, workbookEdits, workbookMtime]
  )

  /**
   * The save the pane's one Save button, its one keystroke and its banner's “Keep mine” all reach.
   *
   * Which of the two savers runs is decided by what the read returned rather than by which mode the pane is
   * in, and that is deliberate: a conflict raised by a save has to stay answerable after the user has
   * walked away from the grid, and a dispatcher keyed on the open file answers it the same way whether or
   * not the fields are still on screen.
   */
  const saveOpenFile = useCallback(
    (force = false) => (spreadsheet === null ? onSave(force) : onSaveWorkbook(force)),
    [onSave, onSaveWorkbook, spreadsheet]
  )

  saveRef.current = () => void saveOpenFile()

  // Ctrl+S, while editing. Bound to the document rather than to the textarea so it works wherever the
  // focus happens to be inside the pane — a save that only fires when the caret is in one specific element
  // is a save the user cannot rely on. A grid of fields is that case at its widest: there are as many
  // places for the focus to be as there are cells, and a keystroke that only worked from one of them would
  // be a keystroke that usually did nothing.
  useEffect(() => {
    if (!editing && !workbookEditing) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing, workbookEditing])

  /**
   * Refetch the file, dropping whatever the pane is holding. Reload is the user choosing the disk.
   *
   * Both kinds are dropped, because both are the same choice: a text buffer's characters and a workbook's
   * edit list are unsaved work, and the button that takes the disk over one takes it over the other. The
   * grid follows the read that lands: with no edit left to show, a field falls back to the value the file
   * now has.
   */
  const reload = useCallback(() => {
    setConflicted(false)
    setSaveConflict(false)
    setSaveError(null)
    bufferRef.current = null
    baselineRef.current = null
    setBuffer(null)
    setBaseline(null)
    setBaselineMtime(null)
    setWorkbookEdits([])
    setWorkbookMtime(null)
    setWorkbookSaveNote(null)
    if (selectedFile) void conveyor.workspace.readFile.invalidate({ path: selectedFile })
  }, [selectedFile])

  const fileName = selectedFile ? (selectedFile.split(/[\\/]/).pop() ?? selectedFile) : ''

  /**
   * The file line: the path, the dirty dot, and the toggle when the file can be edited at all.
   *
   * Suppressed entirely for an image, which has no text to edit. The path, the dirty dot and the toggle
   * are a text file's chrome, and the disabled `read-only` fallback would say something different — that
   * the file was refused — when the truth is that an editor has nothing here to hold.
   *
   * A workbook keeps all of it, and the dot means the same thing there: its unsaved work is its edit list.
   * What it must not show is `read-only`: that label is the viewer saying it declined to open a *text*
   * file, and a workbook was never a text file to decline. The two toggles are separate controls rather
   * than one with a mode, because what they open is not the same thing — one holds characters and the other
   * holds values — and a single button would have to pick a noun for one of them.
   */
  const toolbar = !showingDiff && selectedFile && image === null && (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3">
      <p className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={selectedFile}>
        {selectedFile}
      </p>

      {dirty && (
        <span
          role="status"
          aria-label={`${fileName} has unsaved changes`}
          title="Unsaved changes"
          className="size-2 shrink-0 rounded-full bg-brand"
        />
      )}

      {/*
        The Code | Preview switch, offered only for a file that can be rendered as markdown and only
        while the editor is closed. Preview is read-only by construction — the way to type is to edit —
        so the two are never both available, which is what keeps "the preview is not an editor" true by
        the shape of the render rather than by a condition inside it.

        The pressed state is on both buttons rather than on the pair, so a screen reader is told which
        view is showing as well as what the other one would do.
      */}
      {previewable && !editing && (
        <div role="group" aria-label="Preview mode" className="flex shrink-0 items-center gap-0.5">
          <Button
            variant={preview ? 'ghost' : 'secondary'}
            size="xs"
            aria-pressed={!preview}
            title="Show the source"
            onClick={() => setView('code')}
          >
            Code
          </Button>
          <Button
            variant={preview ? 'secondary' : 'ghost'}
            size="xs"
            aria-pressed={preview}
            title="Render the markdown"
            onClick={() => setView('preview')}
          >
            Preview
          </Button>
        </div>
      )}

      {(editing || workbookEditing) && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Save file"
          disabled={!dirty}
          onClick={() => void saveOpenFile()}
        >
          <Save />
        </Button>
      )}

      {spreadsheet !== null ? (
        /*
          The workbook's toggle: the same affordance as the text editor's, with one thing in front of it.

          Nothing about a workbook is a secret — the grid is a field per shown cell because a value is all
          this pane can change, and it says so by being fields rather than by being a form with options. The
          confirmation comes first because a save is not undoable, and the honest moment to say what one will
          not keep is before the user has typed anything worth keeping.
        */
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={workbookEditing ? 'Stop editing the workbook' : 'Edit this workbook'}
          aria-pressed={workbookEditing}
          onClick={() => {
            // Leaving the grid keeps the edits exactly as they are: the unsaved values stay recorded, the
            // dirty dot stays, and coming back finds the same text in the same cells. Only closing the file
            // or a Reload drops them.
            if (workbookEditing) {
              setWorkbookEditing(false)
              return
            }
            // The one-time confirmation. Cancelling leaves the grid read-only with nothing recorded, and
            // the next attempt asks again — which is what makes refusing free.
            if (workbookLoss !== null && !workbookConfirmed) {
              setWorkbookPrompt(true)
              return
            }
            setWorkbookEditing(true)
          }}
        >
          {workbookEditing ? <Lock /> : <Pencil />}
        </Button>
      ) : editable ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={editing ? 'Stop editing' : 'Edit this file'}
          aria-pressed={editing}
          onClick={() => {
            // Leaving to edit is leaving the preview first: the editor holds the characters, and a
            // rendering of a file the user is in the middle of changing would be a picture of
            // something that no longer exists. The view moves even when the toggle is going to be
            // withdrawn, so coming back from the editor lands in Code rather than in a stale preview.
            setView('code')
            // Leaving edit mode keeps the buffer exactly as it is: the unsaved text stays, the dirty dot
            // stays, and coming back finds the same characters. Only closing the file drops them.
            setEditing((current) => !current)
            // Focus follows the mode, so entering edit puts the caret where the user expects it.
            requestAnimationFrame(() => textareaRef.current?.focus())
          }}
        >
          {editing ? <Lock /> : <Pencil />}
        </Button>
      ) : (
        // A file the reader refused: there are no contents to edit, and an editor over an empty buffer
        // would overwrite a file nobody has seen. A workbook never reaches this branch — it has a toggle of
        // its own above, because a grid of values is something this pane can change, and `read-only` would
        // be a claim about a refusal that did not happen.
        <span className="shrink-0 text-[10.5px] text-muted-foreground" title="Too large to edit">
          read-only
        </span>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader
        icon={showingDiff ? GitCompare : FileCode}
        title={
          showingDiff
            ? 'Diff'
            : image !== null
              ? 'Image'
              : spreadsheet !== null
                ? 'Spreadsheet'
                : selectedFile
                  ? `Code${editing ? ' · editing' : ''}`
                  : 'Code Viewer'
        }
      >
        {(showingDiff || selectedFile) && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close preview"
            onClick={() => {
              setSelectedChange(null)
              setSelectedFile(null)
            }}
          >
            <X />
          </Button>
        )}
      </PaneHeader>

      {showingDiff ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3">
            <span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              {selectedChange.side === 'staged' ? 'staged' : 'unstaged'}
            </span>
            <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={selectedChange.path}>
              {selectedChange.path}
            </p>
            {selectedChange.origPath && (
              <span className="shrink-0 text-[10.5px] text-muted-foreground" title={selectedChange.origPath}>
                ← renamed from {selectedChange.origPath}
              </span>
            )}
          </div>

          {diff.isLoading ? (
            <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">Loading…</div>
          ) : diff.error ? (
            <DiffError error={diff.error} />
          ) : (
            // `fill` is the pane's height policy: the diff is the whole point of this pane, so it takes
            // the pane's height and scrolls inside itself. Without it the card's cap travels here and the
            // region stops at content-or-cap height, leaving dead space below. The host keeps
            // `overflow-auto` rather than `overflow-hidden` so that if the chain ever fails to contain a
            // diff, the overflow is still reachable by scrolling instead of being silently clipped.
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {diff.data && <DiffView diff={diff.data} fill className="mt-0" />}
            </div>
          )}
        </div>
      ) : !selectedFile ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Braces className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">No file open</p>
            <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
              Pick a file from the explorer and it opens here, or pick a change to see its diff.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {toolbar}

          {/*
            The confirmation before the first edit of a workbook, and the only place in this pane where a
            loss is stated *before* it can happen. It is raised from the read's own fidelity report and
            worded by `lossNotice`, which names what this particular file will not keep — measured against
            this writer rather than guessed at — and it is asked once per file, because a user who has
            already agreed to it is not helped by being asked again.

            Cancel is not a "no" that needs remembering: it closes the prompt, records nothing and leaves
            the grid read-only, so the next attempt simply asks again. That is what lets the question stay
            honest for the whole session instead of becoming a dialog to dismiss.
          */}
          {workbookPrompt && workbookLoss !== null && (
            <div
              role="alert"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-brand/40 bg-brand-soft/40 px-3 py-1.5 text-[11.5px]"
            >
              <TriangleAlert className="size-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1">{workbookLoss}</span>
              <Button variant="outline" size="sm" onClick={() => setWorkbookPrompt(false)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setWorkbookPrompt(false)
                  // Remembered, so that leaving the grid and coming back does not raise it again. It is the
                  // same file with the same contents, and the answer has not changed.
                  setWorkbookConfirmed(true)
                  setWorkbookEditing(true)
                }}
              >
                Continue
              </Button>
            </div>
          )}

          {/*
            A conflict reported by a *save*: the disk changed between the read and this write, so main
            refused it. Distinct from the banner below, and answered differently — the buffer is still
            unsaved and the disk still holds the other version, so the two ways out are to take the
            disk (Reload) or to overwrite it on purpose. Keep mine re-sends with `force`, which is a
            second deliberate click rather than an inference from the failure.

            One banner for both kinds of file, deliberately: a workbook edit list and a text buffer raise
            the same conflict for the same reason, and the two answers mean the same thing in both. Keep
            mine goes through the same dispatcher the Save button does, so it re-sends whichever file is
            open — with the edits or the characters that are still unsaved in it.
          */}
          {saveConflict && (
            <div
              role="alert"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-brand/40 bg-brand-soft/40 px-3 py-1.5 text-[11.5px]"
            >
              <TriangleAlert className="size-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1">
                This file changed on disk since you opened it, so your save was not written.
              </span>
              <Button variant="outline" size="sm" onClick={reload}>
                Reload
              </Button>
              <Button variant="outline" size="sm" onClick={() => void saveOpenFile(true)}>
                Keep mine
              </Button>
            </div>
          )}

          {conflicted && (
            <div
              role="alert"
              className="flex shrink-0 flex-wrap items-center gap-2 border-b border-brand/40 bg-brand-soft/40 px-3 py-1.5 text-[11.5px]"
            >
              <TriangleAlert className="size-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1">
                This file changed on disk while you have unsaved edits. Saving will overwrite it.
              </span>
              <Button variant="outline" size="sm" onClick={reload}>
                Reload
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConflicted(false)}>
                Keep mine
              </Button>
            </div>
          )}

          {saveError && (
            <div
              role="alert"
              className="flex shrink-0 items-start gap-2 border-b border-border bg-muted px-3 py-1.5 text-[11.5px]"
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">
                {writeErrorMessage(saveError)} <span className="font-mono text-muted-foreground">({saveError})</span>{' '}
                Your edits are still here.
              </p>
            </div>
          )}

          {file.isLoading && buffer === null ? (
            <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">Loading…</div>
          ) : file.error ? (
            <FileError error={file.error} path={selectedFile} />
          ) : image !== null ? (
            /*
              An image, and the only branch of this pane that hands bytes straight to the DOM. The
              field, the gutter and the backdrop are all *absent* rather than empty: none of the three
              has anything to show for a picture, and an empty one would be chrome around nothing.
            */
            <ImageView image={image} alt={fileName} />
          ) : spreadsheet !== null ? (
            /*
              A workbook, drawn as a grid of the file's own values. The gutter and the backdrop are as
              absent as they are for a picture — they number lines and paint tokens, and a table has
              neither.

              What the grid may change is exactly one thing: the value of a cell that is already shown.
              There is no formula to author, no style to set, and no row or column to insert — a ragged row
              stays ragged — because each of those is a decision about the shape of a workbook rather than
              about a value, and this pane does not make them.

              `key` on the path, so opening another workbook remounts the grid and the sheet on screen is
              sheet one of the file that is actually open. Without it React would keep the old component's
              state and a reader could land on sheet four of a workbook they had never seen. State that
              belongs to the file rather than to the grid — the edits, the baseline, the confirmation — is
              held above and dropped when the path changes, for the same reason.
            */
            <SpreadsheetView
              key={selectedFile}
              read={spreadsheet}
              editing={workbookEditing}
              edits={workbookEdits}
              onEdit={onWorkbookEdit}
              saveNote={workbookSaveNote}
            />
          ) : editing && buffer !== null ? (
            <>
              {/*
                The cap notice for the editor, worded from the same object the read view words its own
                from: a file the editor did not tokenize gets an opaque field and this sentence, for the
                same reason the read view gets both — a decision the viewer made, and silence would read
                as a highlighter that had failed rather than one that had declined.
              */}
              {editNote && (
                <p className="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-[11.5px] text-muted-foreground">
                  {editNote}
                </p>
              )}

              {/*
                The textarea is the only input here, and neither the gutter beside it nor the backdrop
                behind it changes that: the gutter is `aria-hidden`, `select-none` and `overflow-hidden`,
                so the numbers cannot be typed into, selected or scrolled, and the backdrop is
                `aria-hidden`, `pointer-events-none` and never read back, so the buffer is still exactly
                the characters the user typed. Both inherit the row's type and match the textarea's own
                vertical padding, which is what puts number N on line N and the tokens under the glyphs.

                The scroll position has one owner — the textarea — and the gutter and the backdrop are
                moved by copying it, the same shape as the read view having one scroller for both columns.
              */}
              <div className="flex min-h-0 flex-1 font-mono text-[12.5px] leading-relaxed">
                <div
                  ref={gutterRef}
                  data-slot="code-gutter"
                  aria-hidden="true"
                  className="shrink-0 overflow-hidden border-r border-border bg-muted py-4 pr-3 pl-4 text-right whitespace-pre text-muted-foreground/70 select-none"
                >
                  {editGutter}
                </div>

                {/*
                  The code column: the field, and behind it the same buffer through the same highlighter
                  and memo the read view uses. A textarea cannot hold markup, so the colour is painted
                  underneath it and the field's own text is made transparent to let the backdrop through;
                  the caret is not transparent, and the selection band is the field's own, so both stay
                  visible whichever way the eye lands on them.

                  The two elements carry the same font, size, line-height, padding and wrapping in the
                  same box (`inset-0`), so the glyphs coincide by sharing a layout rather than by being
                  tuned to match. A backdrop that could not line up would be worse than none.
                */}
                <div className="relative min-h-0 flex-1 bg-background">
                  {editBackdrop && (
                    <pre
                      ref={backdropRef}
                      data-slot="code-backdrop"
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 overflow-hidden p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre"
                    >
                      {editHtml === null ? (
                        // The deferred band, before its tokens arrive: with the field's text transparent
                        // an empty layer would be an invisible buffer, so the plain characters stand in
                        // for a moment. Uncoloured is the most this may ever degrade to.
                        <code>{buffer}</code>
                      ) : (
                        // The same escaped spans the read view renders, out of the same memo.
                        <code className="hljs" dangerouslySetInnerHTML={{ __html: editHtml }} />
                      )}
                    </pre>
                  )}

                  <textarea
                    ref={textareaRef}
                    aria-label={`Edit ${fileName}`}
                    value={buffer}
                    onChange={(e) => setBuffer(e.target.value)}
                    onKeyDown={(e) => {
                      // Tab indents rather than leaving the field. Without this the caret would move out of the
                      // editor and there would be no way to indent at all — the trade a plain textarea editor
                      // has to make, and the reason the rule is a function of its own.
                      if (e.key === 'Tab') {
                        e.preventDefault()
                        const { text, caret } = insertTab(
                          e.currentTarget.value,
                          e.currentTarget.selectionStart,
                          e.currentTarget.selectionEnd
                        )
                        setBuffer(text)
                        requestAnimationFrame(() => {
                          const area = textareaRef.current
                          if (!area) return
                          area.setSelectionRange(caret, caret)
                        })
                      }
                    }}
                    onScroll={(e) => {
                      // The offsets are copied rather than observed: neither the gutter's box nor the
                      // backdrop's can scroll itself — both are `overflow-hidden` — so these assignments
                      // are the only things that can move them. The backdrop takes both axes, being the
                      // field's twin under a line that does not wrap.
                      const area = e.currentTarget
                      const gutter = gutterRef.current
                      if (gutter !== null) gutter.scrollTop = area.scrollTop
                      const backdrop = backdropRef.current
                      if (backdrop !== null) {
                        backdrop.scrollTop = area.scrollTop
                        backdrop.scrollLeft = area.scrollLeft
                      }
                    }}
                    spellCheck={false}
                    // Wrapping off, so a long line scrolls rather than reflowing: the same fidelity the
                    // read-only render had, and the same metric the backdrop is laid out with.
                    wrap="off"
                    // Transparent only when there is a backdrop to read instead, and never transparent
                    // without a caret: the text is the layer below, not the field it is typed into.
                    className={`absolute inset-0 resize-none overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre outline-none ${
                      editBackdrop ? 'text-transparent caret-brand' : 'bg-background'
                    }`}
                  />
                </div>
              </div>
            </>
          ) : preview ? (
            /*
              The preview: the file's own characters through the renderer the chat already uses, and
              nothing else. No gutter and no tokens, because neither describes a rendering — the numbers
              mark place in the source and the tokens are the source's own colouring, and both belong to
              the view that shows the source.

              Read-only and display-only: there is no field here, and the switch above is the only
              control over what this branch draws. Nothing is handed to the DOM as markup — the render is
              the same `<Markdown>` the chat has always trusted, and no `dangerouslySetInnerHTML` was
              added for a file's contents.
            */
            <div data-slot="markdown-preview" className="min-h-0 flex-1 overflow-auto p-4">
              {/*
                An empty file has a preview too: nothing to render. The chat's renderer answers empty
                content with "Thinking…", which is a sentence about a stream that has not started — a
                file the user opened is not a stream, so the preview says what is true of the file.
              */}
              {readContent.trim() === '' ? (
                <p className="text-[12.5px] text-muted-foreground">This file is empty.</p>
              ) : (
                <MarkdownContent content={readContent} />
              )}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/*
                The cap notice, and the only thing the viewer explains about its own rendering: a file
                it did not tokenize is a decision it made, and without a word it would read as a
                highlighter that had failed rather than one that had declined.
              */}
              {highlightNote && (
                <p className="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-[11.5px] text-muted-foreground">
                  {highlightNote}
                </p>
              )}

              {/*
                One scroll container for both columns, which is the whole reason the numbers cannot
                drift from the source: there is a single scroll position, so there is nothing to keep
                in step. The gutter is a sibling of the code inside it rather than a box of its own,
                and the row carries the type both columns use, so their line boxes are the same height
                by construction instead of by two sets of classes matching.

                The row is `w-max` so a long line makes the row wider than the pane and the scroller
                scrolls horizontally; the numbers are `sticky left-0` so that scroll carries the code
                past them instead of taking them off screen with it.
              */}
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="flex min-h-full w-max min-w-full font-mono text-[12.5px] leading-relaxed">
                  <div
                    data-slot="code-gutter"
                    // Decoration rather than content: the numbers mark place in the file, they are not
                    // part of it, and a reader is not told about them.
                    aria-hidden="true"
                    className="sticky left-0 shrink-0 border-r border-border bg-muted py-4 pr-3 pl-4 text-right whitespace-pre text-muted-foreground/70 select-none"
                  >
                    {readGutter}
                  </div>

                  <pre className="w-max p-4">
                    {html === null ? (
                      // Plain text, as a React child: the source is escaped by React and never becomes
                      // markup, which is what the no-tokens path has always been.
                      <code>{readContent}</code>
                    ) : (
                      /*
                        The tokens arrive as a string of escaped HTML rather than as a React tree, which is
                        the one place this pane hands markup to the DOM. Two reasons, both about size: a
                        large file is tens of thousands of spans, and building that tree costs more than the
                        tokenizing did; and highlight.js escapes the source it wraps, so nothing in the file
                        can become markup. `hljs` on the element is what scopes the theme's token colours
                        to this render.
                      */
                      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
                    )}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * An image, as the pane shows it.
 *
 * One `img` of the data URL main sent, centered on the pane, with the file's own name as its `alt` so
 * the picture is announced as the file it is rather than as "image". The caption underneath is the
 * pane's one statement about what it is showing: the media type main decided and the size it measured —
 * the caption's wording is this pane's, so one sentence here says it.
 *
 * This element is also the whole of this side's svg story. Main sends an svg base64 inside a data URL —
 * bytes, never markup — and an `img` cannot run what it displays: the source is decoded and painted, so
 * a `script` inside the file has no document to execute in. Every other way of drawing those bytes
 * (inline, or as HTML) would hand them to the DOM as a document, which is the one thing that must not
 * happen; keeping the render to an `img` is what makes the format safe to offer at all.
 */
function ImageView({ image, alt }: { image: ImageRead; alt: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        The image keeps its own aspect ratio inside whatever box the pane gives it (`object-contain`),
        and the scroll container is here rather than on the pane so a picture larger than the pane can
        still be reached instead of being clipped.
      */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img src={image.dataUrl} alt={alt} className="max-h-full max-w-full object-contain" />
      </div>

      <p
        data-slot="image-caption"
        className="shrink-0 border-t border-border bg-muted px-3 py-1.5 text-center font-mono text-[11px] text-muted-foreground"
      >
        {`${image.mime} · ${formatBytes(image.bytes)}`}
      </p>
    </div>
  )
}

/**
 * What the viewer shows when a read fails. The cases worth their own copy — a file past the cap, an image
 * past its own, a workbook past its own, a locked workbook, a workbook that will not parse — are branched
 * on the error code, never on the message string, which is main's to word.
 *
 * The cases are not refinements of each other: the limits are different numbers, and the way out differs
 * for each — a text file over the cap is a preview the viewer declines, an image over it is one it cannot
 * show, and a locked workbook is neither damaged nor oversized, so telling its reader it "could not be
 * opened" would be a statement about the bytes that happens to be false. A workbook that will not parse
 * is the one place this pane names a format limit outright, because the honest reason a `.xls` fails here
 * is that this parser reads the modern container and not the binary one.
 *
 * All of them take the editor away, which for a picture and a workbook is already the case.
 */
function FileError({ error, path }: { error: unknown; path: string }) {
  const code = error instanceof ConveyorError ? error.code : null
  const encrypted = code === 'SPREADSHEET_ENCRYPTED'
  const tooLarge = code === 'FILE_TOO_LARGE' || code === 'IMAGE_TOO_LARGE' || code === 'SPREADSHEET_TOO_LARGE'
  const name = path.split(/[\\/]/).pop() ?? path

  const title = encrypted
    ? `${name} is password protected`
    : tooLarge
      ? `${name} is too large to preview`
      : 'This file could not be opened'

  const detail = encrypted
    ? 'It can be opened in a spreadsheet program, where it can be unlocked.'
    : code === 'SPREADSHEET_TOO_LARGE'
      ? 'The viewer caps workbooks at 8 MB so a large read never blocks the window.'
      : code === 'SPREADSHEET_PARSE_FAILED'
        ? 'This viewer reads modern .xlsx workbooks; a legacy binary .xls is not one of them.'
        : code === 'IMAGE_TOO_LARGE'
          ? 'The viewer caps images at 2 MB so a large read never blocks the window.'
          : tooLarge
            ? 'The viewer caps files at 1 MB so a large read never blocks the window.'
            : 'It may be binary, moved, or unreadable.'

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <TriangleAlert className="size-6 text-muted-foreground/50" />
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

/**
 * What the pane shows when the diff could not be computed.
 *
 * The wording is the renderer's, chosen by the code — so a file over the read cap says so, rather than
 * leaving an empty diff that would read as "nothing changed".
 */
function DiffError({ error }: { error: unknown }) {
  const code = error instanceof ConveyorError ? error.code : 'UNKNOWN'

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <TriangleAlert className="size-6 text-muted-foreground/50" />
      <div>
        <p className="text-[13px] font-medium">This diff could not be shown</p>
        <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">{gitErrorMessage(code)}</p>
        <p className="mt-1 font-mono text-[10.5px] text-muted-foreground/70">{code}</p>
      </div>
    </div>
  )
}
