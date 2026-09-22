import { useEffect, useRef, useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { layoutFor, type LayoutSizes, type WindowState } from './layout'
import { layoutChangeFor, type GroupLayout, type LayoutGroup } from './layout-memory'
import { useWorkbenchStore } from './store'

/**
 * How long a drag settles before its layout is written.
 *
 * A drag reports continuously — every pointer move reports a new pair of shares — and each report would
 * otherwise be a `localStorage` write of the whole record. The delay is short enough that a drag which
 * ends is remembered well before the user could maximize, restart or look away, and long enough that a
 * drag is one write rather than a few hundred.
 */
export const LAYOUT_WRITE_DEBOUNCE_MS = 200

export interface WorkbenchLayout {
  /** The window state in force, and therefore which of the two stored sets applies. */
  state: WindowState
  /** The sizes both groups open with: that state's saved set, or its defaults where none was saved. */
  sizes: LayoutSizes
  /** A completed drag in the outer group, to be remembered against the active state. */
  onOuterLayoutChanged: (layout: GroupLayout, meta: { isUserInteraction: boolean }) => void
  /** A completed drag inside the main column, remembered the same way — unless the viewer is expanded. */
  onInnerLayoutChanged: (layout: GroupLayout, meta: { isUserInteraction: boolean }) => void
}

/**
 * The layout of the workbench for the window it is in: which state that window is in, the set that state
 * opens with, and the one place a drag turns back into a stored set.
 *
 * The state is main's to answer, and that is the reason this hook exists rather than the workbench
 * keeping a flag of its own. Main created the window; whether that window is maximized is a fact about
 * main's process, and the titlebar's control asks main to change it rather than changing anything in the
 * renderer. A renderer that assumed "windowed" would open a maximized window on the windowed set — the
 * one set of proportions that is certainly wrong for it.
 *
 * Two sources for the state, and the order between them matters. The query asks main once, at launch,
 * for the state a window that already exists is in: nothing pushes an event for a maximize that happened
 * before the renderer subscribed, so a listener alone would open believing every window is windowed. The
 * window module's own event then carries every change after that — the same event the shell's window
 * store already reads for the titlebar's icon, so a click on that control, a double-click on the titlebar
 * and the OS's own shortcut all arrive by one route. A pushed value wins over the queried one, being the
 * newer fact.
 *
 * Before either has arrived the layout is the windowed one, which is what the app opens: main creates
 * every window windowed (`lib/main/app.ts`), so the assumption is only ever a placeholder for an answer
 * that matches it.
 *
 * Both groups declare their set from `sizes` and the workbench keys them on `state`, because Phase 25's
 * turn A proved the library takes a declared layout once and owns it from then on: a different set needs
 * a different group. That is also why the sizes are resolved here rather than in the JSX — the group a
 * state declares and the set a drag writes come from one value, so the two cannot disagree about what
 * the state's layout is.
 */
export function useWorkbenchLayout(): WorkbenchLayout {
  const launch = conveyor.window.isMaximized.useQuery({ retry: false })
  const [pushed, setPushed] = useState<boolean | null>(null)
  const saved = useWorkbenchStore((state) => state.layoutPreferences)
  const saveLayout = useWorkbenchStore((state) => state.saveLayout)
  const viewerExpanded = useWorkbenchStore((state) => state.viewerExpanded)

  conveyor.window.onMaximizeChange.useEvent((maximized: boolean) => setPushed(maximized))

  const state: WindowState = (pushed ?? launch.data ?? false) ? 'maximized' : 'windowed'
  const sizes = layoutFor(state, saved)

  // The drag path reads the current state, set and expansion at the moment a report arrives rather than
  // when the handler was created: a drag that ends just after a maximize belongs to the state the window
  // is in when it ends, and a handler holding an older closure would file it under the wrong set.
  const latest = useRef({ active: state, sizes, viewerExpanded })
  latest.current = { active: state, sizes, viewerExpanded }

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => (pending.current ? clearTimeout(pending.current) : undefined), [])

  const remember = (group: LayoutGroup) => (layout: GroupLayout, meta: { isUserInteraction: boolean }) => {
    // The library reports its own mount as a layout change as well. Only the user's drags are worth
    // remembering; a computed mount would write the layout the app just chose back to itself.
    if (!meta.isUserInteraction) return

    const change = layoutChangeFor({ ...latest.current, group, layout })
    if (!change) return

    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      saveLayout(change.state, change.sizes)
    }, LAYOUT_WRITE_DEBOUNCE_MS)
  }

  return {
    state,
    sizes,
    onOuterLayoutChanged: remember('outer'),
    onInnerLayoutChanged: remember('main'),
  }
}
