import { useState } from 'react'
import { conveyor } from '@/conveyor/client'
import { defaultLayoutForState, type LayoutSizes, type WindowState } from './layout'

/**
 * The layout the workbench lays out for the window it is in: which state that window is in, and the
 * sizes that state's two groups open with.
 *
 * The state is main's to answer, and this is the whole reason the hook exists rather than the workbench
 * reading a flag of its own. Main created the window; whether that window is maximized is a fact about
 * main's process, and the titlebar's control asks main to change it rather than changing anything in
 * the renderer. A renderer that assumed "windowed" would open a maximized window on the windowed set —
 * the one set of proportions that is certainly wrong for it.
 *
 * Two sources, and the order between them matters. The query asks main once, at launch, for the state a
 * window that already exists is in: nothing pushes an event for a maximize that happened before the
 * renderer subscribed, so a listener alone would open believing every window is windowed. The window
 * module's own event then carries every change after that — the same event the shell's window store
 * already reads for the titlebar's icon, so a click on that control, a double-click on the titlebar and
 * the OS's own shortcut all arrive by one route. A pushed value wins over the queried one, being the
 * newer fact.
 *
 * Before either has arrived the layout is the windowed one, which is what the app opens: main creates
 * every window windowed (`lib/main/app.ts`), so the assumption is only ever a placeholder for an answer
 * that matches it.
 */
export function useWorkbenchLayout(): { state: WindowState; sizes: LayoutSizes } {
  const launch = conveyor.window.isMaximized.useQuery({ retry: false })
  const [pushed, setPushed] = useState<boolean | null>(null)

  conveyor.window.onMaximizeChange.useEvent((maximized: boolean) => setPushed(maximized))

  const state: WindowState = (pushed ?? launch.data ?? false) ? 'maximized' : 'windowed'

  return { state, sizes: defaultLayoutForState(state) }
}
