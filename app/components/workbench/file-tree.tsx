import { useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError } from 'electron-conveyor/react'
import { CODE_RESIDENT, doubleClickDocksViewer } from '@/conveyor/protocol/dock'
import { cn } from '@/lib/utils'
import { useWorkbenchStore } from './store'

/** A directory child, derived from the router type — no main-only code is imported to get it. */
export type FileTreeEntry = Awaited<ReturnType<typeof conveyor.workspace.listDirectory>>[number]

// Tailwind can only pick up classes it can see, so indentation steps through a fixed map rather
// than a computed inline style. Levels past the end reuse the last step instead of growing forever.
const INDENT = ['pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-15']

function indentClass(depth: number) {
  return INDENT[Math.min(depth, INDENT.length - 1)]
}

/**
 * The body copy for a failed listing. Wording only — the branch is on the error code, and the
 * heading above it already says what happened, so this explains the likely cause instead.
 */
export function listErrorMessage(error: unknown) {
  if (error instanceof ConveyorError && error.code === 'DIRECTORY_UNAVAILABLE') {
    return 'It may have been moved or deleted since you last opened it.'
  }
  return 'The folder could not be listed.'
}

/**
 * One listing level. Each directory renders its own `TreeDirectory` only while expanded, so the
 * query for a folder runs when it is first opened — the tree is never walked up front.
 */
export function TreeLevel({
  entries,
  depth,
  isLoading,
  error,
}: {
  entries: FileTreeEntry[] | undefined
  depth: number
  isLoading: boolean
  error: unknown
}) {
  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-1.5 py-1.5 text-[12.5px] text-muted-foreground', indentClass(depth))}>
        <Loader2 className="size-3.5 animate-spin" />
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <p className={cn('py-1.5 text-[12.5px] text-muted-foreground', indentClass(depth))}>{listErrorMessage(error)}</p>
    )
  }

  if (!entries || entries.length === 0) {
    return <p className={cn('py-1.5 text-[12.5px] text-muted-foreground', indentClass(depth))}>Empty</p>
  }

  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.path}>
          {entry.isDirectory ? <DirectoryNode entry={entry} depth={depth} /> : <FileNode entry={entry} depth={depth} />}
        </li>
      ))}
    </ul>
  )
}

/**
 * An expandable folder. `enabled` is the lazy part: the listing stays disabled — so the query never
 * fires — until the folder is expanded for the first time. Once it has run, the result lives in the
 * query cache, so collapsing and reopening is instant and silent.
 */
function DirectoryNode({ entry, depth }: { entry: FileTreeEntry; depth: number }) {
  // Becomes true on the first expand and stays true, which is what keeps the fetched listing
  // cached across collapse/expand cycles instead of re-requesting it.
  const [hasExpanded, setHasExpanded] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const listing = conveyor.workspace.listDirectory.useQuery({
    input: { path: entry.path },
    enabled: hasExpanded,
    retry: false,
  })

  const Icon = expanded ? FolderOpen : Folder
  const isOpen = expanded && !listing.isLoading

  const toggle = () => {
    setHasExpanded(true)
    setExpanded((value) => !value)
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={toggle}
        className={cn(
          'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12.5px] transition-colors hover:bg-accent',
          indentClass(depth)
        )}
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')}
        />
        <Icon className={cn('size-3.5 shrink-0', isOpen ? 'text-brand' : 'text-muted-foreground')} />
        <span className="truncate">{entry.name}</span>
      </button>

      {expanded && (
        <TreeLevel entries={listing.data} depth={depth + 1} isLoading={listing.isLoading} error={listing.error} />
      )}
    </div>
  )
}

/** A leaf. Selecting it is what the code viewer reads. */
function FileNode({ entry, depth }: { entry: FileTreeEntry; depth: number }) {
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)
  const setSelectedChange = useWorkbenchStore((s) => s.setSelectedChange)
  const rightPanel = useWorkbenchStore((s) => s.rightPanel)
  const toggleRightPanel = useWorkbenchStore((s) => s.toggleRightPanel)
  const isSelected = selectedFile === entry.path

  /**
   * Point the viewer at this file.
   *
   * Opening a file closes any diff the viewer was showing, so the pane has one answer to "what is it
   * showing" rather than two competing ones.
   */
  const select = () => {
    setSelectedChange(null)
    setSelectedFile(entry.path)
  }

  /**
   * The file's second gesture: show it beside the conversation as well as in the viewer.
   *
   * Selecting again is not redundant bookkeeping — it is what makes this gesture's own claim true
   * rather than borrowed from the two clicks that preceded it. The dock is then asked for through the
   * resident's own action, the one the right rail's Code button calls, and only while it is not
   * already the resident in the slot: docking what is already docked is a click that changes nothing,
   * and putting it away is the opposite of what was asked. Whether there is anything to dock is the
   * protocol layer's rule, so this row and its test read one statement of it rather than two.
   */
  const openBeside = () => {
    select()
    if (doubleClickDocksViewer('file', rightPanel)) toggleRightPanel(CODE_RESIDENT)
  }

  return (
    <button
      type="button"
      aria-current={isSelected ? 'true' : undefined}
      onClick={select}
      onDoubleClick={openBeside}
      className={cn(
        'flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[12.5px] transition-colors',
        indentClass(depth),
        isSelected ? 'bg-brand-soft text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      <FileText className={cn('size-3.5 shrink-0', isSelected ? 'text-brand' : 'text-muted-foreground/70')} />
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
