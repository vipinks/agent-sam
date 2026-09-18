import { ChatPanel } from './chat-panel'
import { CodeViewer } from './code-viewer'
import { IconRail } from './icon-rail'
import { ExplorerPanel } from './explorer-panel'
import { SettingsView } from './settings-view'
import { TerminalPanel } from './terminal-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'
import { useWorkspaceChangeInvalidation } from './use-workspace-changes'
import { useWorkbenchStore } from './store'

/**
 * The workbench: icon rail, secondary panel, and a main area split between the chat and the code
 * viewer. The panel proportions are the window's starting point; dragging the handles owns them
 * from then on. Pane minimums are in pixels so they hold when the window is narrowed — the group
 * itself still needs at least one panel that can absorb the remainder.
 *
 * Two rail items take the whole main area rather than the secondary panel, because they are places
 * you go rather than things you glance at: Settings (a screen you leave when done) and Terminal (a
 * transcript that wants the width).
 *
 * The workspace-change subscription lives here rather than in the explorer or the viewer, so a burst
 * of writes from one agent turn invalidates the listings once rather than once per subscriber.
 */
export function Workbench() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  useWorkspaceChangeInvalidation(selectedFile)

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
        <ResizablePanelGroup id="workbench" orientation="horizontal">
          <ResizablePanel
            id="explorer"
            defaultSize={250}
            minSize={180}
            maxSize={520}
            groupResizeBehavior="preserve-pixel-size"
          >
            <ExplorerPanel />
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel id="main" minSize={420}>
            <ResizablePanelGroup id="workbench-main" orientation="horizontal">
              <ResizablePanel id="chat" defaultSize="62" minSize={320}>
                <ChatPanel />
              </ResizablePanel>

              <ResizableHandle />

              <ResizablePanel id="code" defaultSize="38" minSize={280}>
                <CodeViewer />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  )
}
