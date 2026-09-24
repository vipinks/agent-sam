import { useCallback, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { ConveyorError, useConveyorStore } from 'electron-conveyor/react'
import { workspaceStore } from '@/conveyor/stores/workspace'
import { PICK_FAILED } from './recent-roots'

/**
 * The one place a folder is handed to main and the store is moved to what came back.
 *
 * Two surfaces switch the workspace root — the explorer's switcher and the home screen's project row —
 * and they have to switch it the same way. The parts that must not diverge are the two calls and the
 * refusal: main does the `stat` and the resolve, the store is only ever given a path that was a
 * directory a moment ago, and a failure arrives as a *code* rather than as a sentence main wrote. A
 * second copy of that would be a second thing to get right, and the copy would be invisibly wrong
 * exactly when a folder is gone.
 *
 * What each surface does *around* a switch stays with that surface: the explorer asks about unsaved
 * edits and clears the buffer, the home screen closes the viewer if it is clean. This owns the call.
 */
export interface RootSwitch {
  /**
   * The code the last attempt was refused under, or null.
   *
   * Cleared by the next attempt, and never a message: the wording belongs to the surface that shows
   * it, so main's sentence can change without the UI changing with it.
   */
  error: string | null
  /** True while a switch or the folder dialog is in flight. */
  busy: boolean
  /** The folder the dialog returned, or null when it was dismissed or could not be opened. */
  chooseFolder: () => Promise<string | null>
  /** Open a path, and move the store to the folder main confirmed. Returns the code it failed under. */
  switchRoot: (path: string) => Promise<string | null>
}

export function useRootSwitch(): RootSwitch {
  const { setRootPath } = useConveyorStore(workspaceStore)
  const pickFolder = conveyor.workspace.pickFolder.useMutation()
  const openRoot = conveyor.workspace.openRoot.useMutation()
  const [error, setError] = useState<string | null>(null)

  const switchRoot = useCallback(
    async (path: string) => {
      setError(null)
      try {
        const opened = await openRoot.mutateAsync({ path })
        // Only ever a path main has just confirmed, which is what makes the recents list impossible to
        // poison from here: a path that failed never reaches the store, so there is nothing to take
        // back out of it.
        setRootPath(opened.path)
        return null
      } catch (err) {
        // Branched on the code, never on the message text.
        const code = err instanceof ConveyorError ? err.code : 'UNKNOWN'
        setError(code)
        return code
      }
    },
    [openRoot, setRootPath]
  )

  const chooseFolder = useCallback(async () => {
    setError(null)
    try {
      // A cancelled dialog returns null, which is an ordinary outcome rather than a failure.
      return await pickFolder.mutateAsync(undefined)
    } catch {
      setError(PICK_FAILED)
      return null
    }
  }, [pickFolder])

  return { error, busy: pickFolder.isPending || openRoot.isPending, chooseFolder, switchRoot }
}
