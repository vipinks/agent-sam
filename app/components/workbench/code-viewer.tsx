import { Braces, FileCode, TriangleAlert, X } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { useWorkbenchStore } from './store'

/**
 * The code viewer half of the main area. The path comes from the explorer's selection; the contents
 * come from `workspace.readFile` in main. A file the module refuses is reported as an inline state,
 * never thrown at the React tree — the viewer is a panel, not a crash boundary.
 */
export function CodeViewer() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)

  const file = conveyor.workspace.readFile.useQuery({
    input: { path: selectedFile ?? '' },
    enabled: selectedFile !== null,
    retry: false,
  })

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={FileCode} title={selectedFile ? 'Code' : 'Code Viewer'}>
        {selectedFile && (
          <Button variant="ghost" size="icon-xs" aria-label="Close preview" onClick={() => setSelectedFile(null)}>
            <X />
          </Button>
        )}
      </PaneHeader>

      {!selectedFile ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Braces className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">No file open</p>
            <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
              Pick a file from the explorer and it opens here, next to the conversation.
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
