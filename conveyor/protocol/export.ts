import type { TranscriptSnapshot, TranscriptToolStep } from './transcript'

/**
 * Turning a saved conversation into a file someone can keep.
 *
 * Pure: no electron, no fs, no dialog. Main reads the transcript, calls in here for the bytes, and
 * writes them — so the wording of an export is testable without a filesystem, and the dialog and the
 * write stay in the one place that owns them.
 *
 * The rules that matter are the ones a reader would notice missing: prose in the order it was
 * spoken, every tool call present with what it was asked to do and how it ended, a refusal said in
 * as many words rather than left as an absence, and an unfinished turn declared rather than silently
 * looking complete.
 */

/** What an export can be written as. */
export type ExportFormat = 'markdown' | 'json'

/** How the assistant's turns are headed. The product name, because that is who the reader spoke to. */
const ASSISTANT_HEADING = 'Sam AI'
const USER_HEADING = 'You'

/**
 * How an unfinished turn is declared.
 *
 * A turn left mid-run is a normal thing to export — the app was closed while the model was working —
 * so it is stated as a fact rather than presented as a finished exchange.
 */
const UNFINISHED_NOTE = '> This turn was left unfinished — the app closed while it was still running.'

/** How a conversation that was cut off is declared, when no single turn already says it. */
const CONVERSATION_INTERRUPTED_NOTE = '_This conversation was left mid-turn._'

/** Step statuses that mean the work did not finish. */
const UNSETTLED: ReadonlyArray<TranscriptToolStep['status']> = ['running', 'awaiting', 'queued']

/**
 * The filename an export is offered under, derived from the session's title.
 *
 * Derived rather than asked for, because the dialog already lets the name be changed; this is the
 * default it opens with. Characters a filesystem or the shell would object to are replaced rather
 * than dropped, so two different titles cannot collapse onto one name.
 */
export function exportFileName(title: string, format: ExportFormat): string {
  const cleaned = title
    // Reserved on Windows and meaningful elsewhere; a separator in a filename would also put the
    // export somewhere other than where the dialog said.
    .replace(/[\\/:*?"<>|]/g, '-')
    // Control characters, which would otherwise travel into the filesystem invisibly.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim()

  const extension = format === 'markdown' ? 'md' : 'json'
  return `${cleaned || 'conversation'}.${extension}`
}

/**
 * The conversation as markdown.
 *
 * Headed sections in turn order, with each tool call as its own fenced block. The fence is labelled
 * `tool` and its first line names the tool, so a reader skimming the rendered output can see where
 * the assistant stopped talking and started acting — and so the blocks can be found by searching for
 * a fence rather than by pattern-matching prose.
 */
export function renderMarkdown(snapshot: TranscriptSnapshot, options: { title: string }): string {
  const lines: string[] = [`# ${options.title.trim() || 'Conversation'}`, '']

  for (const turn of snapshot.turns) {
    lines.push(`## ${turn.role === 'user' ? USER_HEADING : ASSISTANT_HEADING}`, '')

    const content = turn.content.trim()
    if (content) lines.push(content, '')

    for (const step of turn.steps) {
      lines.push(...renderToolCall(step), '')
    }

    if (turn.error) {
      lines.push(`> **Error** — ${turn.error}`, '')
    }

    if (turn.steps.some((step) => UNSETTLED.includes(step.status))) {
      lines.push(UNFINISHED_NOTE, '')
    }
  }

  // The flag is a property of the conversation rather than of one turn, so it is stated once at the
  // end — and only when a turn has not already said it, to avoid announcing the same interruption
  // twice in a file that is meant to be read.
  const turnAlreadySaysIt = snapshot.turns.some((turn) => turn.steps.some((step) => UNSETTLED.includes(step.status)))
  if (snapshot.interrupted && !turnAlreadySaysIt) {
    lines.push(CONVERSATION_INTERRUPTED_NOTE, '')
  }

  return `${trimTrailingBlank(lines).join('\n')}\n`
}

/**
 * One tool call, as a fenced block.
 *
 * Three things, in this order, once each: what was called, what it was called with, and how it
 * ended. A denial is written out in words — "denied by the user" — because an export whose only
 * trace of a refusal was a missing outcome would read as an action that never happened, which is a
 * different and much more misleading thing.
 *
 * For a denial the stored output is deliberately not echoed: the app records the UI's own wording
 * there, and printing both would say the same thing twice in a slightly different voice.
 */
function renderToolCall(step: TranscriptToolStep): string[] {
  const fenced = [`\`\`\`tool ${step.tool}`, `args: ${summarizeArgs(step.args)}`]

  if (step.status === 'denied') {
    fenced.push('outcome: denied by the user.')
  } else if (step.output !== undefined && step.output.trim() !== '') {
    // The first line is enough: a stack trace or a diff would otherwise turn one export entry into
    // a page, and the full text is still in the transcript on disk.
    fenced.push(`outcome (${step.status}): ${firstLine(step.output)}`)
  } else {
    fenced.push(`outcome (${step.status}): no outcome recorded.`)
  }

  if (step.code) fenced.push(`code: ${step.code}`)
  fenced.push('```')
  return fenced
}

/**
 * A one-line summary of a call's arguments.
 *
 * Values are JSON-encoded so strings stay distinguishable from numbers, then clipped — a `write_file`
 * argument is a whole file, and pasting it into the export would bury the prose it sits between.
 */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([key, value]) => `${key}=${clip(JSON.stringify(value) ?? 'null', 120)}`)
  return parts.length > 0 ? parts.join(', ') : '(none)'
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0].trim()
  return line === '' ? 'no outcome recorded.' : clip(line, 300)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

/**
 * The export as a string, whichever format was asked for.
 *
 * JSON is the snapshot itself, re-indented: an export is a way out of this app, so the JSON is the
 * data the app actually holds rather than a shape invented for export.
 */
export function renderExport(snapshot: TranscriptSnapshot, options: { title: string; format: ExportFormat }): string {
  if (options.format === 'json') return `${JSON.stringify(snapshot, null, 2)}\n`
  return renderMarkdown(snapshot, options)
}
