import { ChatPanel } from './chat-panel'
import { CodeViewer } from './code-viewer'
import { IconRail } from './icon-rail'
import { ExplorerPanel } from './explorer-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'

/**
 * The workbench: icon rail, secondary panel, and a main area split between the chat and the code
 * viewer. The panel proportions are the window's starting point; dragging the handles owns them
 * from then on. Pane minimums are in pixels so they hold when the window is narrowed — the group
 * itself still needs at least one panel that can absorb the remainder.
 */
export function Workbench() {
  return (
    <div className="flex h-full min-h-0">
      <IconRail />

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
    </div>
  )
}
