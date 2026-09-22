import { FolderTree } from 'lucide-react'
import { useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { PaneHeader } from './pane-header'
import { activityById, DrawerChevron } from './icon-rail'
import { ChangesSection } from './changes-section'

/**
 * The git panel: what git makes of the open folder, as a rail item of its own.
 *
 * The Changes section used to sit at the head of the explorer, on the argument that the tree and its
 * state are two readings of the same folder. It is a panel instead, because the two are read at
 * different times for different reasons: the tree is where you navigate, and the changes list is where
 * you decide what goes into the next commit. A commit box in a panel you are not looking at is a
 * control that has to be found before it can be used — and the folder line the section needs is a
 * heading it can carry itself.
 *
 * The panel is a header and that heading; everything else belongs to the section — the branch, its
 * divergence from the upstream, the staged and unstaged lists, the actions on each row, the commit
 * box, the refresh, the branch switch, and the not-a-repository state. None of it is duplicated here,
 * so the two can never disagree about what the working tree holds.
 *
 * The chevron beside the heading puts the drawer away, and it is the header's rather than this panel's:
 * every panel the drawer shows offers the same control, so the way out of the drawer is in the header of
 * whatever is in it rather than only at the rail's head.
 *
 * No folder open is a state of this panel rather than an empty section: there would be nothing to
 * report on, and the section's reads would be aimed at a path that does not exist.
 */
export function GitPanel() {
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)
  // The item's own label, so the header and the rail button say the same thing.
  const activity = activityById('git')

  return (
    <div className="flex h-full flex-col bg-card">
      <PaneHeader icon={activity.icon} title={activity.panelTitle}>
        <DrawerChevron />
      </PaneHeader>

      {rootPath === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <FolderTree className="size-6 text-muted-foreground/40" />
          <div>
            <p className="text-[13px] font-medium">No folder open</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
              Open a folder from the explorer to see what git makes of it.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {/* The folder the state belongs to, so the branch and the paths below have a named owner. */}
          <div className="shrink-0 border-b border-border px-3 py-1.5">
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={rootPath}>
              {rootPath}
            </p>
          </div>

          <ChangesSection rootPath={rootPath} />
        </div>
      )}
    </div>
  )
}
