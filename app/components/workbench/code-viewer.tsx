import { useCallback, useEffect, useRef, useState } from 'react'
import { Braces, FileCode, GitCompare, Lock, Pencil, Save, TriangleAlert, X } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { DiffView } from './diff-view'
import { gitErrorMessage } from './changes'
import { canEdit, decideConflict, insertTab, isDirty, writeErrorMessage } from './editing'
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

  /** True while the textarea is showing rather than the read-only render. */
  const [editing, setEditing] = useState(false)
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
  const editable = selectedFile !== null && canEdit(readCode)
  const dirty = isDirty(baseline, buffer)

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
    setSaveError(null)
    // A read that lands is also the way out of a save conflict: the content and the mtime have just
    // been refreshed, so the banner's question has been answered.
    setSaveConflict(false)
    applyRead(file.data.content, file.data.baselineMtime ?? null)
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

  saveRef.current = () => void onSave()

  // Ctrl+S, while editing. Bound to the document rather than to the textarea so it works wherever the
  // focus happens to be inside the pane — a save that only fires when the caret is in one specific
  // element is a save the user cannot rely on.
  useEffect(() => {
    if (!editing) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [editing])

  /** Refetch the file, dropping the buffer. Reload is the user choosing the disk over their edits. */
  const reload = useCallback(() => {
    setConflicted(false)
    setSaveConflict(false)
    setSaveError(null)
    bufferRef.current = null
    baselineRef.current = null
    setBuffer(null)
    setBaseline(null)
    setBaselineMtime(null)
    if (selectedFile) void conveyor.workspace.readFile.invalidate({ path: selectedFile })
  }, [selectedFile])

  const showingDiff = selectedChange !== null
  const fileName = selectedFile ? (selectedFile.split(/[\\/]/).pop() ?? selectedFile) : ''

  /** The file line: the path, the dirty dot, and the toggle when the file can be edited at all. */
  const toolbar = !showingDiff && selectedFile && (
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

      {editing && (
        <Button variant="ghost" size="icon-xs" aria-label="Save file" disabled={!dirty} onClick={() => void onSave()}>
          <Save />
        </Button>
      )}

      {editable ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={editing ? 'Stop editing' : 'Edit this file'}
          aria-pressed={editing}
          onClick={() => {
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
        // would overwrite a file nobody has seen.
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
        title={showingDiff ? 'Diff' : selectedFile ? `Code${editing ? ' · editing' : ''}` : 'Code Viewer'}
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
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {diff.data && <DiffView diff={diff.data} className="mt-0" />}
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
            A conflict reported by a *save*: the disk changed between the read and this write, so main
            refused it. Distinct from the banner below, and answered differently — the buffer is still
            unsaved and the disk still holds the other version, so the two ways out are to take the
            disk (Reload) or to overwrite it on purpose. Keep mine re-sends with `force`, which is a
            second deliberate click rather than an inference from the failure.
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
              <Button variant="outline" size="sm" onClick={() => void onSave(true)}>
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
          ) : editing && buffer !== null ? (
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
              spellCheck={false}
              // Wrapping off, so a long line scrolls rather than reflowing: the same fidelity the
              // read-only render had, which is the whole reason highlighting can wait.
              wrap="off"
              className="min-h-0 flex-1 resize-none overflow-auto bg-background p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre outline-none"
            />
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed">
              <code>{buffer ?? file.data?.content}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * What the viewer shows when a read fails. The oversized case is expected enough to deserve its own
 * copy, so it is branched on the error code — never on the message string, which is main's to word.
 */
function FileError({ error, path }: { error: unknown; path: string }) {
  const tooLarge = error instanceof ConveyorError && error.code === 'FILE_TOO_LARGE'
  const name = path.split(/[\\/]/).pop() ?? path

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <TriangleAlert className="size-6 text-muted-foreground/50" />
      <div>
        <p className="text-[13px] font-medium">
          {tooLarge ? `${name} is too large to preview` : 'This file could not be opened'}
        </p>
        <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
          {tooLarge
            ? 'The viewer caps files at 1 MB so a large read never blocks the window.'
            : 'It may be binary, moved, or unreadable.'}
        </p>
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
