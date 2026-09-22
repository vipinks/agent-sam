import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/**
 * shadcn/ui's slider, on the same `radix-ui` package the other primitives in this folder use.
 *
 * Written by hand for the same reason `popover.tsx` was — `npx shadcn add slider` also rewrites files
 * that are already here — and it adds no dependency: `radix-ui` is already a direct dependency and
 * already supplies the tooltip, select, dialog and popover this app uses, so the brightness control
 * reuses an installed primitive rather than growing a second one beside it.
 *
 * One thumb, because the app's only slider sets one number. Radix's range form is a `Slider` with a
 * thumb per value; adding the mapping before something asks for a range would be machinery with no
 * caller, and it is three lines when one appears.
 *
 * The accessible name and the value text are handed to the *thumb*, which is the element Radix gives
 * `role="slider"`. Left on the root they would sit on a plain container that has no such role, and a
 * screen reader would announce the control as an unnamed number — the props look like they belong to
 * the slider and are silently inert.
 */
function Slider({
  className,
  'aria-label': ariaLabel,
  'aria-valuetext': ariaValueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn('relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50', className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
        className="block size-3.5 shrink-0 rounded-full border-2 border-primary bg-background shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
