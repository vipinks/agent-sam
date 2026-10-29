import type { EnabledModels, TargetSeed } from './store'

/**
 * The provider-config snapshot main carries across the bridge, held until the workbench store is
 * built. The first provider-config mirror reconcile installs the persisted snapshot, so
 * `initialTarget` derives from persisted enabled models rather than falling back to localStorage alone.
 */
let bootSeed: TargetSeed = {}

export function setBootTargetSeed(enabledModels: EnabledModels): void {
  bootSeed = { enabledModels }
}

export function bootTargetSeed(): TargetSeed {
  return bootSeed
}
