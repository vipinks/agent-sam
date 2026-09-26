import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_SCROLLBACK_LINES,
  MAX_FONT_SIZE,
  MAX_SCROLLBACK_LINES,
  MIN_FONT_SIZE,
  MIN_SCROLLBACK_LINES,
} from '../protocol/terminal-preferences'

/**
 * The terminal's two preferences: how much a shell retains, and how large it is drawn.
 *
 * A store rather than the renderer-local preference keys in `app/components/workbench/store.ts`, and
 * the reason is who reads them: the scrollback limit is consumed by *main*, which bounds a session's
 * transcript when the shell is created — and main cannot read a renderer's `localStorage`. A
 * cross-window store is the one shape both processes can hold, so these are the first preferences on
 * this side of that line. The persisted file is the store's own, so neither value is written into a
 * session record or a transcript: a preference is not a fact about a conversation.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers it,
 * the renderer mirrors it through `useConveyorStore`, and the bounds come from
 * `protocol/terminal-preferences` so the section's field rule and this store's gate cannot disagree.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that
// cannot name the state type fails to emit (TS4023).
export interface TerminalPreferencesState {
  /** Lines of a shell's output a session retains. Read when a session is created. */
  scrollbackLines: number
  /** The terminal's font size in pixels. Applied to the retained terminal as it changes. */
  fontSize: number
}

export const terminalPreferencesStore = defineStore('terminal-preferences', {
  state: {
    scrollbackLines: DEFAULT_SCROLLBACK_LINES,
    fontSize: DEFAULT_FONT_SIZE,
  } as TerminalPreferencesState,

  // Payloads cross the trust boundary, so each action's argument type comes from its schema — and the
  // schema is where the bounds are enforced, not just restated: a caller that skipped the field would
  // otherwise be able to store a limit the field would have refused.
  schemas: {
    setScrollbackLines: z.object({
      lines: z.number().int().min(MIN_SCROLLBACK_LINES).max(MAX_SCROLLBACK_LINES),
    }),
    setFontSize: z.object({
      pixels: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE),
    }),
  },

  actions: {
    /**
     * Set the retention bound for shells created from now on.
     *
     * Deliberately not retroactive: a session that is running keeps the bound it was created with, so
     * a lowered limit does not silently discard lines a reader is scrolling back through — and main
     * reads this value once, when it creates a session, which is what makes that true rather than a
     * promise this action keeps.
     */
    setScrollbackLines: (state, { lines }) => {
      state.scrollbackLines = lines
    },

    /** Set the font size. Applied live by the terminal's own host, which owns the drawn instance. */
    setFontSize: (state, { pixels }) => {
      state.fontSize = pixels
    },
  },

  persist: true,
})
