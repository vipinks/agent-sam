import { useEffect, useRef } from 'react'
import { conveyor } from '@/conveyor/client'
import { useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import {
  createWorkspaceChangeHandlers,
  subscribeToWorkspaceChanges,
  type WorkspaceChangeClient,
} from './workspace-changes'
import { useWorkbenchStore } from './store'

/**
 * The React binding for the workspace-change subscription.
 *
 * Registered once, at the workbench, rather than in the explorer and the viewer separately: one
 * subscription means one coalescer, so a burst of writes produces a single listing invalidation
 * instead of one per subscribed component.
 */
export function useWorkspaceChangeInvalidation(openFile: string | null): void {
  // The subscription outlives any single render, so the open file is read through a ref at flush
  // time rather than captured. Capturing it would mean re-creating the listener — and re-subscribing
  // the event channel — on every render.
  const openFileRef = useRef(openFile)
  useEffect(() => {
    openFileRef.current = openFile
  })

  // The git reads take the workspace root as an input, so it is read through a ref for the same
  // reason: the root changes when the user opens another folder, and that must not re-subscribe.
  const rootPath = useConveyorStore(workspaceStore, (s) => s.rootPath)
  const rootPathRef = useRef(rootPath)
  useEffect(() => {
    rootPathRef.current = rootPath
  })

  // The open buffer's dirty flag and the external-change counter live in the workbench store, which
  // this hook can read at flush time through the same kind of ref — so the subscription is still
  // created once, and still reads the latest state when a burst actually closes.
  const editor = useWorkbenchStore((s) => s.editor)
  const noteExternalChange = useWorkbenchStore((s) => s.noteExternalChange)
  const editorRef = useRef(editor)
  useEffect(() => {
    editorRef.current = editor
  })

  useEffect(() => {
    return subscribeToWorkspaceChanges(
      (listener) => conveyor.workspace.onChanged.subscribe(listener),
      // `conveyor` satisfies the narrowed client structurally; the cast is only here because the
      // real client's members carry more than these handlers use.
      createWorkspaceChangeHandlers(
        conveyor as unknown as WorkspaceChangeClient,
        () => openFileRef.current,
        () => rootPathRef.current,
        {
          isDirty: (path) => editorRef.current.path === path && editorRef.current.dirty,
          noteExternalChange,
        }
      )
    )
  }, [noteExternalChange])
}
