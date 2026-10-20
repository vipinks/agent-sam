import * as React from 'react'

import { cn } from '@/lib/utils'
import { SURFACE_FILL, useSurfaceKind } from './surface'

/**
 * The field, as a plate that reads against whatever it is drawn on.
 *
 * A field used to name one light tone for both families of surface, and the tone was the page's own: on a
 * card it read as a hole, and on a page it read as nothing at all — which is the field dissolving into the
 * screen it was typed on. It now asks the surface it is inside, and takes the raised plate on a page or the
 * page's tone on a card. Dark mode is unchanged: `dark:bg-input/50` outranks either light fill.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  const fill = SURFACE_FILL[useSurfaceKind()]

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-xl border border-input px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/50',
        fill,
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        className
      )}
      {...props}
    />
  )
}

export { Input }
