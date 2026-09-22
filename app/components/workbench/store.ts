import { create } from 'zustand'
import {
  mergeSavedLayout,
  sanitizeLayoutSizes,
  type LayoutSizes,
  type StoredLayoutSets,
  type WindowState,
} from './layout'
import { BRIGHTNESS_DEFAULT, clampBrightness } from './theme-engine'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from './themes'

/**
 * Workbench state. Mostly renderer-local by design — which view is open, which file is shown —
 * because real state (the workspace, the API keys) belongs to main. The chat target is a
 * preference rather than a truth, so it lives here and survives a restart.
 */
interface WorkbenchState {
  /**
   * Id of the active entry in `ACTIVITIES`. `settings` is a view of its own rather than one of them:
   * it takes over the whole main area instead of the secondary panel.
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
  /**
   * Whether the viewer is taking the chat column's width.
   *
   * The viewer's header control writes it and the workbench layout reads it, and those two are not the
   * same component — which is the whole reason it is here rather than a `useState` in either of them.
   *
   * Session-scoped by construction: nothing writes it to storage, so it lives exactly as long as this
   * renderer does and a restart opens split again. That is deliberate rather than unfinished — it is a
   * way of looking at the thing in front of you, not a setting anyone chose.
   */
  viewerExpanded: boolean
  setViewerExpanded: (expanded: boolean) => void
  /**
   * Which theme the window wears, and how far its surfaces are shifted from that theme's own values.
   *
   * A preference rather than a fact about anything, which is why it lives here with the chat target
   * instead of in main: `theme-engine` turns the pair into the values the document is given, and that
   * arithmetic is pure — there is no state for main to own. The mode is not here: light/dark is the
   * shell's `.dark` class and stays with it, because the class has to be on the document before the
   * first paint and this store is not.
   */
  themeId: ThemeId
  brightness: number
  /** Set the theme, keeping the brightness — the two are one preference, chosen separately. */
  setThemeId: (themeId: ThemeId) => void
  setBrightness: (brightness: number) => void
  /**
   * The layout each window state was last dragged to, one set per state, either of them absent.
   *
   * A preference rather than a fact about anything, so it lives here beside the theme and the chat
   * target rather than in main: the numbers are the renderer's own resize library's output, and main has
   * nothing to do with a separator position. Two keys rather than one because a set dragged while
   * windowed is a fact about that window and not about the maximized one.
   */
  layoutPreferences: StoredLayoutSets
  /** Record what one window state's layout was dragged to, keeping the other state's set as it was. */
  saveLayout: (state: WindowState, sizes: LayoutSizes) => void
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

const THEME_KEY = 'sam-ai-theme-preference'

/** The theme preference as it may have been stored: a theme id and a brightness, or neither. */
function initialThemePreference(): { themeId: ThemeId; brightness: number } {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as { themeId?: unknown; brightness?: unknown }
      // Each key is read on its own rather than the record being accepted or rejected whole. A record
      // written by a version that had a brightness but no theme, or a theme that has since been renamed,
      // must not cost the user the half of the preference that is still meaningful — so a missing or
      // unrecognised key falls back by itself, and an unreadable record falls back entirely.
      return {
        themeId: isThemeId(parsed.themeId) ? parsed.themeId : DEFAULT_THEME_ID,
        brightness: clampBrightness(parsed.brightness),
      }
    }
  } catch {
    // Unreadable preference — fall through to the default rather than failing to start.
  }
  return { themeId: DEFAULT_THEME_ID, brightness: BRIGHTNESS_DEFAULT }
}

/** Persist the theme preference, tolerating a storage that refuses to write. */
function saveThemePreference(themeId: ThemeId, brightness: number): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify({ themeId, brightness }))
  } catch {
    // A full or blocked localStorage must not break switching themes.
  }
}

const LAYOUT_KEY = 'sam-ai-layout-preferences'

/**
 * The two layout sets as they were stored, each read on its own.
 *
 * Read the way the theme preference is, and for the same reason: a record written before both sets
 * existed, or one whose windowed half was corrupted, must not cost the user the half that is still
 * meaningful. Each key is sanitised separately, and a value that is not a set at all is simply absent —
 * which `layoutFor` then resolves to that state's defaults.
 */
function initialLayoutPreferences(): StoredLayoutSets {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as { layoutWindowed?: unknown; layoutMaximized?: unknown }
      const windowed = sanitizeLayoutSizes(parsed.layoutWindowed)
      const maximized = sanitizeLayoutSizes(parsed.layoutMaximized)
      return {
        ...(windowed ? { layoutWindowed: windowed } : {}),
        ...(maximized ? { layoutMaximized: maximized } : {}),
      }
    }
  } catch {
    // Unreadable preference — fall through to no saved sets rather than failing to start.
  }
  return {}
}

/** Persist the two layout sets, tolerating a storage that refuses to write. */
function saveLayoutPreferences(sets: StoredLayoutSets): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(sets))
  } catch {
    // A full or blocked localStorage must not break dragging a separator.
  }
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
  viewerExpanded: false,
  setViewerExpanded: (viewerExpanded) => set({ viewerExpanded }),
  ...initialThemePreference(),
  /**
   * Named `setThemeId` rather than `setTheme` on purpose: the shell's store already has a `setTheme`,
   * and it takes the *mode*. Two setters with one name, one of which takes a theme id and the other
   * 'light' or 'dark', is a mistake waiting to be made at a call site.
   */
  setThemeId: (themeId) =>
    set((state) => {
      saveThemePreference(themeId, state.brightness)
      return { themeId }
    }),
  setBrightness: (brightness) =>
    set((state) => {
      const next = clampBrightness(brightness)
      saveThemePreference(state.themeId, next)
      return { brightness: next }
    }),
  // Present even when nothing was ever saved, so a reader always has a record to resolve against rather
  // than an absent field it would have to treat as an empty one itself.
  layoutPreferences: initialLayoutPreferences(),
  /**
   * The merge is `mergeSavedLayout`'s, not this setter's: which state a set belongs to, and what happens
   * to the other state's set, is a rule about layouts rather than about storage, and the pure suite
   * asserts it directly.
   */
  saveLayout: (state, sizes) =>
    set((current) => {
      const layoutPreferences = mergeSavedLayout(current.layoutPreferences, state, sizes)
      saveLayoutPreferences(layoutPreferences)
      return { layoutPreferences }
    }),
}))
