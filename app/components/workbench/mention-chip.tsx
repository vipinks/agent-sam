import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { mentionTail } from './mentions'
import { MOTION_QUICK_MS, useLeavingItems } from './motion'

/**
 * One attached file, as a chip.
 *
 * The label is the path's tail and the full path is the chip's tooltip, because a chip row is a
 * summary: `utils.ts` is what the user recognises, and `app/components/workbench/utils.ts` would
 * push every other chip off the line.
 *
 * The tooltip is the title attribute rather than a Radix one deliberately. A chip is rendered inside
 * the virtualized transcript as well as the composer, so a popper per chip would mean a portal and a
 * measurement per row of a scrolling list — the cost this app's rendering rules exist to avoid — for
 * a label that the platform already shows on hover.
 */
export function MentionChip({
  path,
  onRemove,
  animateOnMount = false,
  leaving = false,
}: {
  path: string
  onRemove?: (path: string) => void
  /** Composer chips arrive; chips in a virtualized transcript reappear on scroll and must stay still. */
  animateOnMount?: boolean
  /** Drawn for one exit window after the composer dropped it; no remove control while it goes. */
  leaving?: boolean
}) {
  return (
    <span
      title={path}
      data-leaving={leaving ? 'true' : undefined}
      className={cn(
        'inline-flex max-w-56 min-w-0 items-center gap-1 rounded-md bg-background py-0.5 pr-0.5 pl-1.5 font-mono text-[11px] text-foreground shadow-sm',
        leaving
          ? 'pointer-events-none animate-out fade-out zoom-out-95 slide-out-to-left-1 duration-150 ease-out motion-reduce:animate-none'
          : animateOnMount &&
              'animate-in fade-in zoom-in-95 slide-in-from-left-1 duration-150 ease-out motion-reduce:animate-none'
      )}
    >
      <span className="truncate">{mentionTail(path)}</span>
      {onRemove && !leaving && (
        <button
          type="button"
          // The path, not the tail: a screen reader is told which file, and two chips for `index.ts`
          // in different folders must be distinguishable by the control that removes them.
          aria-label={`Remove ${path}`}
          onClick={() => onRemove(path)}
          className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}

/** A row of chips in the order the user attached them. */
export function MentionChipRow({
  paths,
  onRemove,
  animateOnMount = false,
  className,
}: {
  paths: readonly string[]
  onRemove?: (path: string) => void
  animateOnMount?: boolean
  className?: string
}) {
  const rendered = useLeavingItems(paths, (path) => path, MOTION_QUICK_MS)
  // Nothing to draw, and nothing leaving: the row keeps itself mounted through the leaving union and
  // only disappears once that union is empty, so the caller must not conditionally render it.
  if (rendered.length === 0) return null

  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {rendered.map(({ item, key, leaving }) => (
        <MentionChip
          key={key}
          path={item}
          onRemove={leaving ? undefined : onRemove}
          animateOnMount={animateOnMount}
          leaving={leaving}
        />
      ))}
    </div>
  )
}
