import { useConveyorStore } from 'electron-conveyor/react'
import { cn } from '@/lib/utils'
import { chatSessionsStore } from '@/conveyor/stores/chat-sessions'
import { contextPreferencesStore } from '@/conveyor/stores/context-preferences'
import { providerConfigStore } from '@/conveyor/stores/provider-config'
import { contextCard, resolveWindow, type ContextPill } from '@/conveyor/protocol/context-window'

/**
 * The context card: what the conversation on screen is about to spend, placed against its model's window.
 *
 * The resident's second half rather than a fifth tile, because it is not one number. A tile is a figure
 * with a note; this is a figure, the share of a window it occupies, the point the settings declare, the
 * parts it was assembled from and what is left of the window — a reader taking it in needs the whole of
 * that, and splitting it across tiles would be four numbers with no shared subject.
 *
 * It owns no arithmetic. Every string is `contextCard`'s, which is asserted whole in the node suite; what
 * this file decides is only where each string sits, and which of the theme's tokens a pill takes its
 * colour from. The card reads three stores and writes nothing: the measurement off the session record
 * main keeps, the window off the provider's declared map — resolved through the same `resolveWindow` the
 * model row's field feeds — and the compact point off the preferences store the Settings field writes.
 *
 * Two numbers ride the style attribute rather than a class: the fill's width and the tick's position are
 * the data's own, and a Tailwind class cannot be built at runtime. The app already does this twice, for
 * the virtualizer's row height and the theme swatch's variables, and for the same reason.
 */

/** The pill's four looks, each from a token the theme already states. */
const PILL_CLASSES: Record<ContextPill, string> = {
  // Green, the app's own success token: a conversation with room.
  healthy: 'border-success/35 bg-success/10 text-success',
  // Amber is the brand coral, which is this app's caution hue — the same one its warning glyphs take.
  pastCompact: 'border-brand/35 bg-brand-soft text-brand',
  // Red, the destructive token: the request itself has stopped being sendable.
  overWindow: 'border-destructive/35 bg-destructive/8 text-destructive',
  // Neither, for a conversation nothing has declared a window for: muted, which is what an absence looks
  // like everywhere else in this app.
  unknown: 'border-border bg-muted text-muted-foreground',
}

export function ContextWindowCard() {
  const sessions = useConveyorStore(chatSessionsStore, (s) => s.sessions)
  const activeSessionId = useConveyorStore(chatSessionsStore, (s) => s.activeSessionId)
  const compactPercent = useConveyorStore(contextPreferencesStore, (s) => s.compactPoint)
  const session = sessions.find((s) => s.id === activeSessionId)
  // The declared windows, by the model the conversation is running on. Read as the store's own map rather
  // than resolved here, so the selector's answer is the store's own object and a fresh one on every
  // render cannot re-render the panel on every unrelated broadcast.
  const declared = useConveyorStore(providerConfigStore, (s) =>
    session === undefined ? undefined : s.providers[session.providerId]?.modelWindows
  )
  const window = session === undefined ? null : resolveWindow({ model: session.model, modelWindows: declared })

  const view = contextCard({
    snapshot: session?.contextSnapshot ?? null,
    window,
    compactPercent,
  })

  return (
    <div data-slot="overview-context-card" className="mt-2 rounded-lg border border-border bg-card px-3 py-2.5">
      {view.state === 'empty' ? (
        /* Nothing has been measured, so there is no figure to draw: one sentence, and not a card of
           noughts, which would be the app claiming a measurement it does not have. */
        <p data-slot="context-empty" className="text-[12.5px] leading-relaxed text-muted-foreground">
          {view.sentence}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <span
              data-slot="context-pill"
              className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium',
                PILL_CLASSES[view.pill ?? 'unknown']
              )}
            >
              {view.pillLabel}
            </span>
            <span data-slot="context-figure" className="ml-auto font-mono text-[11.5px] tabular-nums">
              {view.figure}
            </span>
          </div>

          {/* The pill's own line, and it is load-bearing: nothing in this build compacts, and a coloured
              pill with no words under it would read as a feature that is about to act on its own. */}
          <p data-slot="context-caption" className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
            {view.pillCaption}
          </p>

          <div data-slot="context-bar" className="relative mt-2 h-4 w-full rounded-full bg-muted">
            <div
              data-slot="context-fill"
              className="h-full rounded-full bg-foreground/20"
              style={{ width: `${view.fillPercent}%` }}
            />
            {/* The tick stands at the percent the Settings field holds, which is the whole point of the
                bar: the distance between the fill's end and this line is what the compact point means. */}
            {view.tickPercent !== null && (
              <div
                data-slot="context-tick"
                className="absolute top-0 h-full w-px bg-foreground/55"
                style={{ left: `${view.tickPercent}%` }}
              />
            )}
            {/* Riding the end of the filled segment, which is where a reader looks for it. */}
            <span
              data-slot="context-used-badge"
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-foreground"
              style={{ left: `${view.fillPercent}%` }}
            >
              {view.usedPercentText}
            </span>
          </div>

          <div className="mt-1.5 flex items-baseline gap-2">
            <span data-slot="context-used" className="font-mono text-[11.5px] tabular-nums">
              {view.usedText}
            </span>
            <span className="text-[10.5px] text-muted-foreground">used</span>
            <span data-slot="context-remainder" className="ml-auto text-right">
              <span className="text-[10.5px] text-muted-foreground">{view.remainderLabel} </span>
              <span className="font-mono text-[11.5px] tabular-nums">{view.remainderText}</span>
            </span>
          </div>

          {/* What the request was assembled from, in the order it is assembled, each part against the same
              window the fill is: the rows are the reader's own check on the total above them. */}
          <ul className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
            {view.categories.map((row) => (
              <li
                key={row.key}
                data-slot={`context-category-${row.key}`}
                className="flex items-baseline gap-2 text-[11px]"
              >
                <span className="truncate text-muted-foreground">{row.label}</span>
                <span className="ml-auto font-mono tabular-nums">{row.tokensText}</span>
                <span className="w-9 text-right font-mono tabular-nums text-muted-foreground">{row.percentText}</span>
              </li>
            ))}
          </ul>

          <div
            data-slot="context-free"
            className="mt-1 flex items-baseline gap-2 border-t border-border pt-1.5 text-[11px]"
          >
            <span className="text-muted-foreground">{view.freeLabel}</span>
            <span className="ml-auto font-mono tabular-nums">{view.freeText}</span>
            <span className="w-24 text-right text-[10.5px] text-muted-foreground">{view.freeCaption}</span>
          </div>

          {/* Where a window is declared, drawn only when there is no window: a dash with no way out of it
              is a dead end, and this sentence is the way out. */}
          {view.pointed !== null && (
            <p data-slot="context-pointed" className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
              {view.pointed}
            </p>
          )}

          <p data-slot="context-footnote" className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
            {view.footnote}
          </p>
        </>
      )}
    </div>
  )
}
