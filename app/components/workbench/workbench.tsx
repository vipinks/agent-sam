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
import { UpdateReadyNotice } from './update-ready-notice'
import { TerminalPanel } from './terminal-panel'
import { PreviewPanel } from './preview-panel'
import { OverviewPanel } from './overview-panel'
import { RightRail } from './right-rail'
import { ToolsPanel } from './tools-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'
import { useWorkspaceChangeInvalidation } from './use-workspace-changes'
import { ChatSessionsProvider, useChatSessionsContext } from './chat-sessions-context'
import { chatGroupLayout, mainGroupLayout, outerGroupLayout, percentSize } from './layout'
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
 * Two views take the whole main area rather than a column: Settings, which is a screen you leave when
 * done, and nothing else.
 *
 * The secondary panel follows the rail: the explorer keeps the file tree, git keeps the working tree's
 * state, and the chat shows the conversation list the panel header has always promised.
 *
 * The right rail stands inside the main column rather than beside the outer group, and that is a width
 * decision rather than a styling one. A share is a share of the group's box, so a fixed column in the
 * row beside the group is paid for by every panel in that group — the drawer first among them, which
 * lost its share of the rail's sixty-four pixels, 34 of them windowed and 20 maximized, and with them
 * the slack its own header had. The rail is the main area's edge strip: its residents dock into that
 * column's inner group, so its pixels come out of that column's budget, which is where they came from
 * before this phase. The row outside the outer group is the left icon rail and nothing else, and the
 * drawer's saved share buys what it bought then.
 *
 * The right rail is the outer edge's other end, and it is what decides whether the inner group has a
 * second column at all. At launch it has none: the inner group holds the conversation alone, and a
 * resident is docked by clicking its icon — Code for the open file's source and diffs, Preview for the
 * same file rendered, Tools for what the app is working from. The docked panel takes the inner group's
 * right slot at the state's own persisted inner percentage, which is the number a drag of that
 * separator left, so docking writes nothing and a reader who had dragged the split where they wanted
 * it gets it back. One resident is docked at a time: the three are things you look at in the same place
 * rather than three places, and the slot is one column.
 *
 * The terminal is not one of them any more. It is a third group nested inside the chat column, so the
 * panel sits under the conversation and beside nothing: the right rail, the drawer and the docked
 * resident are all exactly as wide as they were before it existed, because its height comes out of the
 * column the conversation already owned rather than out of the row. The group is declared from the
 * panel's height alone — the conversation takes the remainder — and its height is per window state,
 * while whether it is showing at all is one flag that survives a maximize. It is opened and closed by
 * the title bar's own glyph and by Ctrl+`, and its separator's drag is remembered by the same path the
 * other two groups' drags are.
 *
 * Whether one is docked is memory only, and deliberately not the drawer's flag's neighbour in storage:
 * an open panel is a way of looking at the file in front of you rather than a way of working, so a
 * session switch inside the run leaves it exactly where it is and every launch opens rail-only.
 * Closing it — a second click on its own icon, or the header's collapse glyph — removes the panel from
 * the group rather than narrowing it, exactly as the drawer's collapse does in the outer group, and it
 * takes the viewer's expansion with it, because an expansion of a column that is not there is a way for
 * this group to end up empty. Expansion itself is unchanged: while a panel is docked, that column can
 * take the chat's width, and the control that does it is offered by whichever resident is docked.
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
  // Which resident of the right rail is docked into the inner group's right slot, or null while the rail
  // is alone. Read once per render, beside the flag that says whether it has taken the chat's width.
  const rightPanel = useWorkbenchStore((s) => s.rightPanel)
  // The window state this window is in, and the set both groups open with for it — with the bottom
  // terminal panel's own state beside them: whether it is showing, how tall it is in this state, and
  // the one place a drag of its separator turns back into a stored height. Read once per render, so the
  // three levels of the layout can never be given sizes that were resolved apart.
  const { state, sizes, bottomOpen, bottomHeight, onOuterLayoutChanged, onInnerLayoutChanged, onBottomLayoutChanged } =
    useWorkbenchLayout()
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
          onCreate={() => sessions.goHome()}
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
    <div className="relative flex h-full min-h-0">
      <IconRail />

      {activeActivity === 'settings' ? (
        // The rail keeps the right edge here too: it is the main area's edge strip, and this branch is
        // the main area shown whole, so the row it shares is the one the group would otherwise be in.
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="min-w-0 flex-1">
            <SettingsView />
          </div>
          <RightRail />
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
            // The rail shares this column rather than the outer group, so its pixels are the main
            // column's to pay: the class lands on the panel's own content box, which is what makes the
            // group and the rail one row and takes the rail's sixty-four pixels off the group's inner
            // share instead of off the outer group's box — and therefore off the drawer's share of it.
            className="flex min-h-0"
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
                column the pane is sharing with, and "the docked panel spans both" has to be true of
                the layout rather than of the styling.

                The two branches are keyed, and that is not decoration: without keys React reconciles
                the group's children by position, so the panel that was the chat's would be re-used —
                and remounted — as the docked panel's. The docked panel would then lose everything it was
                holding, and an edited buffer, a chosen sheet and a running transcript would all be
                rebuilt by a click on a layout control. The keys are what make "the pane renders through
                the layout change" true rather than merely intended.

                The handle is declared only when there is something to drag between: while the rail is
                alone the chat is the group's only column, and a separator with nothing on one side of
                it is a divider the library would have to discard.
              */}
              {!viewerExpanded && (
                <Fragment key="chat">
                  <ResizablePanel
                    id="chat"
                    // The sole column while the rail is alone, and it needs no size of its own beyond
                    // that: the group's declared layout names two panels and the group has one, so the
                    // library sets it aside and falls back to this share — which is why the closed dock
                    // says a hundred rather than leaving the chat at half of a group it now has to
                    // itself.
                    defaultSize={rightPanel === null ? percentSize(100) : percentSize(sizes.main.chat)}
                    minSize={320}
                  >
                    {/*
                      The chat column's own split, and the reason the terminal's move is a move: the
                      panel is nested here rather than in the row, so everything that shares the row
                      keeps the width it had. The group is declared and keyed exactly as the two above
                      it are — a vertical split takes percentages of a height, and the height the panel
                      opens at belongs to the window state, so a new state is a new group.
                    */}
                    <ResizablePanelGroup
                      id="workbench-chat"
                      key={state}
                      orientation="vertical"
                      defaultLayout={chatGroupLayout(bottomHeight)}
                      onLayoutChanged={onBottomLayoutChanged}
                    >
                      {/*
                        The conversation, and the panel it sits above. The group names both panels
                        whether or not the second is there, and while it is closed the library sets
                        that pair aside and falls back to this share — which is why the closed panel
                        says a hundred rather than leaving the conversation at a share of a group it
                        now has to itself.
                      */}
                      <ResizablePanel
                        id="conversation"
                        defaultSize={bottomOpen ? percentSize(100 - bottomHeight) : percentSize(100)}
                        minSize={160}
                      >
                        <ChatPanel />
                      </ResizablePanel>

                      {/*
                        The bottom terminal panel, and its handle with it. Removed from the group
                        rather than narrowed to nothing, exactly as the drawer and the chat column are
                        whenever they go: a panel that is still in the tree is still a height the
                        other one is sharing with. Its own declared size is what the library lays it
                        out at when it arrives, so opening the panel writes no number anywhere and a
                        reader who had dragged the separator gets the height they chose back.

                        Keyed apart from the conversation for the reason the branches above are: React
                        reconciles the group's children by position, so an unkeyed panel would be
                        re-used — and remounted — as the conversation's, which would end the shell
                        session the transcript replay exists to preserve.
                      */}
                      {bottomOpen && (
                        <Fragment key="bottom">
                          <ResizableHandle />

                          <ResizablePanel id="terminal" defaultSize={percentSize(bottomHeight)} minSize={120}>
                            <TerminalPanel />
                          </ResizablePanel>
                        </Fragment>
                      )}
                    </ResizablePanelGroup>
                  </ResizablePanel>

                  {rightPanel !== null && <ResizableHandle />}
                </Fragment>
              )}

              {/*
                The right slot, while a resident is docked in it. One panel whatever is in it, because
                the rail's three residents are three things shown in one column rather than three
                columns; the resident's own component is what changes.

                The id is the group's key for the pane beside the chat and is the same for every
                resident, deliberately: the state's stored inner split is named for the slot, so the
                percentage a drag left is the percentage the next resident docks at, and a reader who
                had dragged the split gets the same one back whichever panel they open beside it.

                Each panel states its own size as well as the group stating the set, and while expanded
                that is the only statement that applies: the group's declared layout names two panels
                and the group has one, so the library sets it aside and falls back to the panel's own
                share — which is what makes the two branches agree instead of a stale set winning.
              */}
              {rightPanel !== null && (
                <ResizablePanel
                  key="code"
                  id="code"
                  defaultSize={viewerExpanded ? percentSize(100) : percentSize(sizes.main.viewer)}
                  minSize={280}
                >
                  {rightPanel === 'code' ? (
                    <CodeViewer />
                  ) : rightPanel === 'preview' ? (
                    <PreviewPanel />
                  ) : rightPanel === 'overview' ? (
                    <OverviewPanel />
                  ) : (
                    <ToolsPanel />
                  )}
                </ResizablePanel>
              )}
            </ResizablePanelGroup>

            <RightRail />
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {/*
        The update-ready notice, laid over the main area rather than carried in one of its columns.

        It is here, in the shell, because the news it carries is about the app: a downloaded update is
        waiting to install whichever view the user happens to be in, so a card living in the conversation
        would be invisible to a user in the explorer, a document or Settings — which is exactly the user most
        likely to have stopped looking at the app. Laid over the bottom edge rather than in a panel's flow,
        because a notice in a column is a notice in a column the window may not have, and because a card the
        layout can push off the screen is a card that fails at the one moment it exists for.

        `pointer-events-none` on the wrapper and nothing else, so the overlay's own box never swallows a
        click meant for the surface beneath it while the card itself stays clickable — the failure a
        full-width overlay usually brings with it. The card is absent from the tree while the updater has
        nothing to announce, which is every moment of a development run.

        `data-overlay` states the one thing about this box the shell cannot: it is positioned out of the
        row rather than laid in it, so it takes no width from the panels beside the rail. The
        drawer-width budget's own walk over the row's children reads that marker to leave it out, because
        a share is what that file measures and this box has never had one.
      */}
      <div
        data-overlay="update-ready"
        className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-3"
      >
        <UpdateReadyNotice />
      </div>
    </div>
  )
}
