import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import {
  alignmentSchema,
  DEFAULT_BUBBLE_ALIGNMENT,
  DEFAULT_FONT_PRESET,
  fontPresetSchema,
  type BubbleAlignment,
  type FontPresetId,
} from '../protocol/appearance'

/**
 * The two display preferences the Appearance section writes: which side the user's own bubbles sit on,
 * and how large the message text is painted.
 *
 * A store rather than the renderer-local preference keys in `app/components/workbench/store.ts`, and the
 * reason is the one the terminal's and the compact point's are kept here for, one process over: this is a
 * *preference*, and a preference belongs to the app rather than to one window. Two windows of this app
 * read the same appearance, a restart keeps it, and the value is written to the store's own file instead
 * of a window's `localStorage` — so nothing about how a conversation is drawn is ever written into a
 * session record, which is not where a preference belongs.
 *
 * No behaviour lives here either: this turn stores the two choices, and the chat pane and the Settings
 * section are their two readers. A store that reached into the DOM to apply them would be a second
 * definition of what they mean.
 *
 * The definition is pure (no electron, no react) because both processes import it: main registers it, the
 * renderer mirrors it through `useConveyorStore`, and the ids come from `protocol/appearance`, so the
 * section's option list and this store's gate cannot disagree.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that
// cannot name the state type fails to emit (TS4023).
export interface AppearancePreferencesState {
  /** Which side the user's own bubbles sit on. Read by the chat pane as it draws a turn. */
  alignment: BubbleAlignment
  /** The size the message body is painted at, on both sides of the transcript. */
  fontPreset: FontPresetId
}

export const appearancePreferencesStore = defineStore('appearance-preferences', {
  state: {
    alignment: DEFAULT_BUBBLE_ALIGNMENT,
    fontPreset: DEFAULT_FONT_PRESET,
  } as AppearancePreferencesState,

  // Payloads cross the trust boundary, so each action's argument type comes from its schema — and the
  // schema is where the offered ids are enforced rather than merely restated, so a caller that skipped
  // the field cannot store an id the control does not offer.
  schemas: {
    setAlignment: z.object({ alignment: alignmentSchema }),
    setFontPreset: z.object({ preset: fontPresetSchema }),
  },

  actions: {
    /**
     * Set which side the user's own bubbles sit on.
     *
     * Read by the chat pane and by the section that writes it: one value, so the control shows what the
     * transcript is doing. Nothing is stored per conversation, deliberately — the choice is about how this
     * app draws a chat, and a per-session copy would make two conversations disagree about the user's own
     * preference.
     */
    setAlignment: (state, { alignment }) => {
      state.alignment = alignment
    },

    /** Set the size the message body is painted at. Read by the chat pane as it draws a turn. */
    setFontPreset: (state, { preset }) => {
      state.fontPreset = preset
    },
  },

  persist: true,
})
