import {
  CircleAlert,
  CircleCheck,
  Clock,
  FilePenLine,
  FileText,
  Loader2,
  ShieldQuestion,
  SquareTerminal,
  XCircle,
  Zap,
} from 'lucide-react'
import type { McpConsent } from '@/conveyor/protocol/mcp-tools'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { DiffView } from './diff-view'
import { ABANDONED_PAUSE_CODE, LOST_PAUSE_CODE, type ToolStep } from './agent-session'

/**
 * One tool call, as a card in the transcript.
 *
 * A card is content, not a section: it no longer folds, because the run of steps it belongs to folds
 * instead and the row above it is the one control the reader is offered. Thirty calls used to be thirty
 * foldable headers, which is a decision per call about work nobody wants to read; one row over the run
 * says how much work happened and leaves the reading of it to the reader.
 *
 * What is left here is the card's own account of one call, and it is unchanged: the intent in the user's
 * terms ("Reading src/app.ts") rather than the tool's name, the arguments, the diff of a write, the
 * output, and the outcome. The status mark stays on every card, which is what keeps a run's internals
 * readable once its row is open — which call is still running, which landed, which was refused.
 *
 * A call nobody ever decided still says why, in its body, and its card is on screen the moment the row
 * is: nothing about an unanswered question is folded away by this change.
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
  const awaiting = step.status === 'awaiting'
  const queued = step.status === 'queued'
  // Why this call was never decided, as the code the pause that owned it left behind. `undefined` for
  // a step whose turn simply ended, which needs no note: nothing was asked about it.
  const undecided = step.code === LOST_PAUSE_CODE || step.code === ABANDONED_PAUSE_CODE ? step.code : null

  return (
    <div
      data-slot="agent-action-card"
      className={cn(
        'rounded-md border text-[12px]',
        // The brand token rather than a warning colour, which this theme does not define: a pending
        // decision should read as "needs you", not as an error.
        awaiting ? 'border-brand/50 bg-brand-soft/40' : 'border-border bg-muted/30',
        // A queued call is visibly inert rather than dimmed out of existence: the user should see
        // what is waiting behind the decision without mistaking it for something they can act on now.
        queued && 'opacity-70'
      )}
    >
      {/* The card's own one line: which call this is, and how it ended. The same three glyphs the
          header carried, in the same order, so a reader who knew the folded card reads this instantly. */}
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <ToolIcon tool={step.tool} />
        <span className="min-w-0 flex-1 truncate font-medium">{describe(step)}</span>
        <StatusMark status={step.status} />
      </div>

      <div data-slot="agent-action-card-body" className="border-t border-border/70 px-2.5 py-2">
        {/* Why nobody was asked about this call, on the calls nobody was asked about. A flagged
          server's calls run without a pause, so the card names the flag that let this one through
          instead of leaving a server call with no Approve button behind it and no explanation.
          Absent on every call that *was* put to the user, and then nothing is drawn here at all. */}
        {step.autoApproved && (
          <p
            data-slot="mcp-auto-approved"
            className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <Zap className="size-3.5 shrink-0 text-brand" />
            Ran without asking — the {step.autoApproved} flag is on for this server.
          </p>
        )}

        {/* Arguments first: for a write, what is being changed matters more than that it changed.
          For a call to a running server the same room is spent on the consent block, which carries
          the same information with that server's own secrets taken out and cut to a length a card
          can hold — printing the raw arguments as well would put the secrets back on screen next to
          their redaction, which is the one thing the preview exists to prevent. */}
        {step.mcp ? (
          <McpConsentBlock consent={step.mcp} />
        ) : (
          <pre className="max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {formatArgs(step)}
          </pre>
        )}

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
            Waiting its turn — nothing here runs until the decision above is made.
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
    </div>
  )
}

/**
 * Which server is asking, and what it wants to run.
 *
 * The one card that describes a process the user cannot see, so it says all four things a decision needs:
 * the server's id, whether it belongs to the whole app or to this folder, what the config says about its
 * trust, and the call's arguments as far as they can be shown — secrets already removed in main, where
 * the values are known, and one line long, because the question is the call and not the JSON behind it.
 */
function McpConsentBlock({ consent }: { consent: McpConsent }) {
  return (
    <div className="rounded bg-background/60 p-2">
      <div className="flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
        <span className="text-muted-foreground">MCP server</span>
        <span className="font-medium">{consent.serverId}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{scopeLabel(consent)}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{trustLabel(consent)}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
        <span className="text-muted-foreground">Tool</span>
        <span className="font-mono">{consent.toolName}</span>
      </div>
      <pre className="mt-1 max-h-24 overflow-auto rounded bg-background/60 p-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {consent.argsPreview || 'No arguments.'}
      </pre>
    </div>
  )
}

/** Where the server is configured: the whole app, or the folder this turn is running in. */
function scopeLabel(consent: McpConsent): string {
  if (consent.scope === 'project') return 'project scope'
  if (consent.scope === 'user') return 'user scope'
  return 'scope not recorded'
}

/**
 * What the config says about the server, in the words the config layer itself uses.
 *
 * A missing state reads differently for the two scopes, because it means different things: trust governs
 * the project scope alone, so a user-scope server is one the question does not apply to, while a server
 * whose config can no longer be read is one nothing at all can be said about. Those must not read the
 * same, since one of them is reassurance and the other is a reason to look.
 */
function trustLabel(consent: McpConsent): string {
  if (consent.trust === 'matched') return 'trusted'
  if (consent.trust === 'mismatched') return 'changed since it was trusted'
  if (consent.trust === 'absent') return 'never trusted'
  return consent.scope === 'user' ? 'trust not required' : 'trust unknown'
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
  // A running server's tool is named by what it does and where it runs, because "which server" is half
  // of what the user is being asked to allow: the same tool name on another server is another decision.
  if (step.mcp) return `${step.mcp.toolName} on ${step.mcp.serverId}`

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
