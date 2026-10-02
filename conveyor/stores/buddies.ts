import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import {
  buddyRecordSchema,
  isReservedBuddyId,
  isSafeBuddyId,
  MAX_BUDDY_ID_CHARS,
  type BuddyRecord,
} from '../protocol/buddies'

/**
 * The custom Buddies a user has made, and the ones they have switched off.
 *
 * A store rather than a protocol constant, because these are the user's records: main owns them, the
 * renderer mirrors them through `useConveyorStore`, and the file this persists to is the store's own —
 * the same arrangement as the chat list and the context preference, and for the same reason, which is
 * that a fact main acts on cannot live in a window's memory.
 *
 * Two things it deliberately is not. It is not where the built-ins live: those are pure data in
 * `protocol/buddies.ts`, so they cannot be edited, deleted or corrupted by a file, and every install
 * has exactly the same three. And it is not a resolver: resolving an id against built-ins *and* these
 * records is one rule, stated once in the protocol module, rather than a second answer written here.
 *
 * The switches are kept as a set of *ids* rather than a flag on a record, because a built-in can be
 * switched off and there is no record of a built-in anywhere to hold a flag. An id in this list is a
 * Buddy the user has said not to offer; whether it is a built-in or one of their own is a detail the
 * list itself does not care about.
 *
 * Pure (no electron, no react), because both processes import it: main registers it as the source of
 * truth, and the renderer mirrors it.
 */

// Exported, not just local: the router's inferred type references this store, and a declaration that
// cannot name the state type fails to emit (TS4023).
export interface BuddiesState {
  /** The user's own records, in the order they were added. */
  custom: BuddyRecord[]
  /** The ids switched off, whether they name a built-in or a custom record. */
  disabledIds: string[]
}

/** The id a write or a switch names. One rule for both, so a switch cannot name what a record cannot. */
const buddyIdSchema = z
  .string()
  .min(1)
  .max(MAX_BUDDY_ID_CHARS)
  .refine((id) => isSafeBuddyId(id), 'A Buddy id must be a lower-case slug.')

/**
 * A record this store may hold.
 *
 * `builtin: false` is required rather than merely written by the action: a payload claiming to be a
 * built-in is the one shape of write that could put the app's own data into a user's file, and a
 * boundary that refused it is worth more than an action that quietly overwrote the field.
 *
 * A built-in's id — and the default's — is refused for the same reason from the other side: a custom
 * record under one of those ids could never resolve, because the built-in wins. Refused at the
 * boundary, so the user is told while they are naming the thing rather than after a write that appears
 * to work and does nothing.
 */
const customBuddySchema = buddyRecordSchema.extend({
  builtin: z.literal(false),
  id: buddyIdSchema.refine(
    (id) => !isReservedBuddyId(id),
    'That id belongs to the app: the Agent Sam default or a built-in.'
  ),
})

export const buddiesStore = defineStore('buddies', {
  state: { custom: [], disabledIds: [] } as BuddiesState,

  // Payloads cross the trust boundary, so every action's argument type comes from its schema.
  schemas: {
    addBuddy: customBuddySchema,
    updateBuddy: customBuddySchema,
    removeBuddy: z.object({ id: buddyIdSchema }),
    setBuddyEnabled: z.object({ id: buddyIdSchema, enabled: z.boolean() }),
  },

  actions: {
    /**
     * Store one custom record.
     *
     * Idempotent on the id, like every other create in this app: a second add of an id that is already
     * there would otherwise leave two records claiming one id, and a resolver would pick whichever the
     * list happened to put first. An edit is `updateBuddy`, and saying so is what keeps this action the
     * one that only ever adds.
     */
    addBuddy: (state, buddy) => {
      if (state.custom.some((existing) => existing.id === buddy.id)) return
      state.custom = [...state.custom, buddy]
    },

    /**
     * Replace the record an id names, whole.
     *
     * Wholesale rather than field by field, because that is what an editor hands over: the record as it
     * now reads. A partial write would have to be a second payload schema with every field optional,
     * and the two schemas would then be two answers to what a record may be. A record for an id that is
     * not there changes nothing, which is the shape a stale editor leaves behind.
     */
    updateBuddy: (state, buddy) => {
      state.custom = state.custom.map((existing) => (existing.id === buddy.id ? buddy : existing))
    },

    /**
     * Remove a record, and the switch that named it.
     *
     * The switch goes with it rather than outliving it: an id in `disabledIds` with no record left is an
     * entry nobody can turn back on, and it would come back to life if the same id were ever created
     * again. A built-in is not removed by this — it is not in this store to remove, and switching it
     * off is `setBuddyEnabled`.
     */
    removeBuddy: (state, { id }) => {
      state.custom = state.custom.filter((existing) => existing.id !== id)
      state.disabledIds = state.disabledIds.filter((existing) => existing !== id)
    },

    /**
     * Switch a Buddy off, or back on, by id.
     *
     * Written as the state the user asked for rather than as a count of clicks, so switching off
     * something already off is one entry and not two, and the same holds the other way: this is the
     * array the switch is, not a log of what was pressed.
     */
    setBuddyEnabled: (state, { id, enabled }) => {
      state.disabledIds = enabled
        ? state.disabledIds.filter((existing) => existing !== id)
        : [...new Set([...state.disabledIds, id])]
    },
  },

  persist: true,
})
