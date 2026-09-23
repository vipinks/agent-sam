import { Fragment } from 'react'
import { toast } from 'sonner'
import { ConveyorError } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import type { ExportFormat } from '@/conveyor/protocol/export'
import { exportRequest } from './export-request'
import { ChatPanel } from './chat-panel'
import { CodeViewer } from './code-viewer'
import { IconRail } from './icon-rail'
import { ExplorerPanel } from './explorer-panel'
import { GitPanel } from './git-panel'
import { SessionListPanel } from './session-list-panel'
import { SettingsView } from './settings-view'
import { TerminalPanel } from './terminal-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'
import { useWorkspaceChangeInvalidation } from './use-workspace-changes'
import { ChatSessionsProvider, useChatSessionsContext } from './chat-sessions-context'
import { mainGroupLayout, outerGroupLayout, percentSize } from './layout'
import { useWorkbenchLayout } from './use-workbench-layout'
import { useThemeApplication } from './theme-apply'
import { useWorkbenchStore } from './store'

/**
 * The workbench: icon rail, secondary panel, and a main area split between the chat and the code
 * viewer. The sizes both groups open with belong to the window state the window is in, so they are
 * read from `useWorkbenchLayout`: 34/66 and 50/50 in a windowed window, 20/80 and 53.75/46.25 in a
 * maximized one. Not one of those numbers is visible from the panel it sizes, which is why they live
 * together in `layout.ts` rather than as literals here, and why each group is handed its own set
 * through the resize library's `defaultLayout` — the group is what the library computes a layout for.
 * They are the state's starting point; dragging the handles owns them from then on, and the drawer
 * keeps its pixel width when the window itself is resized rather than its share of it. Pane minimums
 * are in pixels so they hold when the window is narrowed — the group itself still needs at least one
 * panel that can absorb the remainder.
 *
 * Each group is keyed on the window state, and that is not decoration: the library takes the declared
 * layout once, on the group's first layout effect, and owns the layout from then on — so a new state's
 * sizes only arrive with a new group. Keying the outer group is enough for the structure (its subtree
 * is new), and the inner group carries the key too because its sizes come from the same state, which
 * is what a reader of either group should be able to see. The cost that buys is named where it is
 * paid: a maximize or a restore remounts the panes under them.
 *
 * Two rail items take the whole main area rather than the secondary panel, because they are places
 * you go rather than things you glance at: Settings (a screen you leave when done) and Terminal (a
 * transcript that wants the width).
 *
 * The secondary panel follows the rail: the explorer keeps the file tree, git keeps the working tree's
 * state, and the chat shows the conversation list the panel header has always promised.
 *
 * The drawer is the one column that can be put away, and putting it away removes it from the outer group
 * rather than shrinking it: a panel that is still in the tree is still a column the main area shares
 * with, so the collapsed app holds the rail and the main area and nothing else. While it is away the
 * remaining panel states its own size — the same fallback the viewer's expansion relies on, because a
 * declared pair of panel ids over a group that has one is a layout the library sets aside. The width
 * the drawer comes back to is the state's, untouched: a collapse writes no number anywhere, so the two
 * stored sets are the ones a drag left and a launch reads. The flag is persisted in the settings slice
 * beside those sets and read before the first render, so a window left collapsed opens collapsed instead
 * of flashing the drawer and taking it away again.
 *
 * The chat and the viewer are one split, and the viewer's header control can take the chat's half: while
 * that is on, the chat column is removed from the group rather than shrunk to nothing, so the viewer is
 * the only column and owns the width. The flag lives in the workbench store because the control that
 * sets it is inside the viewer; it is not persisted, so every launch opens split. It and the drawer's
 * collapse are two removals in two groups and compose: each leaves the other exactly as it was.
 *
 * The workspace-change subscription lives here rather than in the explorer or the viewer, so a burst
 * of writes from one agent turn invalidates the listings once rather than once per subscriber.
 *
 * The theme application is mounted here too, beside the shell's `.dark` class toggle, because the two
 * are the two halves of one thing: the class says which mode the window is in, and the inline
 * properties say what colours that mode is made of. Keeping them apart — the class in the shell, the
 * variables in the feature — is what lets the class stay exactly where it was while the palette becomes
 * data.
 */
export function Workbench() {
  useThemeApplication()

  return (
    <ChatSessionsProvider>
      <WorkbenchLayout />
    </ChatSessionsProvider>
  )
}

function WorkbenchLayout() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  // Whether the viewer is taking the chat column's width, as the viewer's header control last left it.
  const viewerExpanded = useWorkbenchStore((s) => s.viewerExpanded)
  // Whether the drawer is away, as the rail's own control and the drawer header's chevron last left it.
  const drawerCollapsed = useWorkbenchStore((s) => s.drawerCollapsed)
  // The window state this window is in, and the set both groups open with for it. Read once per
  // render, so the two levels of the layout can never be given sizes that were resolved apart.
  const { state, sizes, onOuterLayoutChanged, onInnerLayoutChanged } = useWorkbenchLayout()
  const sessions = useChatSessionsContext()
  useWorkspaceChangeInvalidation(selectedFile)

  /**
   * Export a session through main, and report where it landed.
   *
   * Raised here, at the panel that owns the list, rather than inside the row that was clicked: the
   * row is a view of the session list, and the list can change while the save dialog is open — so a
   * toast owned by the row could be unmounted before the file it is describing has been written.
   *
   * The title travels with the id because the store is the only place a renamed session's name
   * exists: a transcript records what was said, not what the row is called. Passing it makes the
   * default filename agree with the row the user clicked, and omitting it — a caller with no title in
   * hand — leaves main to derive one from the first message.
   */
  const runSessionExport = (id: string, format: ExportFormat, title: string) => {
    void (async () => {
      try {
        // The title the row is showing travels with the id: a renamed session's name exists only in
        // the store, and this is what makes the default filename agree with the row that was clicked.
        // `exportRequest` decides the shape — the title is omitted, not sent empty, when there is
        // none, so main's optional field is genuinely absent and its fallback applies.
        const path = await conveyor.sessions.exportSession(exportRequest(id, format, title))
        // A dismissed save dialog is an ordinary outcome, not a failure to report.
        if (path) toast.success('Conversation exported', { description: path })
      } catch (err) {
        // Branched on the code, never on the message text.
        const nothingToExport = err instanceof ConveyorError && err.code === 'SESSION_NOT_FOUND'
        toast.error(nothingToExport ? 'Nothing to export yet' : 'Could not export this conversation', {
          description: nothingToExport
            ? 'This conversation has no saved transcript — send a message first.'
            : 'The file could not be written. Nothing was changed.',
        })
      }
    })()
  }

  const secondaryPanel = (
    <ResizablePanel
      id="secondary"
      defaultSize={percentSize(sizes.outer.drawer)}
      minSize={180}
      maxSize={520}
      groupResizeBehavior="preserve-pixel-size"
    >
      {activeActivity === 'chat' ? (
        <SessionListPanel
          onCreate={() => void sessions.createSession()}
          onOpen={(id) => void sessions.openSession(id)}
          onRename={sessions.renameSession}
          onExport={runSessionExport}
          onDelete={(id) => void sessions.deleteSession(id)}
          error={sessions.error}
          notice={sessions.notice}
        />
      ) : activeActivity === 'git' ? (
        <GitPanel />
      ) : (
        <ExplorerPanel />
      )}
    </ResizablePanel>
  )

  return (
    <div className="flex h-full min-h-0">
      <IconRail />

      {activeActivity === 'settings' ? (
        <div className="min-w-0 flex-1">
          <SettingsView />
        </div>
      ) : activeActivity === 'terminal' ? (
        <div className="min-w-0 flex-1">
          <TerminalPanel />
        </div>
      ) : (
        <ResizablePanelGroup
          id="workbench"
          // The window state is this group's identity: a new state is a new group, which is how the
          // library is made to take the declared layout for it rather than keeping the one it computed
          // at mount.
          key={state}
          orientation="horizontal"
          defaultLayout={outerGroupLayout(sizes)}
          onLayoutChanged={onOuterLayoutChanged}
        >
          {/*
            The drawer and its handle, while it is here. Removed rather than narrowed to nothing, laid
            over, or hidden behind a class, for the same reason the chat column is: a column that is still
            in the group is still a column the main area is sharing its width with, and "the rail and the
            main area" has to be true of the layout rather than of the styling. No size is written when it
            goes or when it returns — the panel comes back declaring the share `sizes` resolves for the
            state the window is in, which is what the stored sets are for.
          */}
          {!drawerCollapsed && (
            <Fragment key="secondary">
              {secondaryPanel}

              <ResizableHandle />
            </Fragment>
          )}

          <ResizablePanel
            id="main"
            // The sole column while the drawer is away, and it needs no size of its own beyond that:
            // a group with one panel gives that panel everything, and the declared 100 is what the panel
            // falls back to when the group's own layout names two ids.
            defaultSize={drawerCollapsed ? percentSize(100) : percentSize(sizes.outer.main)}
            minSize={420}
          >
            <ResizablePanelGroup
              id="workbench-main"
              // Keyed for the same reason, and for its own sizes: the nested group remounts with the
              // outer one either way, and the pair states where each group's layout comes from.
              key={state}
              orientation="horizontal"
              defaultLayout={mainGroupLayout(sizes)}
              onLayoutChanged={onInnerLayoutChanged}
            >
              {/*
                The chat column while the split is showing, and its handle with it. Removed rather than
                hidden behind a zero width or a class: a column that is still in the tree is still a
                column the pane is sharing with, and "the viewer spans both" has to be true of the
                layout rather than of the styling.

                The two branches are keyed, and that is not decoration: without keys React reconciles
                the group's children by position, so the panel that was the chat's would be re-used —
                and remounted — as the viewer's. The viewer would then lose everything it was holding,
                and an edited buffer, a chosen sheet and a rendered preview would all be rebuilt by a
                click on a layout control. The keys are what make "the pane renders through the layout
                change" true rather than merely intended.
              */}
              {!viewerExpanded && (
                <Fragment key="chat">
                  <ResizablePanel id="chat" defaultSize={percentSize(sizes.main.chat)} minSize={320}>
                    <ChatPanel />
                  </ResizablePanel>

                  <ResizableHandle />
                </Fragment>
              )}

              {/* The sole column while expanded, and it needs no size of its own: a group with one panel
                  gives that panel everything, so the width follows from the chat's absence.

                  Each panel states its own size as well as the group stating the set, and while expanded
                  that is the only statement that applies: the group's declared layout names two panels
                  and the group has one, so the library sets it aside and falls back to the panel's own
                  share — which is what makes the two branches agree instead of a stale set winning. */}
              <ResizablePanel
                key="code"
                id="code"
                defaultSize={viewerExpanded ? percentSize(100) : percentSize(sizes.main.viewer)}
                minSize={280}
              >
                <CodeViewer />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}
