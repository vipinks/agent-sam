import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * The titlebar's own button: a square icon control that fills the bar's height.
 *
 * Its own module rather than a local in `titlebar.tsx` because the theme controls beside the window
 * buttons are the same control, and a second copy of the hover treatment would drift from this one.
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
        'flex h-10 w-11 items-center justify-center text-foreground/60 transition-colors',
        destructive ? 'hover:bg-destructive hover:text-white' : 'hover:bg-accent hover:text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
