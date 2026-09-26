import { useEffect, useRef, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import type { ComposerCommand } from '@/conveyor/protocol/composer-commands'
import { PopoverContent } from '../ui/popover'

/**
 * The slash surface: the picker a leading `/` opens, and the card a command answers in.
 *
 * One file because the two are the two halves of one thing — what can be run here, and what running
 * one says — and because neither is worth a module of its own.
 *
 * The picker renders content only, and its popover root and anchor stay with the composer, exactly as
 * the mention picker's do: the anchor is the composer the slash was typed into, and a picker that
 * owned the root would have to be handed that element back to anchor itself to.
 *
 * The rows are buttons with the caret kept outside them: the keyboard never enters this list. Arrow
 * keys, Enter and Escape are handled on the textarea, so there is one focus story in the composer
 * instead of two — and a click that pulled focus into the popover would leave the caret somewhere the
 * next keystroke does not expect. The rows carry their own `data-slot` and `data-command` hooks, so a
 * test reads which command is on offer rather than parsing the words a row happens to render.
 */
export function CommandPicker({
  commands,
  activeIndex,
  onSelect,
  onInteractOutside,
}: {
  /** The rows to offer, in display order, already filtered and already hidden where hidden applies. */
  commands: readonly ComposerCommand[]
  activeIndex: number
  onSelect: (id: ComposerCommand['id']) => void
  onInteractOutside?: ComponentProps<typeof PopoverContent>['onInteractOutside']
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view while the arrow keys walk a list longer than the popover shows.
  // Guarded because jsdom has no `scrollIntoView`, and a test must not fail on a scroll it cannot do.
  useEffect(() => {
    const active = listRef.current?.querySelector('[data-active="true"]')
    if (active && typeof active.scrollIntoView === 'function') active.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, commands])

  return (
    <PopoverContent
      // The composer owns the caret: opening the picker must not move focus into it, and closing it
      // must not move focus anywhere either.
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={onInteractOutside}
      className="max-h-64 w-80 overflow-y-auto p-1"
    >
      <div data-slot="command-picker">
        {commands.length === 0 ? (
          // One empty state rather than two: the set is fixed and small, so a query that matches
          // nothing is always a typo to fix rather than a thing the app has not been given yet.
          <p data-slot="command-empty" className="px-2 py-1.5 text-[12px] text-muted-foreground">
            No matching commands
          </p>
        ) : (
          <div ref={listRef} role="listbox" aria-label="Run a command" data-slot="command-list">
            {commands.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex ? 'true' : undefined}
                data-slot="command-option"
                data-command={command.id}
                // Prevented so a click cannot take focus out of the textarea; the click itself still
                // lands, which is what runs the command.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(command.id)}
                className={cn(
                  'flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left focus-visible:outline-none',
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                {/* Monospace, because it is a word to type — and separated from its sentence by the
                    same gap a chip uses for its icon, so the two read as one row rather than two. */}
                <span className="shrink-0 font-mono text-[12px]">/{command.name}</span>
                <span className="truncate text-[11.5px] text-muted-foreground">{command.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </PopoverContent>
  )
}

/** What a command had to say: a heading, and one line per fact. */
export interface CommandNoticeText {
  title: string
  lines: readonly string[]
}

/**
 * A command's answer, in the composer it was typed in.
 *
 * The card is the shell the plan checklist and the turn-end notice already wear — the same border,
 * the same muted ground, the same small type — because it is the same kind of thing: something the
 * pane has to say *now*, about the work rather than part of it.
 *
 * Deliberately not a transcript turn, and not a toast either. A turn would make `/help` part of the
 * conversation: it would be saved, resumed, exported and sent to the model as history the user never
 * wrote. A toast would take the answer away on a timer, and the one thing a list of commands is for
 * is being read at the reader's own pace. It lives until the user types, which is the moment they have
 * moved on.
 */
export function CommandNotice({ notice }: { notice: CommandNoticeText }) {
  return (
    <section
      aria-label={notice.title}
      data-slot="command-notice"
      className="mt-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
    >
      <p className="text-[11.5px] font-medium text-foreground">{notice.title}</p>
      <div className="mt-0.5 flex flex-col">
        {notice.lines.map((line) => (
          <span key={line} className="text-[11.5px] leading-snug text-muted-foreground">
            {line}
          </span>
        ))}
      </div>
    </section>
  )
}
