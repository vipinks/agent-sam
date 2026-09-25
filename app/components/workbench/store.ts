import { create } from 'zustand'
import {
  mergeSavedLayout,
  sanitizeLayoutSizes,
  type LayoutSizes,
  type StoredLayoutSets,
  type WindowState,
} from './layout'
import type { RightPanelId } from './right-rail'
import { BRIGHTNESS_DEFAULT, clampBrightness } from './theme-engine'
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from './themes'

/**
 * The sections of the settings screen, in the order the section row offers them.
 *
 * A launch opens the first, and the choice is the run's rather than the machine's: noting that you are
 * the kind of person who configures MCP servers is not something this app has any business remembering.
 */
export type SettingsSection = 'providers' | 'mcp-servers' | 'skills'

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
  /**
   * Which section of the settings screen is showing.
   *
   * Here rather than in `SettingsView` because the screen is unmounted while it is not open, and the
   * choice has to survive a visit: leaving settings and coming back is one visit to a screen, not a
   * fresh entry into it. Not persisted, so a launch opens the first section.
   */
  settingsSection: SettingsSection
  setSettingsSection: (section: SettingsSection) => void
  /**
   * The drawer view settings was opened from, or null while no visit is in progress.
   *
   * The back glyph's whole subject: "where you were" is a fact about this run and not a preference, so
   * it is held for as long as the visit lasts and written nowhere.
   */
  settingsReturnView: string | null
  /** Open the settings screen, remembering the drawer view it is taking over. */
  openSettings: () => void
  /** Leave the settings screen for the view it took over, or the conversation when there is none. */
  closeSettings: () => void
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
   * Which of the right rail's residents is docked into the inner group's right slot, or null while the
   * rail is alone.
   *
   * Not persisted, and on the same side of that line as `viewerExpanded` rather than as
   * `drawerCollapsed`: an open panel is a way of looking at the file in front of you, not a way of
   * working that outlives the window. Nothing writes it to storage, so it lives exactly as long as this
   * renderer does — which is what makes a session switch inside one run leave it alone and every launch
   * open rail-only. The type is the rail registry's, so the ids a rail button offers and the ids this
   * accepts are one list rather than two that could disagree.
   */
  rightPanel: RightPanelId | null
  /**
   * Dock a resident, or put it back when it is the one already docked.
   *
   * A click on the active resident means the same thing here that a second click on the active activity
   * means on the left rail: put away the thing that is open. Every other id is the switch it looks
   * like, and there is no third case — the rail is always there, so nothing has to carry "bring it
   * back", which on the left rail is what the collapse flag's two controls are for.
   */
  toggleRightPanel: (id: RightPanelId) => void
  /** Put the docked panel back to rail-only, whatever is in it. The header's collapse glyph. */
  closeRightPanel: () => void
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
   * Whether the drawer is put away, leaving the icon rail alone beside the main area.
   *
   * A preference rather than a way of looking at something, which is the line between it and
   * `viewerExpanded` beside it: a reader who works with the drawer away is describing how they work, so
   * this one is written to the settings slice and a restart opens the way the last session ended. It
   * lives in the record the two layout sets already occupy — one more key in a record that is already
   * being stored, not a key of its own — and it is stored as present-or-absent: expanded is the absence
   * of the key rather than a `false` in it, so a record written before the drawer could be put away is
   * read as the state it describes.
   */
  drawerCollapsed: boolean
  setDrawerCollapsed: (collapsed: boolean) => void
  /**
   * The conversation-list groups whose rows were left hidden, by group key.
   *
   * A preference rather than a way of looking at something, on the same side of the line as
   * `drawerCollapsed`: someone who keeps one project's history folded away is describing how they work,
   * so it is written to the settings slice and a restart opens the way the last session ended. It
   * shares the record with the layout sets and the drawer flag rather than taking a key of its own,
   * because it is written by the same kind of event — a click on a control that puts something away —
   * and a second key would mean a second writer that could drop this one's half.
   *
   * Empty is the ordinary state and is stored as the absence of the key, so a record written before
   * groups could be put away reads as the state it describes. What a key is — a folder's path, or the
   * empty string for conversations with no project — belongs to `session-project`, which is the only
   * place that spells one.
   */
  collapsedSessionGroups: string[]
  /** Replace the set of put-away groups. Holds no opinion about what a key looks like. */
  setCollapsedSessionGroups: (keys: string[]) => void
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
 * The record stored under `LAYOUT_KEY`: the two layout sets, and whether the drawer is away.
 *
 * One record rather than a second key, because the two are written by the same two kinds of event — a
 * drag and a collapse — and two keys would mean two writers that could each drop the other's half. It
 * is additive in the sense that matters: a reader of either half reads it on its own, so a record
 * written by a version that had only the sets stays perfectly good, and so does one written by this
 * version read by a version that does not know the flag.
 */
interface StoredWorkbenchPreferences extends StoredLayoutSets {
  /** Present only when the drawer was left away; absent means expanded. */
  drawerCollapsed?: boolean
  /**
   * The groups whose rows were left hidden, by key.
   *
   * Present only when at least one group was put away; absent means every group was open, which is how
   * a first launch opens and how a record written before groups could be put away reads.
   */
  collapsedSessionGroups?: string[]
}

/**
 * The stored groups, read as a list of keys and nothing else.
 *
 * Read the way the rest of the record is: a value that is not a list of strings is not a set of
 * put-away groups, and must not cost the user the layout sets stored beside it. Anything else in there
 * is dropped rather than repaired — a key that is not a string names no group.
 */
function collapsedGroupsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((key): key is string => typeof key === 'string')
}

/**
 * The two layout sets and the collapse flag as they were stored, each read on its own.
 *
 * Read the way the theme preference is, and for the same reason: a record written before both sets
 * existed, or one whose windowed half was corrupted, must not cost the user the half that is still
 * meaningful. Each key is sanitised separately, and a value that is not a set at all is simply absent —
 * which `layoutFor` then resolves to that state's defaults. The flag is read the same way, one step
 * stricter: only a stored `true` puts the drawer away, because "expanded" is what every other value —
 * absent, `false`, or unreadable — means, and it is the state a first launch opens in.
 */
function initialLayoutPreferences(): {
  sets: StoredLayoutSets
  drawerCollapsed: boolean
  collapsedSessionGroups: string[]
} {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as StoredWorkbenchPreferences
      const windowed = sanitizeLayoutSizes(parsed.layoutWindowed)
      const maximized = sanitizeLayoutSizes(parsed.layoutMaximized)
      return {
        sets: {
          ...(windowed ? { layoutWindowed: windowed } : {}),
          ...(maximized ? { layoutMaximized: maximized } : {}),
        },
        drawerCollapsed: parsed.drawerCollapsed === true,
        collapsedSessionGroups: collapsedGroupsFrom(parsed.collapsedSessionGroups),
      }
    }
  } catch {
    // Unreadable preference — fall through to no saved sets rather than failing to start.
  }
  return { sets: {}, drawerCollapsed: false, collapsedSessionGroups: [] }
}

/**
 * Persist the record, tolerating a storage that refuses to write.
 *
 * `mergeSavedLayout`'s output for the sets, so the writer cannot drop one of them, and each of the two
 * flags written only when it is set — the absence of a key is what "expanded" and "nothing put away"
 * are stored as. Every caller hands in the halves it is not changing, which is what makes a drag during
 * a collapse write `layoutWindowed` *and* leave `drawerCollapsed` true, and a group put away leave both
 * sets and the drawer flag exactly as they were.
 */
function saveWorkbenchPreferences(sets: StoredLayoutSets, drawerCollapsed: boolean, collapsedGroups: string[]): void {
  const record: StoredWorkbenchPreferences = {
    ...(sets.layoutWindowed ? { layoutWindowed: sets.layoutWindowed } : {}),
    ...(sets.layoutMaximized ? { layoutMaximized: sets.layoutMaximized } : {}),
    ...(drawerCollapsed ? { drawerCollapsed: true } : {}),
    ...(collapsedGroups.length > 0 ? { collapsedSessionGroups: collapsedGroups } : {}),
  }
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(record))
  } catch {
    // A full or blocked localStorage must not break dragging a separator, putting the drawer away, or
    // putting a group away.
  }
}

/**
 * The record as this launch found it, read once when the module is evaluated.
 *
 * Once, because that is when a launch reads anything: both settings it carries have to be in force for
 * the first render — the sets so the groups open at the right proportions, the flag so a window that was
 * left collapsed opens collapsed rather than flashing the drawer and taking it away again.
 */
const launchPreferences = initialLayoutPreferences()

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  activeActivity: 'chat',
  setActiveActivity: (activeActivity) => set({ activeActivity }),
  settingsSection: 'providers',
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  settingsReturnView: null,
  /**
   * The remembered view is only replaced by a visit that starts outside settings. Opening settings
   * again while it is already showing keeps what the visit began with, because the rail's settings
   * control is not a toggle — a second click on it is not a second visit.
   */
  openSettings: () =>
    set((state) => ({
      activeActivity: 'settings',
      settingsReturnView: state.activeActivity === 'settings' ? state.settingsReturnView : state.activeActivity,
    })),
  /**
   * Leaving forgets the remembered view, so the next visit records its own. The fallback is the
   * conversation, which is where a window with nothing chosen belongs — the same answer the drawer gives
   * a store that was never told which activity to show.
   */
  closeSettings: () =>
    set((state) => ({ activeActivity: state.settingsReturnView ?? 'chat', settingsReturnView: null })),
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
  rightPanel: null,
  toggleRightPanel: (id) =>
    // A stored `null` for the panel that was clicked is what "rail-only" is, and it is the absence of a
    // resident rather than a fourth id: nothing docks "nothing". The expansion is dropped with it, so
    // the only state in which the flag is set is one where there is a column for it to widen — which is
    // what keeps the inner group from being left with no panels in it.
    set((state) => (state.rightPanel === id ? { rightPanel: null, viewerExpanded: false } : { rightPanel: id })),
  closeRightPanel: () => set({ rightPanel: null, viewerExpanded: false }),
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
  drawerCollapsed: launchPreferences.drawerCollapsed,
  /**
   * The flag is written with the sets beside it, read from the store at the moment of the write rather
   * than closed over: a collapse and a drag reach this record through the same writer, and neither may
   * drop the other's half of it.
   */
  setDrawerCollapsed: (drawerCollapsed) =>
    set((current) => {
      saveWorkbenchPreferences(current.layoutPreferences, drawerCollapsed, current.collapsedSessionGroups)
      return { drawerCollapsed }
    }),
  collapsedSessionGroups: launchPreferences.collapsedSessionGroups,
  /**
   * The set of put-away groups is resolved by `planGroupCollapse`, not here: which key names a group,
   * and what opening one does to a key written another way, is a rule about grouping rather than about
   * storage. Both other halves travel with the write, so putting a group away cannot reopen the drawer
   * or forget a layout.
   */
  setCollapsedSessionGroups: (collapsedSessionGroups) =>
    set((current) => {
      saveWorkbenchPreferences(current.layoutPreferences, current.drawerCollapsed, collapsedSessionGroups)
      return { collapsedSessionGroups }
    }),
  // Present even when nothing was ever saved, so a reader always has a record to resolve against rather
  // than an absent field it would have to treat as an empty one itself.
  layoutPreferences: launchPreferences.sets,
  /**
   * The merge is `mergeSavedLayout`'s, not this setter's: which state a set belongs to, and what happens
   * to the other state's set, is a rule about layouts rather than about storage, and the pure suite
   * asserts it directly. The collapse flag travels with the write, so a drag cannot reopen a drawer the
   * user put away.
   */
  saveLayout: (state, sizes) =>
    set((current) => {
      const layoutPreferences = mergeSavedLayout(current.layoutPreferences, state, sizes)
      saveWorkbenchPreferences(layoutPreferences, current.drawerCollapsed, current.collapsedSessionGroups)
      return { layoutPreferences }
    }),
}))
