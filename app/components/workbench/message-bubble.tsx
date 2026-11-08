import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, Pencil, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../ui/alert-dialog'
import { AutoContinueMark } from './auto-continue-mark'
import { AgentActionCard } from './agent-action-card'
import { MarkdownContent } from './markdown'
import {
  DEFAULT_BUBBLE_ALIGNMENT,
  DEFAULT_FONT_PRESET,
  FONT_PRESETS,
  type BubbleAlignment,
  type FontPresetId,
} from '@/conveyor/protocol/appearance'
import { MentionChipRow } from './mention-chip'
import { AttachmentRefChipRow } from './attachment-chip'
import { contextNoticeText } from './mentions'
import { useLeavingItems } from './motion'
import { branchCount, branchPosition, isUndecidedPause, type AgentTurn } from './agent-session'
import { formatDuration } from './time'
import { useNow } from './tick'

/**
 * The pane's in-flight marks, keyed by the call id they belong to.
 *
 * A step's start and end are known only to the process that watched the call: the transcript has no
 * place for them — `freezeTurn` copies a step wholesale, so an ephemeral key written onto one would go
 * into the file — and a duration assembled after a restart would be invented. So the pane holds them for
 * the life of the window and hands them down, and a card that has no mark simply shows no number.
 */
export interface StepMarks {
  /** When each call was first seen running. Written by the pane, read by the cards. */
  start: Map<string, number>
  /** When each call's run was cut off, for the endings that happened while this process was watching. */
  end: Map<string, number>
}

/**
 * Whether this turn is a run with nothing on screen yet.
 *
 * The one state the working row speaks for, and it is derived rather than stored: a run that has
 * written nothing has an empty `content` and no `steps`, and the first `text_delta` or the first tool
 * frame changes one of those on the same render the row is drawn from — so the row disappears without
 * a timer, a second flag, or a state write of its own. `live` is the pane's fact (this is the turn the
 * running stream is filling, and it is last), so a turn that merely happens to be empty on screen —
 * a settled turn that ended without saying anything, a branch parked empty — is not one that anything
 * is thinking about.
 *
 * `error` and `endNotice` are checked as well as the two empty fields, because both are endings: a
 * turn that failed has its cause drawn under these blocks, and a turn that ended has its notice there.
 * A working row beside either would claim work that is over.
 */
export function isWorking(turn: AgentTurn, live: boolean): boolean {
  return (
    live && turn.content === '' && turn.steps.length === 0 && turn.error === undefined && turn.endNotice === undefined
  )
}

/**
 * Whether a call is in flight, which is the same three states the card draws that way.
 *
 * Read here as well as there because the mid-turn row asks a question about the whole turn — is anything
 * happening — and a run that has a call under way is not quiet, however long ago it last spoke.
 */
function stepInFlight(step: { status: string }): boolean {
  return step.status === 'running' || isUndecidedPause(step)
}

/**
 * The turn's blocks in the order they happened: its cards, its prose, and the seams between them.
 *
 * A model that stopped with work left on its plan is nudged rather than ended, so one turn can contain
 * several stretches of work — and the seam between two of them belongs between the prose that was cut off
 * and the cards of the stretch that resumed it, which is the one thing a card list alone cannot express.
 * The marker is placed by the two positions the seam was recorded at — the cards drawn and the characters
 * narrated when the loop decided to continue — so it lands where the run actually resumed rather than at
 * the top or the bottom of the answer.
 *
 * The prose is drawn in the slices those positions cut it into, and that is what puts a line inside the
 * answer: the narration is one assembled string, so a seam between two of its stretches can only be
 * rendered by cutting the string there. Each slice is its own markdown block, and the slices stay in the
 * order the run wrote them.
 *
 * A stretch of narration is not a thing the reader has to open: it is what the turn said, and an answer
 * behind a header is an answer nobody read. What folds instead is the work — each tool call, in its own
 * row — and never the words.
 *
 * The cards are drawn one row per call, in the order the turn ran them, and each row folds itself. A
 * call in flight is open, a call that has landed is folded, and the user's own toggle on any row is kept.
 *
 * Clamped to what exists: a seam recorded after the last card of the turn as it arrived is drawn after
 * the last card, which is what a transcript read back from disk shows when the resumed stretch narrated
 * but called nothing. A mark stored without a prose position — written before seams carried one, or read
 * from a file saved before they did — leaves the whole answer below it, which is the only placement such
 * a record supports.
 */
function turnBlocks(
  turn: AgentTurn,
  live: boolean,
  onApprove?: (callId: string) => void,
  onDeny?: (callId: string) => void,
  stepMarks?: StepMarks,
  lastFrameAt?: number
): ReactNode[] {
  const marks = turn.continuations ?? []
  const blocks: ReactNode[] = []
  // Where the walk has got to: the cards drawn and the characters narrated so far. Both move forward
  // only, and only to a position a seam was recorded at.
  let cards = 0
  let chars = 0

  /** Push the cards up to `boundary`, which is either a seam or the end of the frame. */
  const cardsUpTo = (boundary: number) => {
    const end = Math.min(boundary, turn.steps.length)
    for (let index = cards; index < end; index += 1) {
      const step = turn.steps[index]
      blocks.push(
        <AgentActionCard
          key={step.callId}
          step={step}
          onApprove={onApprove}
          onDeny={onDeny}
          // The marks the pane took for this call, when it took any. Absent after a restart, which is
          // what keeps an interrupted card from wearing a duration no one measured.
          startedAt={stepMarks?.start.get(step.callId)}
          endedAt={stepMarks?.end.get(step.callId)}
        />
      )
    }
    cards = end
  }

  for (const [position, mark] of marks.entries()) {
    cardsUpTo(mark.afterSteps)
    const start = chars
    const slice = turn.content.slice(start, mark.afterChars ?? start)
    chars += slice.length
    // An empty slice is not a piece of the answer to render — and for a mark with no prose position it is
    // exactly the case above: the text that follows belongs below the line rather than above it.
    if (slice) blocks.push(<MarkdownContent key={`prose-${start}`} content={slice} />)
    blocks.push(<AutoContinueMark key={`auto-${position}-${mark.count}`} mark={mark} />)
  }

  cardsUpTo(turn.steps.length)
  const rest = turn.content.slice(chars)
  // The last slice is the one the empty state reads. A turn with nothing written yet and no cards is a
  // run that has not spoken — but only while it is the run being filled. Which turn that is belongs to
  // the pane (`live`), and the row is drawn from the derivation rather than from a stored flag or a
  // timer: the first `text_delta` writes the content and the first tool frame appends a step, and
  // either one flips the derivation false on the same render.
  //
  // Nothing is drawn otherwise. An empty *settled* turn — one that ended without saying anything — used
  // to draw a static "Thinking…", which was a claim about work that was over. That sentence now belongs
  // to the working row, and an empty turn with nothing running draws nothing at all. An empty slice
  // *between* two seams is the same case for the same reason: the answer paused there.
  //
  // Keyed by where it starts rather than by being the last one: the seam that arrives next cuts this
  // stretch in two, and the same offset on both sides of that cut keeps it the same block — rather than
  // a new one drawn in its place, which would remount the markdown inside it.
  if (rest) {
    blocks.push(<MarkdownContent key={`prose-${chars}`} content={rest} />)
  } else if (isWorking(turn, live)) {
    blocks.push(<WorkingRow key={`working-${chars}`} startedAt={turn.startedAt} />)
  }

  // The mid-turn quiet row: the run has spoken, nothing is in flight, and it has been silent long
  // enough that "is it still going?" is a fair question. The same row and the same word as above —
  // because it is the same state, caught later — drawn at the tail of the live turn only, and only
  // while the turn has an ending left to arrive. Its threshold is the window's own tick, so this adds
  // no second timer to the pane.
  if (live && lastFrameAt !== undefined && !isWorking(turn, live) && !turn.steps.some(stepInFlight)) {
    blocks.push(<IdleRow key={`idle-${chars}`} startedAt={turn.startedAt} lastFrameAt={lastFrameAt} />)
  }

  return blocks
}

/**
 * The row a running turn shows before it has said anything.
 *
 * Three dots and a word, drawn from the turn's own emptiness rather than from a timer: the first
 * `text_delta` writes the content and the first tool frame appends a step, and either one unmounts
 * this on the same render. There is no stored state here for the same reason, so nothing about it can
 * outlive the run or survive it in the wrong bubble.
 *
 * `role="status"` rather than a live region of its own: the row appearing is the whole announcement —
 * the run has started — and the dots are decorative, so they are hidden from a screen reader instead
 * of being read out as three bullets beside the word that says the same thing.
 *
 * The dots pulse, and the guard is the base one (`motion-reduce:animate-none`) rather than the stacked
 * `motion-reduce:data-[…]:animate-none` form: this row is conditionally *rendered*, so no data
 * attribute gates the animation whose specificity the guard would have to match.
 *
 * It is also where the run's elapsed time is read, from the turn's own start: the row a user stares at
 * while nothing else has arrived is exactly where "how long has this been going" belongs, and it is
 * shown from the first render rather than after the first whole second.
 */
function WorkingRow({ startedAt }: { startedAt?: number }) {
  // The one clock, subscribed at the leaf: the bubble around this row is memoised and the transcript is
  // virtualized, so a reading that ticks has to live here or it re-renders the conversation once a second.
  const now = useNow()
  return <WorkingRowMarkup elapsed={startedAt === undefined ? null : now - startedAt} />
}

/**
 * The row a live turn draws when it has gone quiet mid-run.
 *
 * A turn that has said something and is waiting on its own model looks exactly like a finished one: the
 * prose stops, the cards are folded, and nothing moves. This is the row that says otherwise — but only
 * after a silence long enough to be worth reporting, which is why the threshold is read from the window's
 * tick rather than answered on the frame the last chunk landed. Below it this draws nothing at all, so a
 * normal token gap does not make the row flicker in and out.
 *
 * `lastFrameAt` is the pane's mark, taken as every chunk arrives; the row itself holds no state, so it
 * cannot outlive the run it describes or survive into a turn nothing is writing.
 */
const QUIET_ROW_MS = 700

function IdleRow({ startedAt, lastFrameAt }: { startedAt?: number; lastFrameAt: number }) {
  const now = useNow()
  if (now - lastFrameAt < QUIET_ROW_MS) return null
  return <WorkingRowMarkup elapsed={startedAt === undefined ? null : now - startedAt} />
}

/**
 * The row itself: three pulsing dots and the word, with the elapsed span when there is one to show.
 *
 * One markup for both callers, because the quiet row is the same state caught later rather than a second
 * thing to word. The span is passed in rather than read here so each caller owns exactly one subscription
 * to the window's clock.
 */
function WorkingRowMarkup({ elapsed }: { elapsed: number | null }) {
  return (
    <div data-slot="message-working" role="status" className="flex items-center gap-1.5 text-muted-foreground">
      <span aria-hidden="true" className="flex items-center gap-1">
        <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
      </span>
      {/* The word, never the word instead of the time: a run that has been going four seconds says both,
          and a turn without a start says only the word rather than a number nothing measured. */}
      <span>{elapsed === null ? 'Thinking…' : `Thinking… (${formatDuration(elapsed)})`}</span>
    </div>
  )
}

/**
 * A single message bubble.
 *
 * Memoised on purpose: during a stream, every token updates the transcript state, and without this
 * each token would re-render every previous turn — the exact cost the performance rule forbids.
 * Only the streaming message's `content` changes, so only it re-renders.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  live = false,
  onApprove,
  onDeny,
  stepMarks,
  lastFrameAt,
  canEdit,
  onResend,
  onRegenerate,
  onDeleteFromHere,
  turnsRemoved = 1,
  onCheckoutBranch,
  sessionId,
  alignment = DEFAULT_BUBBLE_ALIGNMENT,
  fontPreset = DEFAULT_FONT_PRESET,
}: {
  message: AgentTurn
  /**
   * Whether this is the turn the running stream is filling right now.
   *
   * A fact about the conversation rather than about the message, so the pane decides it: a send appends
   * the assistant turn last and a regenerate truncates the trail to the reply it rewrites, so while a
   * run is in flight the turn it is writing is the last one on screen. Defaulted off, because a bubble
   * rendered on its own — as the copy and markdown suites do — is not being written by anything, and a
   * bubble that claimed to be would draw a working row for a run that does not exist.
   */
  live?: boolean
  /**
   * The pane's in-flight marks for this turn's calls, when it has any.
   *
   * The pane's fact rather than the bubble's, for the reason `live` is: the marks are taken as the stream
   * reports, they are never written down, and a bubble rendered on its own — as the copy and step-row
   * suites do — has no process behind it to have taken them. Absent means every row draws its state and
   * no duration, which is the honest reading for a transcript read back from disk.
   */
  stepMarks?: StepMarks
  /**
   * When the last chunk of this run arrived, and only while it is the live one.
   *
   * The mark the mid-turn quiet row measures silence from. Absent for every settled turn, and for the
   * live one until its first frame, so a turn cannot draw the row before anything has happened.
   */
  lastFrameAt?: number
  onApprove?: (callId: string) => void
  onDeny?: (callId: string) => void
  /**
   * Whether the controls that act on a message are available at all right now.
   *
   * The pane decides this rather than the bubble, because it is a fact about the conversation: a run
   * in flight is producing the very turn an edit or a regenerate writes again, and the trail a branch
   * switch would check out is the one being written, while a decision waiting belongs to a turn that has
   * not ended. Defaulted off, so a bubble rendered on its own — as the copy tests do — offers no control
   * whose effect it cannot perform.
   */
  canEdit?: boolean
  /**
   * Send this message again, with the words and the files it ended up with.
   *
   * The id as well as the text: the pane revises the turn that id names and writes its reply again, and
   * a bubble holding a stale copy of its own turn could not describe what it is replacing.
   */
  onResend?: (turnId: string, text: string, mentionPaths: string[]) => void
  /**
   * Answer this reply again, writing it where it stands.
   *
   * The id for the same reason a resend takes one: the pane writes the turn that id names again, and a
   * bubble holding its own copy of the turn could not describe what is being replaced.
   */
  onRegenerate?: (turnId: string) => void
  /**
   * Delete this message and everything after it.
   *
   * The one action in the row that removes rather than rewrites, so it asks first — through the
   * bubble's own dialog, because the copy differs by role and the count belongs beside the thing
   * being counted. Absent for a bubble rendered on its own, which has no transcript to shorten.
   */
  onDeleteFromHere?: (turnId: string) => void
  /**
   * How many turns a delete at this message would remove.
   *
   * The pane's fact, not the bubble's: only the transcript knows where this message sits. It is read
   * by the confirmation copy, which states the scope rather than leaving the user to discover it.
   */
  turnsRemoved?: number
  /**
   * Move the conversation to one of the trails parked at this turn.
   *
   * The position, and the turn whose branch point it is: the whole trail from that turn onward is what
   * changes, so the pane — which holds the transcript — is what acts, and the bubble only says which
   * position was asked for. Absent for a bubble rendered on its own, which has no trail to move.
   */
  onCheckoutBranch?: (turnId: string, position: number) => void
  /**
   * The conversation this message belongs to, which is where its images are stored.
   *
   * What a reference chip needs to draw anything: the transcript records where an image is rather than
   * what it was, so the chip asks that conversation's folder for the bytes. Absent for a bubble rendered
   * on its own, as the copy tests do — there is no conversation behind it, so its chips stay records.
   */
  sessionId?: string
  /**
   * Which side the user's own bubble sits on.
   *
   * The pane passes the preference it read from the store, because where a bubble sits is a fact about
   * how this app draws a transcript rather than about one turn — and because a bubble rendered on its
   * own, as the copy and markdown suites do, then draws the arrangement those suites already assert
   * against. Under `split` the agent's placement is the same one `same-side` puts both at: this prop
   * moves the user's row off the right edge and never the agent's off the left.
   */
  alignment?: BubbleAlignment
  /**
   * The size the message body is painted at, on both sides of the bubble.
   *
   * The preset rather than a size class: the classes are fixed strings in `protocol/appearance` —
   * Tailwind reads source text — and a caller that assembled one would be building a class the
   * stylesheet does not contain. Defaulted to the preset a launch starts on, so a bubble drawn on its
   * own is the size this app has always painted.
   */
  fontPreset?: FontPresetId
}) {
  const isUser = message.role === 'user'
  // The turn's blocks, built once per render: their order is the order the run happened in, and two
  // passes over the same data would be a second place for it to be got wrong.
  const blocks = turnBlocks(message, live, onApprove, onDeny, stepMarks, lastFrameAt)

  /*
   * The editor, held here rather than in the pane.
   *
   * Only one message is ever being edited, and it is the one on screen under the cursor — a second
   * piece of pane state would be a second place to keep in step with the transcript. The chips start
   * from the turn's own and are the send's `mentionPaths`, so an edit that removed a file really does
   * send the message without it.
   */
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [editChips, setEditChips] = useState<string[]>([])

  const startEditing = () => {
    setEditText(message.content)
    setEditChips(message.mentionPaths ? [...message.mentionPaths] : [])
    setEditing(true)
  }

  const stopEditing = () => {
    setEditing(false)
  }

  const resend = () => {
    setEditing(false)
    onResend?.(message.id, editText.trim(), editChips)
  }

  const saveAndResend = () => {
    // An emptied message is not a message. The editor stays open rather than sending whitespace or
    // closing on a click that did nothing.
    if (editText.trim() === '') return
    // Nothing is asked first, because nothing is removed: the message keeps its place, the words and
    // the answer it had are parked as a branch, and the reply the edit is answered with is written
    // from nothing where it stands.
    resend()
  }

  /** Write this reply again, in the place it already holds. */
  const regenerate = () => {
    onRegenerate?.(message.id)
  }

  /**
   * The branch point this turn holds, when it holds one.
   *
   * Derived rather than stored, like everything else a bubble draws: a turn nothing branched at has one
   * trail and no switcher, and a branch point reads its position and its count off its own fields. The
   * switcher moves the pane rather than this bubble — the whole trail from this turn onward is what
   * changes — so nothing here is state, and nothing here survives a re-render it should not.
   */
  const branches = branchCount(message)
  const branch = branchPosition(message)

  /*
   * What the copy button takes, and the whole of it.
   *
   * `content` is the turn's own text — the version in force, never one of the trails parked in a branch:
   * a parked branch is a conversation this pane can check out and nothing outside it reads, so the
   * clipboard gets the message as the checked-out trail holds it. Everything else a turn carries sits in
   * its own field — tool cards in `steps`, the plan in `plan`, the ending in `endNotice` — so a copy is
   * the words, never a rendering of the widgets that happened to sit among them.
   */
  const copyButton = <CopyMessageButton value={message.content} label={isUser ? 'Copy message' : 'Copy reply'} />

  return (
    <div
      data-slot="message-row"
      className={cn('flex w-full px-4 py-2.5', isUser && alignment === 'split' ? 'justify-end' : 'justify-start')}
    >
      {/* The bubble and the row of controls that acts on it, stacked: the bubble's own column, so the
          row sits at the message's bottom rather than beside it, and `items-*` puts both on the side
          the bubble itself sits on — the right for the user's own under `split`, the left for both
          modes otherwise, which is the one side a reply ever takes.

          `group` sits here, so the row answers to the bubble it acts on and not to empty space beside
          it: hovering the message, or putting the keyboard anywhere inside it, is what reveals the
          row. The column carries the width cap the bubble used to carry, and the row keeps the box it
          reserves whether or not it is showing — a control that appeared on hover would reflow the
          text it is offering to act on. */}
      <div
        className={cn(
          'group flex max-w-[85%] min-w-0 flex-col gap-1',
          isUser && alignment === 'split' ? 'items-end' : 'items-start'
        )}
      >
        <div
          data-slot="message-body"
          className={cn(
            // `max-w-full` beside `min-w-0`, and both are load-bearing for different reasons.
            //
            // The bubble's column is a `flex-col` with `items-*`, and a column flex container sizes its
            // items on the cross axis to their fit-content width — floored at their *min-content* width.
            // `min-w-0` does not touch that floor: it lowers the automatic minimum on the item's *main*
            // axis, which for a column is the vertical one. So one unbreakable descendant — a long command
            // in a tool row, a path with no space in it — made this box as wide as that run, painted out
            // of the row, and was clipped by the transcript's `overflow-x-hidden` at the container edge
            // while the prose around it wrapped at the widened width. `max-w-full` is what caps the
            // fit-content sizing at the column's own width, which is the constraint that was missing.
            'min-w-0 max-w-full rounded-lg px-3.5 py-2.5',
            FONT_PRESETS[fontPreset].sizeClass,
            // The line-height after the size, deliberately: tailwind-merge reads an arbitrary
            // `text-[13px]` beside a `leading-*` class as one conflict and keeps whichever comes later,
            // so a preset placed after this one would silently take the bubble's line-height away.
            'leading-relaxed',
            isUser ? 'bg-brand-soft text-foreground' : 'bg-card text-card-foreground shadow-sm'
          )}
        >
          {isUser ? (
            editing ? (
              <>
                {/* The chips above the text, exactly where the message shows them, and removable here
                  because they are part of what is being sent again rather than a record of what was. */}
                {editChips.length > 0 && (
                  <MentionChipRow
                    paths={editChips}
                    onRemove={(path) => setEditChips((current) => current.filter((chip) => chip !== path))}
                    className="mb-2"
                  />
                )}
                <Textarea
                  // Focused on open: the editor exists to be typed in, and the click that opened it
                  // was the user's way of saying which message.
                  autoFocus
                  value={editText}
                  aria-label="Edit message text"
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      saveAndResend()
                    }
                  }}
                  // A fixed box rather than one that grows with the draft: the transcript is scrolled by
                  // reading, and an editor that pushed the conversation around while being typed in
                  // would move the message the user is working on.
                  className="field-sizing-fixed h-20 w-80 max-w-full resize-none text-[13px]"
                />
                <div className="mt-2 flex items-center justify-end gap-1.5">
                  <Button type="button" size="xs" variant="outline" aria-label="Cancel editing" onClick={stopEditing}>
                    Cancel
                  </Button>
                  <Button type="button" size="xs" aria-label="Save and resend" onClick={saveAndResend}>
                    Save and resend
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* What this message attached, above it: the files are what the sentence is about, and a
                  reopened conversation shows them again from the paths that were stored with it. Not
                  removable here — the message has been sent, so the chips are a record, not a control. */}
                {message.mentionPaths && message.mentionPaths.length > 0 && (
                  <MentionChipRow paths={message.mentionPaths} className="mb-2" />
                )}
                {/* The images it carried, above it and beside the files: both are what the sentence is
                  about. Thumbnails read from the conversation's store, one read per chip — so a reopened
                  conversation shows its pictures again, and a chip whose bytes are gone or over the cap
                  says so in place of one. */}
                {message.imageRefs && message.imageRefs.length > 0 && (
                  <AttachmentRefChipRow images={message.imageRefs} sessionId={sessionId} className="mb-2" />
                )}
                {/* A user's message is literal text: never parsed as markdown, which would eat their
                  angle brackets and asterisks. */}
                <p className="break-words whitespace-pre-wrap">{message.content}</p>
              </>
            )
          ) : (
            <>
              {/* Files this send named that could not be included. Above the answer because they are
                about the question, and a warning the user reads after the reply is a warning too late
                to do anything about. */}
              {message.contextNotices && message.contextNotices.length > 0 && (
                <div className="mb-2 space-y-1">
                  {message.contextNotices.map((notice, index) => (
                    <ContextNoticeRow key={`${notice.path}-${index}`} path={notice.path} code={notice.code} />
                  ))}
                </div>
              )}
              {/* The answer in one column, in the order it happened: a stretch's cards, the prose written
                around them, then the seam that says the app continued itself there. One list rather
                than cards above all the text, because a seam belongs where it happened — between the
                text it cut off and the work that resumed it. */}
              {blocks.length > 0 && <div className="mb-2 space-y-1.5">{blocks}</div>}
            </>
          )}

          {message.error && (
            <p className="mt-2 border-t border-border pt-2 text-[12px] text-destructive">{message.error}</p>
          )}
        </div>
        {/*
          The controls that act on this message, at the bottom of its bubble and in one row.

          The set each kind carries is the one it always had here, plus the from-here delete. Copy sits
          on both, because both have words; edit sits on the user's own, because only their message is
          theirs to rewrite; regenerate sits on a reply, and only with a callback behind it — a bubble
          that cannot reach the pane offers no control whose effect it cannot perform; the delete sits
          on either kind, because the range it removes is the same conversation either way, and only
          with a handler behind it for the same reason; and the branch switcher sits on the turn that is
          a branch point, because checking a branch out moves the whole trail from that turn rather than
          one message's words.

          Hidden at rest and revealed by the bubble's own hover or by the keyboard arriving inside it:
          `opacity-0` rather than `hidden`, so the controls stay in the tab order, and `focus-within`
          alongside `group-hover`, because an affordance only a pointer can reach is not one. The
          reveal is opacity alone — every control's box, and the row's own, is the same whether it is
          showing or not — so nothing under it is rearranged by its appearing.
        */}
        <div
          data-slot="message-actions"
          className="flex translate-y-0.5 items-center gap-0.5 opacity-0 transition-[opacity,transform] duration-150 ease-out focus-within:translate-y-0 focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:transition-none"
        >
          {/* The user's own half of the row, in the order the transcript has always drawn it: the
              control that rewrites the message, then the one that copies it. */}
          {isUser && canEdit && <EditMessageButton onEdit={startEditing} />}
          {isUser && copyButton}
          {/* And the reply's half: the copy beside it, then the control that writes the reply again. */}
          {!isUser && copyButton}
          {!isUser && canEdit && onRegenerate && <RegenerateButton onRegenerate={regenerate} />}
          {/* The delete, on either kind of message and last of the message-level controls. Its copy
              differs by role because the consequence differs — a question and the answer it got, or
              the answer and what followed it — and it asks first because it removes the range rather
              than parking it the way edit and regenerate do. */}
          {canEdit && onDeleteFromHere && (
            <DeleteMessageButton
              role={message.role}
              turnId={message.id}
              turnsRemoved={turnsRemoved}
              parked={branches - 1}
              onDelete={onDeleteFromHere}
            />
          )}
          {/* And the branch switcher, at the turn the rewrite branched at. One control for the pair,
              because checking a branch out moves the whole trail from here rather than a bubble's words;
              drawn only when there is more than one branch, and only while the pane says the conversation
              is settled: a trail still being written has nothing to switch to yet. */}
          {canEdit && onCheckoutBranch && branches > 1 && (
            <BranchSwitcher branch={branch} total={branches} onWalk={(next) => onCheckoutBranch(message.id, next)} />
          )}
        </div>
      </div>
    </div>
  )
})

/** How long the button says a copy happened before going quiet again. */
const COPIED_MS = 1500

/**
 * The branch switcher: an arrow, which branch the pane is on, and an arrow.
 *
 * Drawn only for a turn that is a branch point — a turn with one trail has nothing to switch to. Each
 * arrow is disabled at the end it would go past rather than hidden, so the control's box is the same at
 * every position: an arrow that disappeared at 1/2 would move the count it sits beside, and the count is
 * the thing being read. `n/m` is the branches this position has held, oldest first, with the one on
 * screen wherever it was created — so walking back to 1 and forward to 2 returns to the same two
 * conversations, in the same order, however many times it is used.
 *
 * The label names the direction and the turn is the thing the focus has just arrived next to, which is
 * the convention the copy and edit controls follow: two of these can be on screen at once, and
 * "Previous branch" is what distinguishes the one being focused.
 */
function BranchSwitcher({
  branch,
  total,
  onWalk,
}: {
  branch: number
  total: number
  onWalk: (branch: number) => void
}) {
  return (
    <div data-slot="branch-switcher" className="flex items-center">
      <button
        type="button"
        aria-label="Previous branch"
        disabled={branch <= 1}
        onClick={() => onWalk(branch - 1)}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="px-0.5 text-[11px] text-muted-foreground">
        {branch}/{total}
      </span>
      <button
        type="button"
        aria-label="Next branch"
        disabled={branch >= total}
        onClick={() => onWalk(branch + 1)}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Opens the editor on the message it sits beside.
 *
 * Drawn by the row at the bubble's bottom, and hidden or revealed by the row rather than by itself: a
 * control that carried its own `opacity-0` and its own reveal could be showing while the box around it
 * was not, and the row is the one place that knows what the bubble is doing.
 *
 * The label names the action rather than the message: "Edit message" is what a screen reader user is
 * told, and the message itself is the thing their focus has just arrived next to.
 */
function EditMessageButton({ onEdit }: { onEdit: () => void }) {
  return (
    <button
      type="button"
      aria-label="Edit message"
      onClick={onEdit}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Pencil className="size-3.5" />
    </button>
  )
}

/**
 * Asks for the reply beside it to be written again.
 *
 * The same treatment as the edit control one kind of bubble over: drawn by the row, hidden and
 * revealed by it, and revealed rather than disabled — an affordance only a pointer can reach is not
 * an affordance, and `opacity-0` on the row leaves this in the tab order for exactly that reason.
 *
 * The label names the action rather than the message, like the two buttons it sits with: "Regenerate
 * reply" is what this does, and the reply is the thing the user's focus has just arrived next to.
 */
function RegenerateButton({ onRegenerate }: { onRegenerate: () => void }) {
  return (
    <button
      type="button"
      aria-label="Regenerate reply"
      onClick={onRegenerate}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <RefreshCw className="size-3.5" />
    </button>
  )
}

/**
 * Opens the confirmation for a from-here delete.
 *
 * The row's fourth control, drawn by the row and hidden or revealed by it like the two beside it. The
 * click asks rather than acts: the copy names the range, and at a branch point the parked trails that
 * go with it, because a delete is the one message action a branch switch cannot undo.
 *
 * The dialog lives here rather than in the pane because the bubble is what knows its role — a
 * question and the answer it was given end differently — and each copy says which consequence it is.
 * The action itself is the pane's: this hands over the turn id and nothing else.
 */
function DeleteMessageButton({
  role,
  turnId,
  turnsRemoved,
  parked,
  onDelete,
}: {
  role: 'user' | 'assistant'
  turnId: string
  turnsRemoved: number
  /** How many trails this position holds besides the one on screen. */
  parked: number
  onDelete: (turnId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const title =
    role === 'user' ? 'Delete this message and everything after it?' : 'Delete this reply and everything after it?'
  const count = `${turnsRemoved} ${turnsRemoved === 1 ? 'turn' : 'turns'}`
  const trails = parked > 0 ? ` ${parked} parked ${parked === 1 ? 'trail goes' : 'trails go'} with it.` : ''

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          aria-label="Delete from here"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Trash2 className="size-3.5" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {count} from the conversation.{trails} This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onDelete(turnId)}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Copies one bubble's text to the clipboard.
 *
 * Drawn by the row at the bubble's bottom, and hidden or revealed by the row rather than by itself:
 * the button stays in the tab order while the row is at `opacity-0`, because that is not
 * `display: none`, so a keyboard reaches it without a pointer ever crossing a bubble. That is also why
 * it is revealed rather than disabled: an affordance that exists only for a mouse is not an
 * affordance.
 *
 * The confirmation is the glyph and it clears itself, so a bubble cannot sit there claiming a copy
 * from an hour ago. The label stays the name of the action throughout: it is what the button does,
 * and it is the one thing a screen reader user is told when they land on it.
 */
function CopyMessageButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A bubble unmounts while its confirmation is pending — a session switch re-renders the transcript
  // from a different root — and the timer would then set state on a component that is gone.
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const copy = async (): Promise<void> => {
    // The confirmation follows the write rather than the click: a write the platform refuses never
    // reaches the lines below, so the glyph stays as it was instead of claiming a copy that did not
    // happen.
    await navigator.clipboard.writeText(value)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  const glyphs = useLeavingItems([copied ? 'check' : 'copy'] as const, (glyph) => glyph)

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
    >
      {/* One grid cell for both glyphs: while one leaves and the other arrives they occupy the same
          `size-3.5` square, so the button cannot grow or shift as the swap happens. */}
      <span data-slot="copy-glyph-stack" className="grid size-3.5 place-items-center">
        {glyphs.map(({ item, key, leaving }) => {
          const Glyph = item === 'check' ? Check : Copy
          return (
            <Glyph
              key={key}
              className={cn(
                'col-start-1 row-start-1 size-3.5',
                item === 'check' && 'text-success',
                leaving
                  ? 'animate-out fade-out zoom-out-50 duration-150 ease-out motion-reduce:animate-none'
                  : 'animate-in fade-in zoom-in-50 duration-150 ease-out motion-reduce:animate-none'
              )}
            />
          )
        })}
      </span>
    </button>
  )
}

/**
 * A file the send named that could not be attached.
 *
 * The code is branched on, never the sentence main would have written: the wording belongs to the
 * renderer, and the code is shown beside it because it is the half of the message that does not move
 * when the copy does.
 */
function ContextNoticeRow({ path, code }: { path: string; code: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted px-2 py-1.5 text-[12px] text-muted-foreground">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <p className="min-w-0">
        <span className="font-mono break-all text-foreground">{path}</span> {contextNoticeText(code)}{' '}
        <span className="font-mono">({code})</span>
      </p>
    </div>
  )
}
