import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'
import {
  appendComboMember,
  comboMemberSchema,
  comboSchema,
  moveComboMember,
  removeComboMember,
  type Combo,
} from '../protocol/combos'

/**
 * The combos the user built, mirrored to every window.
 *
 * A plain array, ordered by creation, because the picker and the Settings list both read it in the
 * order the user made it and reordering members happens inside one combo rather than to the list.
 *
 * Deliberately *not* `persist: true`. Conveyor's own persistence swallows write failures, which would
 * make `COMBO_IO_ERROR` unreachable: a disk that refused a write would leave the store claiming a
 * save that never happened. The module beside this one owns the file, reads it before every mutation
 * and writes it atomically, then dispatches `replace` with what was actually written — so the mirror
 * is the record of a write that succeeded rather than of one that was attempted.
 */
export interface CombosState {
  combos: Combo[]
}

/** A member as the module sends it: the two fields, nested so the schema is the same one. */
const memberPayload = z.object({ id: z.string().min(1), member: comboMemberSchema })

export const combosStore = defineStore('combos', {
  state: { combos: [] } as CombosState,

  // Payloads cross the trust boundary, so every action's argument type comes from its schema. The
  // list is replaced whole by the module's own load and writes, and the rest are the mutations the
  // Settings screen performs through the module.
  schemas: {
    replace: z.object({ combos: z.array(comboSchema) }),
    create: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      members: z.array(comboMemberSchema).min(1),
    }),
    rename: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    reorder: z.object({
      id: z.string().min(1),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    }),
    addMember: memberPayload,
    removeMember: memberPayload,
    setEnabled: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    remove: z.object({ id: z.string().min(1) }),
  },

  actions: {
    /** Replace the list with what the file says. The module is the only writer, and this is its mirror. */
    replace: (state, { combos }) => {
      state.combos = combos.map((combo) => ({ ...combo, members: combo.members.map((member) => ({ ...member })) }))
    },

    /**
     * Add one combo at the end.
     *
     * The id arrives already derived and collision-free: deriving it here would make this action the
     * second thing that knows how a slug is made, and the module has to know it before the write in
     * order to say whether the id it chose is taken.
     */
    create: (state, { id, name, members }) => {
      if (state.combos.some((combo) => combo.id === id)) return
      state.combos = [
        ...state.combos,
        { id, name: name.trim(), members: members.map((member) => ({ ...member })), enabled: true },
      ]
    },

    /**
     * Retitle a combo, keeping its id.
     *
     * The id is the combo's identity in a saved selection and in the picker's value; a rename that moved
     * it would make a conversation that named `combo::fast` point at nothing. A blank name changes
     * nothing — the module refuses it before the write, and this action cannot return a refusal.
     */
    rename: (state, { id, name }) => {
      const trimmed = name.trim()
      if (!trimmed) return
      state.combos = state.combos.map((combo) => (combo.id === id ? { ...combo, name: trimmed } : combo))
    },

    /** Move one member up or down the priority list. */
    reorder: (state, { id, from, to }) => {
      state.combos = state.combos.map((combo) =>
        combo.id === id ? { ...combo, members: moveComboMember(combo.members, from, to) } : combo
      )
    },

    /**
     * Add a member to the end of a combo.
     *
     * A duplicate pair is idempotent, not an error: adding the same provider/model twice is a user
     * pressing a button twice, and two identical rows would make the walk try the same candidate twice
     * for no reason.
     */
    addMember: (state, { id, member }) => {
      state.combos = state.combos.map((combo) =>
        combo.id === id ? { ...combo, members: appendComboMember(combo.members, member) } : combo
      )
    },

    /** Take one member out. A pair that is not there leaves the combo as it was. */
    removeMember: (state, { id, member }) => {
      state.combos = state.combos.map((combo) =>
        combo.id === id ? { ...combo, members: removeComboMember(combo.members, member) } : combo
      )
    },

    /** Offer or hide a combo in the picker. */
    setEnabled: (state, { id, enabled }) => {
      state.combos = state.combos.map((combo) => (combo.id === id ? { ...combo, enabled } : combo))
    },

    /** Delete a combo. */
    remove: (state, { id }) => {
      state.combos = state.combos.filter((combo) => combo.id !== id)
    },
  },
})
