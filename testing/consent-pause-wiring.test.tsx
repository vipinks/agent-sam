import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { firstPauseViolation } from '@/conveyor/protocol/approval'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { SAVE_DEBOUNCE_MS } from '@/app/components/workbench/session-rules'
import { agentSystemPrompt, PLAN_DISCIPLINE_NOTE } from '@/conveyor/protocol/context'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The consent pause, as wiring rather than as a rule.
 *
 * `agent-session-test.ts` owns what each chunk does to the transcript, and the node suites own what the
 * loop does with a decision. What only a rendered pane can show is the thing this phase exists for: a
 * pause is never a state the user cannot act on and never a state that outlives the process quietly.
 *
 * Three claims, each of which was false before this suite existed:
 *
 * - Whenever the pane holds a pending decision, a card is on screen with Approve and Deny behind it —
 *   for every shape a pause can take, including one whose call fragment never arrived.
 * - A denial ends the turn where it stands rather than asking the model again, and the turn's plan is
 *   reconciled through the same ending every other ending passes through.
 * - A pause survives a switch to another conversation and back, and a pause the process outlived is
 *   reconciled at load into a named interrupted state with a notice — never a card with buttons that
 *   do nothing.
 */

const FIRST_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * Scoped to this file and restored afterwards, so no other suite inherits a fabricated size.
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

function sessionStore(activeSessionId: string) {
  return {
    sessions: [FIRST_ID, SECOND_ID].map((id, index) => ({
      id,
      title: id === FIRST_ID ? 'the first conversation' : 'the second conversation',
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })),
    activeSessionId,
  }
}

/** The transcript files, held in memory and read back exactly as written. */
function transcriptFiles(initial: Record<string, TranscriptSnapshot>) {
  const files: Record<string, TranscriptSnapshot> = { ...initial }
  return {
    files,
    load: (input: unknown) => files[(input as { id: string }).id] ?? null,
    save: (input: unknown) => {
      const { id, snapshot } = input as { id: string; snapshot: TranscriptSnapshot }
      files[id] = snapshot
      return undefined
    },
  }
}

/** A save as the bridge recorded it, already read down to the pair main is handed. */
interface SaveCall {
  id: string
  snapshot: TranscriptSnapshot
}

function saveCalls(stub: BridgeStub): SaveCall[] {
  return stub
    .callsTo('sessions')
    .filter((call) => call.method === 'saveTranscript')
    .map((call) => call.args[0] as SaveCall)
}

/**
 * The writes no save may ever produce: a snapshot that still holds a call waiting on a person.
 *
 * Read off the payloads rather than off the file map, because the file is what the stub kept and the
 * payload is what this side asked to be written — a file the test never touched and a call that
 * carried the pause are the same defect seen from its two ends.
 */
function pausedSaveCalls(stub: BridgeStub): SaveCall[] {
  return saveCalls(stub).filter((call) =>
    call.snapshot.turns.some((turn) =>
      turn.steps.some((step) => step.status === 'awaiting' || step.status === 'queued')
    )
  )
}

/** Let the real debounce window pass and its IPC chain settle, as the phase-34 pin does. */
async function afterDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 100))
}

/** The switch between two conversations, driven through the same `openSession` the list uses. */
function SessionSwitch() {
  const sessions = useChatSessionsContext()
  return (
    <div>
      <button type="button" onClick={() => void sessions.openSession(FIRST_ID)}>
        open the first conversation
      </button>
      <button type="button" onClick={() => void sessions.openSession(SECOND_ID)}>
        open the second conversation
      </button>
    </div>
  )
}

function renderChat(options: { active?: string; files?: Record<string, TranscriptSnapshot> } = {}) {
  const transcripts = transcriptFiles(options.files ?? {})
  const stub = createBridgeStub({
    chatWithTools: () => undefined,
    resume: () => undefined,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: transcripts.load,
    saveTranscript: transcripts.save,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionStore(options.active ?? FIRST_ID))
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
        <SessionSwitch />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { ...view, stub, transcripts }
}

/** The channel main's chunks would arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub): Promise<string> {
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

/** Send one message from the composer and return the channel the run's chunks arrive on. */
async function startRun(stub: BridgeStub, text = 'refactor the parser'): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), `${text}{Enter}`)
  return streamChannel(stub)
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/**
 * Every stream that has been started, with the member it started and the input it carried.
 *
 * The member is the call's own `method` — a stream id of the form `<module>.<method>#<id>` — and not a
 * field of the envelope, so the test reads the same wire the hooks wrote.
 */
function starts(stub: BridgeStub): Array<{ member: string; input: Record<string, unknown> }> {
  return stub.calls
    .filter((call) => call.channel === 'conveyor:stream:start')
    .map((call) => {
      const envelope = call.args[0] as { input?: Record<string, unknown> }
      return { member: call.method, input: envelope.input ?? {} }
    })
}

/** A call as the model sent it, which is how the pause and the resume both carry it. */
function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

/** One plan declaration, as the loop merges and announces it. */
function plan(steps: Array<{ id: string; text: string; status: string }>) {
  return { type: 'plan', plan: steps }
}

/**
 * A pause as main sends one.
 *
 * The messages are the provider-shaped history main was holding, standing instruction and all — that
 * is what the decision hands back, so a stub that sent an empty list would test the queue and not the
 * echo.
 */
function pause(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'awaiting_approval',
    tool: 'write_file',
    args: {},
    messages: [
      { role: 'system', content: agentSystemPrompt(process.platform) },
      { role: 'user', content: 'refactor the parser' },
    ],
    steps: 1,
    plan: [],
    ...overrides,
  }
}

/** The content the composer is offering to send, which is how a blocked pane shows itself. */
function composerPlaceholder(): string | null {
  return screen.getByLabelText('Message').getAttribute('placeholder')
}

/**
 * The status marks of the tool cards, in the order they are on screen.
 *
 * Read from the DOM rather than from the transcript so the claim is about what the user is looking at:
 * a result rendered *below* an undecided call is the defect this phase is about, whichever way the
 * transcript produced it. The marks are the cards' own `aria-label`s — the same vocabulary the status
 * icon renders — so this reads the rendered state rather than re-deriving it.
 */
const RENDERED_STATUSES: Record<string, string> = {
  running: 'running',
  succeeded: 'ok',
  failed: 'failed',
  denied: 'denied',
  'needs approval': 'awaiting',
  'waiting its turn': 'queued',
  'not decided': 'interrupted',
}

function renderedStatuses(): Array<{ callId: string; status: string }> {
  const marks = screen.queryAllByLabelText(
    /^(running|succeeded|failed|denied|needs approval|waiting its turn|not decided)$/
  )
  // Document order is card order, which is the transcript's order — the order the rule is about.
  return marks.map((mark, index) => ({
    callId: `card-${index}`,
    status: RENDERED_STATUSES[mark.getAttribute('aria-label') ?? ''] ?? 'running',
  }))
}

/** Where the invariant is checked in the one place it is visible: the rendered card list. */
function renderedViolation(): { awaitingCallId: string; settledCallId: string } | null {
  return firstPauseViolation(renderedStatuses())
}

describe('a consent pause', () => {
  it('renders an actionable card for a pause nothing announced a fragment for', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    // The pause is the authority: a chunk whose call fragment never arrived still leaves the user
    // something to decide on, because the decision is the pending state and not the card that a
    // previous chunk happened to open.
    chunk(
      stub,
      channel,
      pause({
        callId: 'c1',
        args: { path: 'a.ts' },
        calls: [call('c1', 'write_file', { path: 'a.ts', content: 'next\n' })],
        diff: { lines: [{ kind: 'added', text: 'next' }], added: 1, removed: 0, truncated: false },
      })
    )

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByText('Writing a.ts')).toBeTruthy()
    // And what is being approved is on the card: a write is read before it is allowed. The marker is
    // part of the rendered line, so the whole line is what is asked for.
    expect(await screen.findByText('+ next')).toBeTruthy()
  })

  it('leaves only the head of a queued frame actionable, and resumes with the queue intact', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'c2', tool: 'run_command', args: { command: 'npm test' } })
    chunk(
      stub,
      channel,
      pause({
        callId: 'c1',
        args: { path: 'a.ts' },
        calls: [
          call('c1', 'write_file', { path: 'a.ts', content: 'x' }),
          call('c2', 'run_command', { command: 'npm test' }),
        ],
      })
    )

    // One decision, one call: the sibling is visibly waiting rather than offering a second approval.
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBe(1)
    expect(screen.getByText('Waiting its turn — nothing here runs until the decision above is made.')).toBeTruthy()
    // And nothing below the decision claims to have finished: a card under an open decision that
    // carried a result is exactly the session this phase was written for.
    expect(renderedViolation()).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))

    // The queue travels with the decision: main answers the head and presents the next of the frame's
    // own calls rather than a reconstruction of them.
    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resume = starts(stub)[1]
    expect(resume.member.startsWith('agent.resume#')).toBe(true)
    expect(resume.input.decision).toBe('approved')
    expect((resume.input.calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['c1', 'c2'])

    // The history goes back exactly as main handed it over — including the standing instruction main
    // composed into it. The renderer injects nothing of its own, which is what keeps a resumed run
    // from being sent the same prompt twice; the line is asserted here because *this* echo is the
    // renderer's only opportunity to get it wrong.
    const echoed = resume.input.messages as Array<{ role: string; content: string }>
    expect(echoed.filter((m) => m.role === 'system').length).toBe(1)
    expect(echoed.filter((m) => m.content.includes(PLAN_DISCIPLINE_NOTE)).length).toBe(1)
  })

  it('runs a frame from the gate onward in order, with one card per call', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    // The reported frame as the loop now sends it: the exempt calls in front ran and reported, the
    // command is the gate, and the two calls behind it are carded as queued with no fragment of their
    // own — because the loop announces nothing behind the gate.
    chunk(stub, channel, { type: 'tool_call_start', callId: 'r1', tool: 'read_file', args: { path: 'a.ts' } })
    chunk(stub, channel, { type: 'tool_result', callId: 'r1', tool: 'read_file', ok: true, output: 'body' })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'c2', tool: 'run_command', args: { command: 'npm test' } })
    chunk(
      stub,
      channel,
      pause({
        callId: 'c2',
        tool: 'run_command',
        args: { command: 'npm test' },
        calls: [
          call('c2', 'run_command', { command: 'npm test' }),
          call('r3', 'read_file', { path: 'a.ts' }),
          call('r4', 'read_file', { path: 'b.ts' }),
        ],
      })
    )

    // Both calls behind the decision are on screen as waiting, and neither carries a result.
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(screen.getAllByText('Waiting its turn — nothing here runs until the decision above is made.')).toHaveLength(
      2
    )
    expect(renderedViolation()).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resumed = await streamChannelFrom(stub, 1)

    // The resumed walk announces each call as it reaches it. The announcement replaces the card that
    // was already waiting rather than adding a second one, so the frame stays one card per call.
    chunk(stub, resumed, { type: 'tool_result', callId: 'c2', tool: 'run_command', ok: true, output: 'passed' })
    chunk(stub, resumed, { type: 'tool_call_start', callId: 'r3', tool: 'read_file', args: { path: 'a.ts' } })
    chunk(stub, resumed, { type: 'tool_result', callId: 'r3', tool: 'read_file', ok: true, output: 'body' })
    chunk(stub, resumed, { type: 'tool_call_start', callId: 'r4', tool: 'read_file', args: { path: 'b.ts' } })
    chunk(stub, resumed, { type: 'tool_result', callId: 'r4', tool: 'read_file', ok: true, output: 'other' })

    // Four calls ran in all: the read in front of the gate, the command, and the two reads the command
    // was holding. Every one of them settled on the card it already had.
    await waitFor(() => expect(screen.getAllByLabelText('succeeded').length).toBe(4))
    // One card per call, in the frame's own order: r1 in front of the gate, then the command and the two
    // reads it was holding. No call is carded twice and none is missing — the announcement that reached
    // the card already waiting replaced it rather than adding a second one.
    expect(screen.queryByLabelText('not decided')).toBeNull()
    expect(screen.queryByLabelText('needs approval')).toBeNull()
    expect(screen.getAllByText('Reading a.ts').length).toBe(2)
    expect(screen.getAllByText('Running npm test').length).toBe(1)
    expect(screen.getByText('Reading b.ts')).toBeTruthy()
    // And the invariant holds at the end of the frame too: nothing here is undecided, so nothing is
    // reported as having run ahead of a decision.
    expect(renderedViolation()).toBeNull()
  })

  it('advances the queue when the head is answered', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(stub, channel, { type: 'tool_call_start', callId: 'c2', tool: 'run_command', args: { command: 'npm test' } })
    chunk(
      stub,
      channel,
      pause({
        callId: 'c1',
        args: { path: 'a.ts' },
        calls: [
          call('c1', 'write_file', { path: 'a.ts', content: 'x' }),
          call('c2', 'run_command', { command: 'npm test' }),
        ],
      })
    )
    await screen.findByRole('button', { name: 'Approve' })
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resumed = await streamChannelFrom(stub, 1)

    // The loop runs the head, reports it, and pauses again on the next call of the same frame.
    chunk(stub, resumed, { type: 'tool_result', callId: 'c1', tool: 'write_file', ok: true, output: 'wrote a.ts' })
    chunk(
      stub,
      resumed,
      pause({
        callId: 'c2',
        tool: 'run_command',
        args: { command: 'npm test' },
        calls: [call('c2', 'run_command', { command: 'npm test' })],
      })
    )

    // The second call is now the one being asked about, and the first is settled rather than asking again.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBe(1))
    expect(screen.getByText('Running npm test')).toBeTruthy()
    expect(screen.queryByText('Waiting its turn — nothing here runs until the decision above is made.')).toBeNull()
  })

  it('ends the turn when a decision is denied rather than asking the model again', async () => {
    const stub = renderChat().stub
    const channel = await startRun(stub)

    chunk(
      stub,
      channel,
      plan([
        { id: 'read', text: 'Read the parser', status: 'in_progress' },
        { id: 'tests', text: 'Add tests for it', status: 'pending' },
      ])
    )
    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(
      stub,
      channel,
      pause({ callId: 'c1', args: { path: 'a.ts' }, calls: [call('c1', 'write_file', { path: 'a.ts', content: 'x' })] })
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))

    // Denial is the end of the turn, not another round-trip: nothing is asked of the model, and the
    // decision that was on screen is settled into a state that is not a refusal still to be explained.
    await waitFor(() => expect(screen.getByLabelText('denied')).toBeTruthy())
    expect(starts(stub).length).toBe(1)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()

    // And the turn ended through the one path every ending passes through: nothing still claims to be
    // in progress, and the composer is the user's again.
    expect(await screen.findByLabelText('Interrupted: Read the parser')).toBeTruthy()
    expect(composerPlaceholder()).toBe('Ask about this project… (@ to attach a file)')
  })

  it('keeps the card across a switch to another conversation and back, without writing the pause', async () => {
    const { stub, transcripts } = renderChat()
    const channel = await startRun(stub)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(
      stub,
      channel,
      pause({ callId: 'c1', args: { path: 'a.ts' }, calls: [call('c1', 'write_file', { path: 'a.ts', content: 'x' })] })
    )
    await screen.findByRole('button', { name: 'Approve' })

    await userEvent.click(screen.getByRole('button', { name: 'open the second conversation' }))

    // The pause belongs to the conversation it was asked in: the other one is not blocked by a decision
    // that is not about it.
    await waitFor(() => expect(composerPlaceholder()).toBe('Ask about this project… (@ to attach a file)'))

    // What leaving did to the disk, read here and asserted after the return: the card has to be proved
    // on the way back first, because the claim is that the two can now be true together.
    const pausedWritesWhileAway = pausedSaveCalls(stub)
    const fileWhileAway = transcripts.files[FIRST_ID]

    await userEvent.click(screen.getByRole('button', { name: 'open the first conversation' }))

    // Back in it, the decision is still the decision: the same card, and still actionable. The card is
    // here without the file having held it — the paused turn comes back from this process's own
    // memory of the conversation, which is what lets the write be gated without losing what the user
    // was looking at.
    const approve = await screen.findByRole('button', { name: 'Approve' })
    await userEvent.click(approve)
    await waitFor(() => expect(starts(stub).length).toBe(2))
    expect(starts(stub)[1].input.decision).toBe('approved')

    // Leaving a paused conversation must not write the card down: a file holding `awaiting` can only
    // ever be read back as a question nothing can answer. This is the half a save at the switch would
    // break, and it is the red this commit's product change is made against.
    expect(pausedWritesWhileAway).toHaveLength(0)
    expect(fileWhileAway).toBeUndefined()
  })

  it('writes nothing while the decision is open, and the settled turn once it is denied', async () => {
    // A conversation that already has a file: "unchanged" is a claim about bytes that exist, not
    // about a file that was never there.
    const stored: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'tidy the module', steps: [] },
        { id: 'assistant-2', role: 'assistant', content: 'Which module?', steps: [] },
      ],
    }
    const { stub, transcripts } = renderChat({ files: { [FIRST_ID]: stored } })
    await screen.findByText('Which module?')

    const asked = 'write the settled turn once'
    const channel = await startRun(stub, asked)
    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(
      stub,
      channel,
      pause({ callId: 'c1', args: { path: 'a.ts' }, calls: [call('c1', 'write_file', { path: 'a.ts', content: 'x' })] })
    )
    await screen.findByRole('button', { name: 'Approve' })

    // The post-turn debounce is deliberately not cancelled by the pause: it still fires, and it must
    // find nothing to write. The claim is about a payload that carries the pause — a file is never
    // given the awaiting step — and about the bytes on disk, which stay exactly the ones the
    // conversation opened with.
    await afterDebounce()
    expect(pausedSaveCalls(stub)).toHaveLength(0)
    expect(transcripts.files[FIRST_ID]).toEqual(stored)

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await afterDebounce()

    // An ending is worth writing: exactly one write carrying this send, and it holds no call waiting
    // on a person.
    const writes = saveCalls(stub).filter((call) => call.snapshot.turns.some((turn) => turn.content === asked))
    expect(writes).toHaveLength(1)
    expect(writes[0].id).toBe(FIRST_ID)
    const statuses = writes[0].snapshot.turns.flatMap((turn) => turn.steps.map((step) => step.status))
    expect(statuses).not.toContain('awaiting')
    expect(statuses).not.toContain('queued')
  })

  it('writes the paused turn once as interrupted when the window unloads', async () => {
    // A conversation that already has a file, so the ending is a write against bytes that exist rather
    // than the first file a session is ever given.
    const stored: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'tidy the module', steps: [] },
        { id: 'assistant-2', role: 'assistant', content: 'Which module?', steps: [] },
      ],
    }
    const { stub, transcripts } = renderChat({ files: { [FIRST_ID]: stored } })
    await screen.findByText('Which module?')

    const asked = 'quit while the question stands'
    const channel = await startRun(stub, asked)
    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(
      stub,
      channel,
      pause({ callId: 'c1', args: { path: 'a.ts' }, calls: [call('c1', 'write_file', { path: 'a.ts', content: 'x' })] })
    )
    await screen.findByRole('button', { name: 'Approve' })

    // Standing still is not an ending: the debounce fires and finds nothing it may write. Only the
    // deliberate exit below may turn the question into an ending.
    await afterDebounce()
    expect(pausedSaveCalls(stub)).toHaveLength(0)

    act(() => {
      window.dispatchEvent(new Event('beforeunload'))
    })

    // One write carrying this send, recorded as the named ending load would have given it: the call is
    // never decided under the lost-pause code, and the turn carries the same lost-pending notice — so a
    // reload shows an interrupted turn rather than one that was lost or one still waiting to be answered.
    await waitFor(() =>
      expect(saveCalls(stub).filter((call) => call.snapshot.turns.some((turn) => turn.content === asked))).toHaveLength(
        1
      )
    )
    const writes = saveCalls(stub).filter((call) => call.snapshot.turns.some((turn) => turn.content === asked))
    expect(writes[0].id).toBe(FIRST_ID)
    const statuses = writes[0].snapshot.turns.flatMap((turn) => turn.steps.map((step) => step.status))
    expect(statuses).not.toContain('awaiting')
    expect(statuses).not.toContain('queued')
    const lost = writes[0].snapshot.turns.flatMap((turn) => turn.steps).filter((step) => step.code === 'PAUSE_LOST')
    expect(lost).toHaveLength(1)
    expect(lost[0].status).toBe('interrupted')
    expect(writes[0].snapshot.turns.some((turn) => turn.endNotice?.lostPending === true)).toBe(true)

    // And the file the reload would read is that same ending, not the transcript as it stood before it.
    expect(transcripts.files[FIRST_ID]).toEqual(writes[0].snapshot)
  })

  it('writes the approved turn once, when the run it resumed comes to rest', async () => {
    const { stub, transcripts } = renderChat()
    const asked = 'approve the write once'
    const channel = await startRun(stub, asked)

    chunk(stub, channel, { type: 'tool_call_start', callId: 'c1', tool: 'write_file', args: { path: 'a.ts' } })
    chunk(
      stub,
      channel,
      pause({ callId: 'c1', args: { path: 'a.ts' }, calls: [call('c1', 'write_file', { path: 'a.ts', content: 'x' })] })
    )
    await screen.findByRole('button', { name: 'Approve' })

    // Let the pause's own debounce pass before the decision, so the only write left to see is the one
    // the settled turn earns rather than one the pause should have skipped.
    await afterDebounce()
    expect(pausedSaveCalls(stub)).toHaveLength(0)
    expect(transcripts.files[FIRST_ID]).toBeUndefined()

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(starts(stub).length).toBe(2))
    const resumed = await streamChannelFrom(stub, 1)

    chunk(stub, resumed, { type: 'tool_result', callId: 'c1', tool: 'write_file', ok: true, output: 'wrote a.ts' })
    chunk(stub, resumed, { type: 'turn_end', cause: 'model_stop' })
    chunk(stub, resumed, { type: 'done', reason: 'complete', steps: 1 })
    stub.emit(resumed, { type: 'end' })

    await afterDebounce()

    // The decision's save is the turn at rest: one call carrying this send, and the step it was
    // decided on is settled rather than still asking or still running.
    const writes = saveCalls(stub).filter((call) => call.snapshot.turns.some((turn) => turn.content === asked))
    expect(writes).toHaveLength(1)
    expect(writes[0].snapshot.turns.flatMap((turn) => turn.steps.map((step) => step.status))).toEqual(['ok'])
  })

  it('reconciles a pause the process outlived into a named state and a notice', async () => {
    const stored: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'tidy the module', steps: [] },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: '',
          steps: [
            { callId: 'c1', tool: 'write_file', args: { path: 'a.ts' }, status: 'awaiting' },
            { callId: 'c2', tool: 'run_command', args: { command: 'npm test' }, status: 'queued' },
          ],
        },
      ],
    }

    renderChat({ files: { [FIRST_ID]: stored } })

    // Neither of the two ways a zombie shows itself: no card offering a decision nothing can carry out,
    // and no silence about a turn that stopped.
    await waitFor(() =>
      expect(screen.getAllByText('Not decided — the app closed before you answered.')).toHaveLength(2)
    )
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(
      await screen.findByText('Ended while waiting for your approval — the app closed before you answered.')
    ).toBeTruthy()
    // History is not actionable, so the notice carries no Continue.
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})

/** The channel of the nth stream the pane started, read from the recorded start call. */
async function streamChannelFrom(stub: BridgeStub, index: number): Promise<string> {
  await waitFor(() => {
    if (starts(stub).length <= index) throw new Error(`stream ${index} has not started`)
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[index]
  return `conveyor:stream:${started?.method}`
}
