import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The titlebar's own button: a square icon control on the bar's measure.
 *
 * Its own module rather than a local in `titlebar.tsx` because the theme controls beside the window
 * buttons are the same control, and a second copy of the hover treatment would drift from this one.
 *
 * It is `h-10 w-10` — the bar's own measure in both directions, which is what lets the row's gap token be
 * the same 4px the rails use and the row's pitch stay what it was when the controls were wider and flush.
 *
 * Props are spread onto the button rather than listed, so the control can be handed to `asChild` — a
 * popover or tooltip trigger merges its own `onClick`, `aria-expanded` and `data-state` onto this
 * element, and the trigger is what has to receive them.
 */
export function ControlButton({
  children,
  label,
  destructive,
  className,
  ...props
}: ComponentProps<'button'> & {
  label: string
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        'flex h-10 w-10 items-center justify-center text-foreground/60 transition-colors',
        destructive ? 'hover:bg-destructive hover:text-white' : 'hover:bg-accent hover:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
