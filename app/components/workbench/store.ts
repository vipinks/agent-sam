import { create } from 'zustand'

/**
 * Workbench state. Mostly renderer-local by design — which view is open, which file is shown —
 * because real state (the workspace, the API keys) belongs to main. The chat target is a
 * preference rather than a truth, so it lives here and survives a restart.
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
  /** Provider the composer sends to. Paired with `activeModel` below. */
  activeProviderId: string
  /** Model the composer sends to. */
  activeModel: string
  /** Switch provider and model together — a provider's default model is not the previous one's. */
  setTarget: (target: { providerId: string; model: string }) => void
}

const TARGET_KEY = 'sam-ai-chat-target'

/** The default target, which is also what an unreadable preference falls back to. */
const DEFAULT_TARGET = { providerId: 'deepseek', model: 'deepseek-chat' } as const

/** The last used provider/model, or the default. */
function initialTarget(): { activeProviderId: string; activeModel: string } {
  try {
    const saved = localStorage.getItem(TARGET_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as { providerId?: unknown; model?: unknown }
      if (typeof parsed.providerId === 'string' && typeof parsed.model === 'string') {
        return { activeProviderId: parsed.providerId, activeModel: parsed.model }
      }
    }
  } catch {
    // Unreadable preference — fall through to the default rather than failing to start.
  }
  return { activeProviderId: DEFAULT_TARGET.providerId, activeModel: DEFAULT_TARGET.model }
}

export { DEFAULT_TARGET }

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
    set({ activeProviderId: providerId, activeModel: model })
  },
}))
