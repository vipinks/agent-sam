import { z } from 'zod'
import { defineStore } from 'electron-conveyor/define'

/**
 * The folder the explorer is browsing. It is the single source of truth for "which workspace is
 * open", so main owns it and every window sees the same folder. `persist` survives restarts, which
 * is the whole point: reopening the app lands on the folder you were last working in.
 *
 * The definition is pure (no electron, no react) because both processes import it — main registers
 * it as the source of truth, the renderer mirrors it through `useConveyorStore`.
 */
export const workspaceStore = defineStore('workspace', {
  state: { rootPath: null as string | null },

  // Payloads cross the trust boundary, so the action's argument type comes from this schema.
  schemas: { setRootPath: z.string().nullable() },

  actions: {
    setRootPath: (state, rootPath) => {
      state.rootPath = rootPath
    },
  },

  persist: true,
})
