/**
 * The dock, and the one question a double-click in the explorer asks of it.
 *
 * Where the rail's residents *are* is the renderer's own business — the registry lives beside the rail
 * that draws it. But "is the code viewer the thing already docked, or is this a switch?" is a rule about
 * the dock rather than about one component, so it is stated once here and read by the row that asks it
 * and by the suite that proves it, instead of being written down twice.
 *
 * Nothing about the *open file* is here. A double-click selects the row it landed on whatever this
 * answers, because selecting a row is what a click on one has always done; the only decision the second
 * gesture adds is whether the panel showing that file is already open.
 */

/** The resident of the right rail that shows the open file's source: the code viewer. */
export const CODE_RESIDENT = 'code'

/** What a row of the explorer is. A folder toggles, a file opens. */
export type ExplorerRowKind = 'file' | 'folder'

/**
 * Whether a double-click on this row should dock the code viewer.
 *
 * True means the row asks the rail to dock the code viewer — the resident's own id rather than a
 * position, so the rail's registry stays the only place the order is written down. It is asked for as a
 * dock rather than as a toggle: a toggle would put away the very panel this gesture is asking for in the
 * one state where that panel is already up.
 *
 * A file row docks unless the code viewer is already the docked resident. That case is the one with
 * nothing left to do: the panel is open and showing a file, and the selection the clicks already made is
 * what changes which file that is.
 *
 * A folder row never docks, whatever is docked. Expand and collapse is its whole second gesture, and a
 * row that also opened a panel would make the tree's one non-selecting kind its most surprising one.
 *
 * `dockedResident` is a plain id rather than the rail's own union, because the question here is only
 * whether the thing in the slot is this one — and a rule that restated the rail's id type would be a
 * second copy of a list this file has no business owning.
 */
export function doubleClickDocksViewer(row: ExplorerRowKind, dockedResident: string | null): boolean {
  return row === 'file' && dockedResident !== CODE_RESIDENT
}
