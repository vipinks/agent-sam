import { create } from 'zustand'

/**
 * Workbench state. Mostly renderer-local by design — which view is open, which file is shown —
 * because real state (the workspace, the API keys) belongs to main. The one thing that outlives a
 * window here is the chosen model, which is a preference rather than a truth.
 */
interface WorkbenchState {
  /**
   * Id of the active entry in `ACTIVITIES`. `settings` is a view of its own rather than a fourth
   * activity: it takes over the whole main area instead of the secondary panel.
   */
  activeActivity: string
  setActiveActivity: (id: string) => void
  /** Path of the file previewed in the code viewer, or null for the empty state. */
  selectedFile: string | null
  setSelectedFile: (path: string | null) => void
  /** Provider and model the composer sends to. Persisted so a restart resumes where you were. */
  providerId: string
  model: string
  setTarget: (target: { providerId: string; model: string }) => void
}

const TARGET_KEY = 'sam-ai-chat-target'

/** The last used provider/model, or the first provider's defaults. */
function initialTarget(): { providerId: string; model: string } {
  try {
    const saved = localStorage.getItem(TARGET_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as { providerId?: unknown; model?: unknown }
      if (typeof parsed.providerId === 'string' && typeof parsed.model === 'string') {
        return { providerId: parsed.providerId, model: parsed.model }
      }
    }
  } catch {
    // Unreadable preference — fall through to the default rather than failing to start.
  }
  return { providerId: 'deepseek', model: 'deepseek-chat' }
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  activeActivity: 'chat',
  setActiveActivity: (activeActivity) => set({ activeActivity }),
  selectedFile: null,
  setSelectedFile: (selectedFile) => set({ selectedFile }),
  ...initialTarget(),
  setTarget: ({ providerId, model }) => {
    try {
      localStorage.setItem(TARGET_KEY, JSON.stringify({ providerId, model }))
    } catch {
      // A full or blocked localStorage must not break switching models.
    }
    set({ providerId, model })
  },
}))
