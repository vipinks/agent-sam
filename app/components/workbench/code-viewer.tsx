import { Braces, FileCode, GitCompare, TriangleAlert, X } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { DiffView } from './diff-view'
import { gitErrorMessage } from './changes'
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
 */
export function CodeViewer() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)
  const selectedChange = useWorkbenchStore((s) => s.selectedChange)
  const setSelectedChange = useWorkbenchStore((s) => s.setSelectedChange)

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

  const showingDiff = selectedChange !== null

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader
        icon={showingDiff ? GitCompare : FileCode}
        title={showingDiff ? 'Diff' : selectedFile ? 'Code' : 'Code Viewer'}
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
          <div className="flex h-8 shrink-0 items-center border-b border-border px-3">
            <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={selectedFile}>
              {selectedFile}
            </p>
          </div>

          {file.isLoading ? (
            <div className="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">Loading…</div>
          ) : file.error ? (
            <FileError error={file.error} path={selectedFile} />
          ) : (
            <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed">
              <code>{file.data?.content}</code>
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
