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
  /**
   * The change the diff pane is showing, or null for the pane's empty state.
   *
   * Renderer-local rather than main-owned, for the same reason `selectedFile` is: it is which row the
   * user is looking at, not a fact about the repository. It lives here rather than inside the changes
   * section because two panes read it — the row that is selected and the viewer that renders the diff
   * — and they are not in the same subtree.
   */
  selectedChange: { path: string; side: 'staged' | 'unstaged'; origPath?: string } | null
  setSelectedChange: (change: { path: string; side: 'staged' | 'unstaged'; origPath?: string } | null) => void
  /**
   * The commit message being composed.
   *
   * Held here rather than in the section because a workspace-change refresh re-renders it, and a
   * message typed before a refresh must not be lost to one — the same reason a draft survives a
   * repaint in the composer.
   */
  commitMessage: string
  setCommitMessage: (message: string) => void
  /**
   * What the code viewer's editor is doing, for the parts of the app that are not it.
   *
   * The workspace-change subscription needs to know whether the open buffer has unsaved edits, and it
   * lives outside React — so the buffer's dirty flag is published here rather than kept private to the
   * component. `externalNonce` counts external changes reported for the open path: the viewer watches it
   * to know that a fresh read was caused by something other than its own save.
   *
   * A single slot rather than a map, because one file is open at a time and a map would invite the
   * question of what happens to the entries nothing clears.
   */
  editor: { path: string | null; dirty: boolean; externalNonce: number }
  setEditorDirty: (path: string | null, dirty: boolean) => void
  /** Report that something outside the viewer wrote the open path. */
  noteExternalChange: (path: string) => void
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
  selectedChange: null,
  setSelectedChange: (selectedChange) => set({ selectedChange }),
  commitMessage: '',
  setCommitMessage: (commitMessage) => set({ commitMessage }),
  editor: { path: null, dirty: false, externalNonce: 0 },
  setEditorDirty: (path, dirty) =>
    set((state) => ({
      // A different path means the previous buffer is gone, so the flag is replaced rather than kept.
      editor: { path, dirty, externalNonce: state.editor.path === path ? state.editor.externalNonce : 0 },
    })),
  noteExternalChange: (path) =>
    set((state) => ({
      editor: { ...state.editor, path, externalNonce: state.editor.externalNonce + 1 },
    })),
}))
