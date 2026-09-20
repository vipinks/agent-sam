import { toast } from 'sonner'
import { ConveyorError } from 'electron-conveyor/react'
import { conveyor } from '@/conveyor/client'
import type { ExportFormat } from '@/conveyor/protocol/export'
import { ChatPanel } from './chat-panel'
import { CodeViewer } from './code-viewer'
import { IconRail } from './icon-rail'
import { ExplorerPanel } from './explorer-panel'
import { SessionListPanel } from './session-list-panel'
import { SettingsView } from './settings-view'
import { TerminalPanel } from './terminal-panel'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable'
import { useWorkspaceChangeInvalidation } from './use-workspace-changes'
import { ChatSessionsProvider, useChatSessionsContext } from './chat-sessions-context'
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
 * The secondary panel follows the rail: the explorer keeps the file tree, and the chat shows the
 * conversation list the panel header has always promised.
 *
 * The workspace-change subscription lives here rather than in the explorer or the viewer, so a burst
 * of writes from one agent turn invalidates the listings once rather than once per subscriber.
 */
export function Workbench() {
  return (
    <ChatSessionsProvider>
      <WorkbenchLayout />
    </ChatSessionsProvider>
  )
}

function WorkbenchLayout() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const selectedFile = useWorkbenchStore((s) => s.selectedFile)
  const sessions = useChatSessionsContext()
  useWorkspaceChangeInvalidation(selectedFile)

  /**
   * Export a session through main, and report where it landed.
   *
   * Raised here, at the panel that owns the list, rather than inside the row that was clicked: the
   * row is a view of the session list, and the list can change while the save dialog is open — so a
   * toast owned by the row could be unmounted before the file it is describing has been written.
   *
   * Only the id crosses back: main reads the transcript from disk itself, and the renderer never has
   * to have the conversation loaded to export it.
   */
  const runSessionExport = (id: string, format: ExportFormat) => {
    void (async () => {
      try {
        const path = await conveyor.sessions.exportSession({ id, format })
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
      defaultSize={250}
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
        />
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
        <ResizablePanelGroup id="workbench" orientation="horizontal">
          {secondaryPanel}

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
