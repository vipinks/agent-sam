import { useEffect, useRef } from 'react'
import { conveyor } from '@/conveyor/client'
import {
  createWorkspaceChangeHandlers,
  subscribeToWorkspaceChanges,
  type WorkspaceChangeClient,
} from './workspace-changes'

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

  useEffect(() => {
    return subscribeToWorkspaceChanges(
      (listener) => conveyor.workspace.onChanged.subscribe(listener),
      // `conveyor` satisfies the narrowed client structurally; the cast is only here because the
      // real client's members carry more than these handlers use.
      createWorkspaceChangeHandlers(conveyor as unknown as WorkspaceChangeClient, () => openFileRef.current)
    )
  }, [])
}
