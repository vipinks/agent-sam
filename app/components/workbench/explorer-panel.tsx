import { useState } from 'react'
import { AlertTriangle, FolderTree, Loader2 } from 'lucide-react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { sameRoot } from '@/conveyor/protocol/recent-roots'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { PaneHeader } from './pane-header'
import { ACTIVITIES } from './icon-rail'
import { TreeLevel, listErrorMessage } from './file-tree'
import { RootSwitcher } from './root-switcher'
import { rootErrorMessage, rootTail } from './recent-roots'
import { useWorkbenchStore } from './store'

/**
 * The secondary panel: the workspace browser. `rootPath` lives in a conveyor store, so the open
 * folder is main-owned state that survives restarts and is shared by every window — this component
 * only mirrors it and dispatches the actions that change it.
 *
 * A stored folder can outlive the folder itself (deleted, renamed, or on a drive that is not
 * mounted), so the unreadable case is a state of its own with the picker still reachable. Falling
 * back to the empty state here would silently discard which folder the user was working in.
 *
 * The switch flow lives here rather than in the switcher for the same reason the picker's does: the
 * switcher is a control, and what a switch *costs* is this panel's business. Opening another folder
 * throws away the unsaved buffer in the viewer, so the confirmation in front of that is owned by the
 * panel that can see both halves of it — the editor's state and the folder being opened.
 */
export function ExplorerPanel() {
  const activeActivity = useWorkbenchStore((s) => s.activeActivity)
  const activity = ACTIVITIES.find((a) => a.id === activeActivity) ?? ACTIVITIES[0]

  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)
  const recentRoots = useConveyorStore(workspaceStore, (s) => s.recentRoots)
  const { setRootPath, forgetRoot } = useConveyorStore(workspaceStore)

  const editorDirty = useWorkbenchStore((s) => s.editor.dirty)
  const setSelectedFile = useWorkbenchStore((s) => s.setSelectedFile)
  const setSelectedChange = useWorkbenchStore((s) => s.setSelectedChange)
  const setEditorDirty = useWorkbenchStore((s) => s.setEditorDirty)
  const [pickError, setPickError] = useState<string | null>(null)
  /** The code a refused switch reported. Cleared by the next attempt. */
  const [switchError, setSwitchError] = useState<string | null>(null)
  /** The folder a confirm is currently standing in front of, or null when nothing is pending. */
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null)

  const pickFolder = conveyor.workspace.pickFolder.useMutation()
  const openRoot = conveyor.workspace.openRoot.useMutation()
  const busy = pickFolder.isPending || openRoot.isPending

  // The root listing for whichever folder is open. Loading it is the query's whole job — children
  // load independently as they are expanded, so a deep tree is never walked up front.
  const root = conveyor.workspace.listDirectory.useQuery({
    input: { path: rootPath ?? '' },
    enabled: rootPath !== null,
    retry: false,
  })

  /**
   * Hand a path to main and, if it is still a folder, open it.
   *
   * Main does the checking — the `stat`, and the resolve that gives every folder one spelling — so the
   * store only ever holds a path that was a directory a moment ago. That is also why a refused switch
   * leaves the recents list untouched: the path never reaches the store, so there is nothing to take
   * back out of it. A failure is kept as the *code* and worded here, never as a sentence main wrote.
   *
   * The viewer is cleared only on success, and only here. A switch that fails must leave everything
   * exactly as it was — including the buffer the user may have chosen to keep — so nothing is touched
   * until main has answered. And whatever was open *does* have to go, dirty or clean: a path that
   * belonged to the previous root is now outside the workspace the tree, the git panel and the viewer
   * are all pointed at.
   */
  const runSwitch = async (path: string) => {
    setSwitchError(null)
    try {
      const opened = await openRoot.mutateAsync({ path })

      setSelectedFile(null)
      setSelectedChange(null)
      setEditorDirty(null, false)
      setRootPath(opened.path)
    } catch (err) {
      setSwitchError(err instanceof ConveyorError ? err.code : 'UNKNOWN')
    }
  }

  /**
   * Switch, unless there is something to ask first.
   *
   * Two cases never reach the confirmation. The folder that is already open is not a switch, and
   * asking to discard edits that a no-op would not touch is how a dialog teaches people to click
   * through it. And a clean editor has nothing at stake, which is the ordinary case: opening another
   * folder is a switch, not a decision.
   */
  const requestSwitch = (path: string) => {
    setSwitchError(null)
    if (rootPath !== null && sameRoot(path, rootPath)) return
    if (editorDirty) {
      setPendingSwitch(path)
      return
    }
    void runSwitch(path)
  }

  /** The open folder's own dialog, as before — with the picked path routed through the same switch. */
  const onOpenFolder = async () => {
    setPickError(null)
    setSwitchError(null)
    try {
      const picked = await pickFolder.mutateAsync(undefined)
      // A cancelled dialog returns null, which is an ordinary outcome, not a failure.
      if (picked) requestSwitch(picked)
    } catch {
      setPickError('The folder picker could not be opened.')
    }
  }

  const picker = (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void onOpenFolder()}>
      {busy && <Loader2 className="animate-spin" />}
      {rootPath ? 'Choose Another Folder' : 'Open Folder'}
    </Button>
  )

  return (
    <div className="flex h-full flex-col bg-card">
      <PaneHeader icon={activity.icon} title={activity.panelTitle}>
        <RootSwitcher
          rootPath={rootPath}
          recentRoots={recentRoots}
          busy={busy}
          onSwitch={requestSwitch}
          onForget={forgetRoot}
          onOpenFolder={() => void onOpenFolder()}
        />
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
          {/*
            The open folder heads the tree it describes, so the rows below have a named owner. Git's
            view of the same folder is a panel of its own, one rail item along: the tree is where you
            navigate, and the changes are where you decide what to commit.
          */}
          <div className="shrink-0 border-b border-border px-3 py-1.5">
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={rootPath}>
              {rootPath}
            </p>
          </div>

          {/*
            A refused switch is reported against the folder that is still open, because that is what is
            on screen: nothing moved, and the message has to say so rather than leave the user
            wondering which of the two folders the tree is showing.
          */}
          {switchError && (
            <p className="shrink-0 border-b border-border px-3 py-1.5 text-[12px] text-destructive">
              {rootErrorMessage(switchError)}
            </p>
          )}

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

      {/*
        Discard is destructive and one click away, so it asks first and names the folder it will open —
        the entry in the recents list is the whole reason the question comes up. The buttons are named
        for what they do to the edits, not for the switch: "Cancel" would leave the user unsure whether
        the edits or the folder was the thing that did not happen.
      */}
      <AlertDialog open={pendingSwitch !== null} onOpenChange={(open) => !open && setPendingSwitch(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved edits?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSwitch !== null
                ? `Opening ${rootTail(pendingSwitch)} closes the file you are editing, and the changes you have not saved will be gone. This cannot be undone.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingSwitch
                setPendingSwitch(null)
                if (target === null) return

                // The switch carries the discard: `runSwitch` clears the buffer, and only clears it
                // once main has confirmed the folder opened — so a refused switch still leaves the
                // edits where they were rather than exacting the price of a switch that never
                // happened.
                void runSwitch(target)
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
