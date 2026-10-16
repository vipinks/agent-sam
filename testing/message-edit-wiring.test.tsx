import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Editing a sent message, in place.
 *
 * Two claims are made here, and both need a rendered pane to be real. The first is the affordance: an
 * edit control on a user's own message, and *only* then — a conversation that is running or waiting on
 * a decision has no room for an edit, because the turn being edited is what everything after it was an
 * answer to. The second is what saving commits now: the words the message had are kept as a previous
 * version beside the new ones, the reply it was answered with is written again where it stands, and
 * every turn after it is left exactly as it was. Nothing is removed, so nothing is asked first.
 *
 * The chips are asserted on the payload rather than only on the screen, for the same reason the
 * regenerate suite asserts its history there: "the edited message went out with the files that were
 * left on it" is a claim about what the run was handed, and the only place that is checkable is the
 * argument `chatWithTools` received.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window renders no rows at all.
 * The transcript is the whole subject of this suite, so the viewport the browser would have measured is
 * stated here. Scoped to this file, and restored afterwards.
 */

const VIEWPORT = { width: 900, height: 800 }

beforeAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  for (const [property, value] of [
    ['offsetWidth', VIEWPORT.width],
    ['offsetHeight', VIEWPORT.height],
  ] as const) {
    Object.defineProperty(proto, property, { configurable: true, get: () => value })
  }
})

afterAll(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, number>
  delete proto.offsetWidth
  delete proto.offsetHeight
})

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

const QUESTION = 'set up the parser'
const EDITED_TARGET = 'refactor the lexer'
const EDITED_TEXT = 'refactor the lexer, and keep the tokens split'
const AFTER_TEXT = 'also update the docs'

/**
 * A conversation with a message in the middle to edit, and everything the cut has to take with it.
 *
 * The turn after the edit target carries a tool card and a plan on purpose: those are the pieces of the
 * transcript that are not prose, and a cut that dropped the prose while leaving a checklist claiming
 * work that has been removed would be the visible half of getting this wrong.
 */
function transcriptTurns(): TranscriptTurn[] {
  return [
    { id: 'user-1', role: 'user', content: QUESTION, steps: [], mentionPaths: ['src/parser.ts'] },
    { id: 'assistant-2', role: 'assistant', content: 'Set up.', steps: [] },
    {
      id: 'user-3',
      role: 'user',
      content: EDITED_TARGET,
      steps: [],
      mentionPaths: ['src/lexer.ts', 'src/tokens.ts'],
    },
    {
      id: 'assistant-4',
      role: 'assistant',
      content: 'The lexer is rewritten.',
      steps: [{ callId: 'call-4', tool: 'read_file', args: { path: 'src/lexer.ts' }, status: 'ok', output: 'body' }],
      plan: [{ id: 'plan-4', text: 'Rewrite the lexer', status: 'done' }],
    },
    { id: 'user-5', role: 'user', content: AFTER_TEXT, steps: [] },
  ]
}

function snapshot(turns: TranscriptTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, interrupted: false, turns }
}

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'an existing conversation',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

/** Transcript files held in memory, read back exactly as written. */
function transcriptFiles(initial: TranscriptSnapshot) {
  const files: Record<string, TranscriptSnapshot> = { [SESSION_ID]: initial }
  return {
    files,
    load: () => files[SESSION_ID] ?? null,
    save: (input: unknown) => {
      const { id, snapshot: written } = input as { id: string; snapshot: TranscriptSnapshot }
      files[id] = written
      return undefined
    },
  }
}

/** The panel over a stored conversation, with every send recorded. */
function renderChat(options: { turns?: TranscriptTurn[] } = {}) {
  const sent: unknown[] = []
  const transcripts = transcriptFiles(snapshot(options.turns ?? transcriptTurns()))
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: transcripts.load,
    saveTranscript: transcripts.save,
    chatWithTools: (input) => void sent.push(input),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { stub, sent, transcripts }
}

/** The edit controls on screen, in transcript order. */
function editButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: 'Edit message' })
}

/**
 * The bubble a message's own text sits in, which is the row its controls belong to.
 *
 * Scoped rather than asked of the whole screen because one edit can leave more than one message with
 * versions: the message the user rewrote keeps its old words, and the reply written again keeps the
 * answer it replaced — so two pagers can be on screen, and "the pager says 2/2" is a claim about one.
 */
function bubbleOf(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[data-slot="message-row"]')
  if (!row) throw new Error(`no bubble row around ${text}`)
  return row as HTMLElement
}

async function loaded(): Promise<void> {
  await waitFor(() => expect(editButtons().length).toBeGreaterThan(0))
}

/**
 * The channel main's chunks arrive on, read from the recorded start call rather than guessed.
 *
 * `which` picks the start by position: a run that pauses and is decided opens a *second* stream, and
 * the chunks that belong to the resumed part of the turn arrive on that one rather than on the first.
 */
async function streamChannel(stub: BridgeStub, which = 0): Promise<string> {
  await waitFor(() => {
    const starts = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (starts.length <= which) throw new Error(`no stream started at ${which}`)
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[which]
  return `conveyor:stream:${started?.method}`
}

/** Begin a run, so the pane has a turn in flight. */
async function startRun(stub: BridgeStub): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), 'one more thing{Enter}')
  return streamChannel(stub)
}

/** Open the editor on the message that asked for the lexer to be rewritten. */
async function openEditor(text = EDITED_TEXT): Promise<HTMLTextAreaElement> {
  await userEvent.click(editButtons()[1])
  const area = (await screen.findByLabelText('Edit message text')) as HTMLTextAreaElement
  await userEvent.clear(area)
  await userEvent.type(area, text)
  return area
}

/** The last send the panel made, as the payload main would have validated. */
function lastSend(sent: unknown[]): { messages: { content: string }[]; mentionPaths?: string[] } {
  return sent[sent.length - 1] as { messages: { content: string }[]; mentionPaths?: string[] }
}

describe('the edit affordance', () => {
  it('offers a named edit button on every user message, and none on a reply', async () => {
    renderChat()
    await loaded()

    // Three user turns in the fixture and two assistant replies: the count is what shows that the
    // control belongs to the user's own messages rather than to the transcript at large.
    expect(editButtons().length).toBe(3)
  })

  it('is absent while a run is in flight', async () => {
    const { stub } = renderChat()
    await loaded()

    await startRun(stub)

    // Every bubble, not only the streaming one: the edit is unavailable while *any* turn is in flight,
    // because what follows the edited message is exactly what a running turn is producing.
    await waitFor(() => expect(editButtons().length).toBe(0))
  })

  it('is absent while a decision is pending, and back once the run ends', async () => {
    const { stub } = renderChat()
    await loaded()

    const channel = await startRun(stub)
    stub.emit(channel, {
      type: 'data',
      value: {
        type: 'tool_call_start',
        callId: 'call-9',
        tool: 'write_file',
        args: { path: 'src/lexer.ts' },
      },
    })
    stub.emit(channel, {
      type: 'data',
      value: {
        type: 'awaiting_approval',
        callId: 'call-9',
        tool: 'write_file',
        messages: [],
        steps: 0,
        calls: [{ id: 'call-9', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
      },
    })

    // A pause is not the end of the turn: the decision resumes it, so the transcript is still moving.
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Approve' }).length).toBe(1))
    expect(editButtons().length).toBe(0)

    // Deciding it resumes the run on a stream of its own, and that resumed part is still in flight.
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    const resumed = await streamChannel(stub, 1)
    expect(editButtons().length).toBe(0)

    stub.emit(resumed, { type: 'end' })

    // Answered, so the conversation is editable again.
    await waitFor(() => expect(editButtons().length).toBeGreaterThan(0))
  })
})

describe('the inline editor', () => {
  it('opens on the message that was clicked, with its text and its chips', async () => {
    renderChat()
    await loaded()

    await userEvent.click(editButtons()[1])

    const area = (await screen.findByLabelText('Edit message text')) as HTMLTextAreaElement
    expect(area.value).toBe(EDITED_TARGET)
    // The chips as the message carried them, each removable: the file list is part of what is being
    // sent again, so an editor that could not change it would be editing only half the message.
    expect(screen.getByRole('button', { name: 'Remove src/lexer.ts' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove src/tokens.ts' })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Remove src/lexer.ts' }))

    expect(screen.queryByRole('button', { name: 'Remove src/lexer.ts' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove src/tokens.ts' })).toBeTruthy()
  })
})

describe('editing a sent message', () => {
  it('keeps the words it had as a previous version, re-runs its reply, and drops nothing', async () => {
    const { stub, sent, transcripts } = renderChat()
    await loaded()

    await openEditor()
    await userEvent.click(screen.getByRole('button', { name: 'Remove src/lexer.ts' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save and resend' }))

    // Nothing is asked, because nothing is removed: the dialog existed for a cut, and there is none.
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // The message goes to the loop with the words just written and the chips left on it — only one of
    // the two attached files remains, and that is what the payload has to carry.
    await waitFor(() => expect(sent.length).toBe(1))
    const payload = lastSend(sent)
    expect(payload.messages[payload.messages.length - 1].content).toBe(EDITED_TEXT)
    expect(payload.mentionPaths).toEqual(['src/tokens.ts'])

    // Every later turn is still in the conversation: the reply to the edited message is being written
    // again where it stood, and the message after it was not touched at all.
    expect(screen.getByText(AFTER_TEXT)).toBeTruthy()
    // That reply's own work is being written again from nothing, so the card and the checklist of the
    // answer that was are gone until the new answer brings its own.
    expect(screen.queryByText('Reading src/lexer.ts')).toBeNull()
    expect(screen.queryByText('Rewrite the lexer')).toBeNull()
    // And the messages before it are untouched.
    expect(screen.getByText(QUESTION)).toBeTruthy()

    // A run in flight withdraws the controls that act on the transcript, and the pager with them: the
    // version it would walk to is the one being written.
    await waitFor(() => expect(editButtons().length).toBe(0))
    expect(screen.queryByText('2/2')).toBeNull()

    const channel = await streamChannel(stub)
    stub.emit(channel, { type: 'data', value: { type: 'text_delta', text: 'Tokens split.' } })
    stub.emit(channel, { type: 'end' })
    await waitFor(() => expect(screen.getByText('Tokens split.')).toBeTruthy())

    // Two versions of the message now, with the newest on screen and the chips it is sent with. The
    // reply that was written again carries its own pair, which is the other half of the same rule.
    const row = bubbleOf(EDITED_TEXT)
    await waitFor(() => expect(within(row).getByText('2/2')).toBeTruthy())
    expect(within(bubbleOf('Tokens split.')).getByText('2/2')).toBeTruthy()
    expect(screen.queryByTitle('src/lexer.ts')).toBeNull()

    // Walking back shows the words this message used to have, and the chips it carried then.
    await userEvent.click(within(row).getByRole('button', { name: 'Previous version' }))
    expect(within(row).getByText('1/2')).toBeTruthy()
    expect(screen.getByText(EDITED_TARGET)).toBeTruthy()
    expect(screen.getByTitle('src/lexer.ts')).toBeTruthy()

    // And the record keeps all of it: both versions of the message, and every turn the conversation
    // had — the reply written again, and the message that followed it. The file is still the version
    // this build reads, because the arrays are additive.
    const stored = transcripts.files[SESSION_ID]
    expect(stored.turns.map((turn) => turn.id)).toEqual(['user-1', 'assistant-2', 'user-3', 'assistant-4', 'user-5'])
    const edited = stored.turns[2]
    expect(edited.content).toBe(EDITED_TEXT)
    expect(edited.mentionPaths).toEqual(['src/tokens.ts'])
    expect(edited.userVersions).toEqual([{ content: EDITED_TARGET, mentionPaths: ['src/lexer.ts', 'src/tokens.ts'] }])
    expect(stored.version).toBe(TRANSCRIPT_VERSION)
  })

  it('leaves the conversation untouched when the editor is cancelled', async () => {
    const { stub } = renderChat()
    await loaded()

    // The editor's own cancel: the edit is abandoned, the message stands as it was sent, and nothing
    // has run.
    await openEditor()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))

    expect(screen.queryByLabelText('Edit message text')).toBeNull()
    expect(screen.getByText(EDITED_TARGET)).toBeTruthy()
    expect(screen.getByText(AFTER_TEXT)).toBeTruthy()
    expect(screen.getByText('Rewrite the lexer')).toBeTruthy()
    expect(stub.methodsOn('agent')).not.toContain('chatWithTools')
    // One version of the message, so there is nothing for a pager to walk to.
    expect(screen.queryByText('2/2')).toBeNull()
  })

  it('edits the last message in place, and starts the reply it never had', async () => {
    const { sent } = renderChat()
    await loaded()

    // The last message in the conversation: it has no reply, so there is nothing to write again and the
    // run starts one. Labeled by its place rather than by its text, because the text is what is being
    // replaced.
    const last = 'also update the docs'
    await userEvent.click(editButtons()[2])
    const area = (await screen.findByLabelText('Edit message text')) as HTMLTextAreaElement
    expect(area.value).toBe(last)
    await userEvent.clear(area)
    await userEvent.type(area, 'and the readme{Enter}')

    // The message itself carries the new words — not a second copy of them appended to the transcript.
    await waitFor(() => expect(screen.getByText('and the readme')).toBeTruthy())
    expect(screen.queryByRole('alertdialog')).toBeNull()

    // And a reply to it is being written: the run was handed a history that ends at this message.
    await waitFor(() => expect(sent.length).toBe(1))
    const payload = lastSend(sent)
    expect(payload.messages[payload.messages.length - 1].content).toBe('and the readme')
  })
})
