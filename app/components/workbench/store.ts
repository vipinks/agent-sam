import { create } from 'zustand'

/**
 * Workbench state. Main owns real state, so once the explorer is backed by a conveyor module this
 * only holds what is genuinely renderer-local: which view is open and which file is shown.
 */
interface WorkbenchState {
  /** Id of the active entry in `ACTIVITIES`. */
  activeActivity: string
  setActiveActivity: (id: string) => void
  /** Path of the file previewed in the code viewer, or null for the empty state. */
  selectedFile: string | null
  setSelectedFile: (path: string | null) => void
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  activeActivity: 'chat',
  setActiveActivity: (activeActivity) => set({ activeActivity }),
  selectedFile: null,
  setSelectedFile: (selectedFile) => set({ selectedFile }),
}))
