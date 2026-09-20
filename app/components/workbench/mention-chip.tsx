import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { mentionTail } from './mentions'

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
export function MentionChip({ path, onRemove }: { path: string; onRemove?: (path: string) => void }) {
  return (
    <span
      title={path}
      className="inline-flex max-w-56 min-w-0 items-center gap-1 rounded-md border border-border bg-background py-0.5 pr-0.5 pl-1.5 font-mono text-[11px] text-foreground"
    >
      <span className="truncate">{mentionTail(path)}</span>
      {onRemove && (
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
  className,
}: {
  paths: readonly string[]
  onRemove?: (path: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {paths.map((path) => (
        <MentionChip key={path} path={path} onRemove={onRemove} />
      ))}
    </div>
  )
}
