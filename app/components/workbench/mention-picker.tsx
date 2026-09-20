import { useEffect, useRef, type ComponentProps } from 'react'
import { FileText, Info } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAX_MENTION_PATHS } from '@/conveyor/protocol/mentions'
import { PopoverContent } from '../ui/popover'

/**
 * The file picker behind an `@` in the composer: the workspace's paths, filtered as the user types.
 *
 * It renders content only. The popover root and its anchor stay with the composer, because the anchor
 * is the textarea wrapper whose caret the token was read from — a picker that owned the root would
 * have to be handed that element back to anchor itself to.
 *
 * The rows are buttons with the caret kept outside them: the keyboard never enters this list. Arrow
 * keys, Enter and Escape are handled on the textarea, so there is one focus story in the composer
 * instead of two competing ones — and a click that pulled focus into the popover would leave the
 * caret somewhere the next keystroke does not expect.
 */
export function MentionPicker({
  paths,
  total,
  activeIndex,
  atCap,
  onSelect,
  onInteractOutside,
}: {
  /** The filtered rows, in display order. */
  paths: readonly string[]
  /** How many paths there are to match at all, so an empty list can say which kind of empty it is. */
  total: number
  activeIndex: number
  /** True when the composer already holds the most files one message may attach. */
  atCap: boolean
  onSelect: (path: string) => void
  onInteractOutside?: ComponentProps<typeof PopoverContent>['onInteractOutside']
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view while the arrow keys walk a list longer than the popover shows.
  // Guarded because jsdom has no `scrollIntoView`, and a test must not fail on a scroll it cannot do.
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]')
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, paths])

  // Two different empties, and saying which it is matters: a filter that matched nothing is a typo to
  // fix, and an empty workspace is a folder the user has not opened yet.
  const emptyMessage = total === 0 ? 'No files to mention — open a folder first.' : 'No matching files'

  return (
    <PopoverContent
      // The composer owns the caret: opening the picker must not move focus into it, and closing it
      // must not move focus anywhere either.
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={onInteractOutside}
      className="max-h-64 w-80 overflow-y-auto p-1"
    >
      {paths.length === 0 ? (
        <p className="px-2 py-1.5 text-[12px] text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div ref={listRef} role="listbox" aria-label="Mention a file">
          {paths.map((path, index) => (
            <button
              key={path}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              data-active={index === activeIndex ? 'true' : undefined}
              // Prevented so a click cannot take focus out of the textarea; the click itself still
              // lands, which is what selects the file.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(path)}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[12px] focus-visible:outline-none',
                index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'
              )}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      )}

      {atCap && (
        <p className="mt-1 flex items-start gap-1.5 border-t border-border px-2 pt-1.5 text-[11.5px] text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>One message can attach at most {MAX_MENTION_PATHS} files. Remove one to add another.</span>
        </p>
      )}
    </PopoverContent>
  )
}
