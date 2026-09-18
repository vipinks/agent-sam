import { useState } from 'react'
import { AlertTriangle, FolderTree, Loader2 } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { ACTIVITIES } from './icon-rail'
import { TreeLevel, listErrorMessage } from './file-tree'
import { useWorkbenchStore } from './store'

/**
 * The secondary panel: the workspace browser. `rootPath` lives in a conveyor store, so the open
 * folder is main-owned state that survives restarts and is shared by every window — this component
 * only mirrors it and dispatches the one action that changes it.
 *
 * A stored folder can outlive the folder itself (deleted, renamed, or on a drive that is not
 * mounted), so the unreadable case is a state of its own with the picker still reachable. Falling
 * back to the empty state here would silently discard which folder the user was working in.
 */
export function ExplorerPanel() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const activity = ACTIVITIES.find((a) => a.id === activeActivity) ?? ACTIVITIES[0]

  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)
  const { setRootPath } = useConveyorStore(workspaceStore)
  const [pickError, setPickError] = useState<string | null>(null)

  const pickFolder = conveyor.workspace.pickFolder.useMutation()

  // The root listing for whichever folder is open. Loading it is the query's whole job — children
  // load independently as they are expanded, so a deep tree is never walked up front.
  const root = conveyor.workspace.listDirectory.useQuery({
    input: { path: rootPath ?? '' },
    enabled: rootPath !== null,
    retry: false,
  })

  const onPickFolder = async () => {
    setPickError(null)
    try {
      const picked = await pickFolder.mutateAsync(undefined)
      // A cancelled dialog returns null, which is an ordinary outcome, not a failure.
      if (picked) setRootPath(picked)
    } catch {
      setPickError('The folder picker could not be opened.')
    }
  }

  const picker = (
    <Button variant="outline" size="sm" disabled={pickFolder.isPending} onClick={onPickFolder}>
      {pickFolder.isPending && <Loader2 className="animate-spin" />}
      {rootPath ? 'Choose Another Folder' : 'Open Folder'}
    </Button>
  )

  return (
    <div className="flex h-full flex-col bg-card">
      <PaneHeader icon={activity.icon} title={activity.panelTitle}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={rootPath ? 'Change folder' : 'Open folder'}
          disabled={pickFolder.isPending}
          onClick={onPickFolder}
        >
          {pickFolder.isPending ? <Loader2 className="animate-spin" /> : <FolderTree />}
        </Button>
      </PaneHeader>

      {rootPath === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FolderTree className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">No folder open</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              Pick a workspace to browse it here. Only what you expand is read, one folder at a time.
            </p>
          </div>
          {picker}
          {pickError && <p className="text-[12px] text-destructive">{pickError}</p>}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The open folder heads the tree it describes, so the rows below have a named owner. */}
          <div className="shrink-0 border-b border-border px-3 py-1.5">
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={rootPath}>
              {rootPath}
            </p>
          </div>

          {root.error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <AlertTriangle className="size-6 text-muted-foreground/50" />
              <div>
                <p className="text-[13px] font-medium">This folder could not be read</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                  {listErrorMessage(root.error)}
                </p>
              </div>
              {picker}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto py-1">
              <TreeLevel entries={root.data} depth={0} isLoading={root.isLoading} error={root.error} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
