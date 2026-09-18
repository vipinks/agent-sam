import { FolderTree } from 'lucide-react'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { ACTIVITIES } from './icon-rail'
import { useWorkbenchStore } from './store'

/**
 * The secondary panel. It is the slot a file tree will fill, so it renders the explorer's empty
 * state rather than invented rows: the tree needs the workspace path from main, and nothing here
 * may reach the file system directly.
 */
export function ExplorerPanel() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const activity = ACTIVITIES.find((a) => a.id === activeActivity) ?? ACTIVITIES[0]

  return (
    <div className="flex h-full flex-col bg-card">
      <PaneHeader icon={activity.icon} title={activity.panelTitle} />

      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <FolderTree className="size-6 text-muted-foreground/40" />
        <div>
          <p className="text-[13px] font-medium">No folder open</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            Pick a workspace to browse it here. The tree waits on a conveyor module that lists the folder in main.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled
          title="Waiting on a conveyor module in main — the renderer cannot touch the file system"
        >
          Open Folder
        </Button>
      </div>
    </div>
  )
}
