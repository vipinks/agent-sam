import { useState } from 'react'
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  FilePenLine,
  FileText,
  Loader2,
  ShieldQuestion,
  SquareTerminal,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { DiffView } from './diff-view'
import { ABANDONED_PAUSE_CODE, LOST_PAUSE_CODE, type ToolStep } from './agent-session'

/**
 * One tool call, as a card in the transcript.
 *
 * Collapsed by default, and for the interesting cases that matters: an agent that reads three files
 * should not bury its own answer under their contents, but the user should still be able to open any
 * of them and see exactly what came back. The header states the intent in the user's terms ("Reading
 * src/app.ts") rather than naming the tool, because the tool name is the model's vocabulary, not the
 * user's.
 *
 * Two states are forced open, because a collapsed prompt would hide something the run is blocked on:
 * `awaiting` (your decision is the next thing that happens) and `queued` (this call is waiting its
 * turn behind the one being decided). Only `awaiting` has buttons — consent is per call, so a queued
 * card shows that it is coming without offering a decision it is not entitled to yet. For a
 * `write_file` the card also shows the change itself, so the write is approved after being read
 * rather than before.
 *
 * A call nobody ever decided is forced open for the same reason, and says so: an `interrupted` step
 * with the pause's code on it is a question that ended without an answer, and the one thing worth
 * reading there is which of the two ways that happened.
 */
export function AgentActionCard({
  step,
  onApprove,
  onDeny,
}: {
  step: ToolStep
  onApprove?: (callId: string) => void
  onDeny?: (callId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const awaiting = step.status === 'awaiting'
  const queued = step.status === 'queued'
  // Why this call was never decided, as the code the pause that owned it left behind. `undefined` for
  // a step whose turn simply ended, which needs no note: nothing was asked about it.
  const undecided = step.code === LOST_PAUSE_CODE || step.code === ABANDONED_PAUSE_CODE ? step.code : null
  const expanded = open || awaiting || queued || undecided !== null

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border text-[12px]',
        // The brand token rather than a warning colour, which this theme does not define: a pending
        // decision should read as "needs you", not as an error.
        awaiting ? 'border-brand/50 bg-brand-soft/40' : 'border-border bg-muted/30',
        // A queued call is visibly inert rather than dimmed out of existence: the user should see
        // what is coming without mistaking it for something they can act on now.
        queued && 'opacity-70'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
        />
        <ToolIcon tool={step.tool} />
        <span className="min-w-0 flex-1 truncate font-medium">{describe(step)}</span>
        <StatusMark status={step.status} />
      </button>

      {expanded && (
        <div className="border-t border-border/70 px-2.5 py-2">
          {/* Arguments first: for a write, what is being changed matters more than that it changed. */}
          <pre className="max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {formatArgs(step)}
          </pre>

          {step.diff && <DiffView diff={step.diff} />}

          {step.output && (
            <pre
              className={cn(
                'mt-1.5 max-h-52 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
                step.status === 'failed' && 'text-destructive'
              )}
            >
              {step.output}
            </pre>
          )}

          {awaiting && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={() => onApprove?.(step.callId)}>
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => onDeny?.(step.callId)}>
                Deny
              </Button>
              <span className="text-[11px] text-muted-foreground">Decides this action only.</span>
            </div>
          )}

          {queued && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Waiting its turn — you will be asked about this one separately.
            </p>
          )}

          {/* The two ways a question can end unanswered, told apart because they are different news:
              a pause the process did not survive ended without the user, and one the user ended
              themselves did not. Branching on the code, never on a sentence. */}
          {undecided === LOST_PAUSE_CODE && (
            <p className="mt-2 text-[11px] text-muted-foreground">Not decided — the app closed before you answered.</p>
          )}
          {undecided === ABANDONED_PAUSE_CODE && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Not decided — the turn was ended before this was answered.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ToolIcon({ tool }: { tool: string }) {
  const className = 'size-3.5 shrink-0 text-muted-foreground'
  switch (tool) {
    case 'read_file':
      return <FileText className={className} />
    case 'write_file':
      return <FilePenLine className={className} />
    case 'run_command':
      return <SquareTerminal className={className} />
    default:
      return <ShieldQuestion className={className} />
  }
}

function StatusMark({ status }: { status: ToolStep['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="running" />
    case 'ok':
      return <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" aria-label="succeeded" />
    case 'failed':
      return <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-label="failed" />
    case 'denied':
      return <XCircle className="size-3.5 shrink-0 text-muted-foreground" aria-label="denied" />
    case 'awaiting':
      return <ShieldQuestion className="size-3.5 shrink-0 text-brand" aria-label="needs approval" />
    case 'queued':
      return <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-label="waiting its turn" />
    case 'interrupted':
      return <XCircle className="size-3.5 shrink-0 text-muted-foreground" aria-label="not decided" />
  }
}

/** The action in the user's words, since "run_command" means nothing to someone reading a chat. */
function describe(step: ToolStep): string {
  const path = typeof step.args.path === 'string' ? step.args.path : ''
  const command = typeof step.args.command === 'string' ? step.args.command : ''
  switch (step.tool) {
    case 'read_file':
      return path ? `Reading ${path}` : 'Reading a file'
    case 'write_file':
      return path ? `Writing ${path}` : 'Writing a file'
    case 'run_command':
      return command ? `Running ${command}` : 'Running a command'
    default:
      return step.tool
  }
}

/**
 * The arguments, with file content substituted by a size note.
 *
 * A `write_file` call carries the whole file in its arguments; printing that would push the actual
 * conversation off the screen and duplicate the result below it.
 */
function formatArgs(step: ToolStep): string {
  const { content, ...rest } = step.args as { content?: unknown } & Record<string, unknown>
  const lines = [JSON.stringify(rest, null, 2)]
  if (typeof content === 'string') {
    lines.push(`content: ${content.length} characters`)
  }
  return lines.join('\n')
}
