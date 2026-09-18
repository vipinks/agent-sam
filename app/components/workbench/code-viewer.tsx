import { Braces, FileCode, X } from 'lucide-react'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { useWorkbenchStore } from './store'

/**
 * The code viewer half of the main area. With no file selected it is the empty state; once the
 * explorer opens a file it leads with the breadcrumb path. The source itself arrives later — a
 * conveyor query cannot be faked here.
 */
export function CodeViewer() {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)

  return (
    <div className="flex h-full flex-col bg-background">
      <PaneHeader icon={FileCode} title={selectedFile ? 'Code' : 'Code Viewer'}>
        {selectedFile && (
          <Button variant="ghost" size="icon-xs" aria-label="Close preview" onClick={() => setSelectedFile(null)}>
            <X />
          </Button>
        )}
      </PaneHeader>

      {selectedFile ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Path, not contents: the viewer is named and framed, with the read still to come. */}
          <div className="flex h-8 shrink-0 items-center border-b border-border px-3 font-mono text-[11.5px] text-muted-foreground">
            {selectedFile}
          </div>
          <div className="flex flex-1 items-center justify-center px-8 text-center text-[12.5px] text-muted-foreground">
            Contents load from a conveyor query once the file system module is wired.
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <Braces className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">No file open</p>
            <p className="mt-1 max-w-64 text-[12.5px] leading-relaxed text-muted-foreground">
              Pick a file from the explorer and it opens here, next to the conversation.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
