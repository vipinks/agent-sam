import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'

/**
 * The title bar's one tooltip shape: an icon in the row, described by the app's own tooltip primitive.
 *
 * A module rather than four copies of the same three elements, because "every icon in the row carries a
 * tooltip" is a claim about a shape, and a shape written out four times is four shapes that happen to agree
 * today. Here the component is one, the placement is one, and the delay is one — the constant below — so a
 * control added to the row gets the row's tooltip by asking for it rather than by remembering what its
 * neighbours do.
 *
 * The delay is zero, and stated rather than inherited: the primitive's own default is already zero, and the
 * row says so anyway, so a change to that default cannot quietly stagger every hover in the row. Placement
 * is `bottom` on the default centre alignment — the tooltip hangs under the glyph it names, which is where a
 * title bar has the room for it.
 *
 * The trigger is the control itself (`asChild`), so the description is hung on the button a reader reaches
 * rather than on a wrapper around it: a wrapper would take the focus ring, the click and the
 * `aria-describedby` with it, and the control would end up described by something it is not.
 */
export const CONTROL_TOOLTIP_DELAY_MS = 0

export function ControlTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={CONTROL_TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
