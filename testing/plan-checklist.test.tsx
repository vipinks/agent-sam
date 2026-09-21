import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The plan checklist, as wiring rather than as rules.
 *
 * Every rule the checklist relies on — how an update merges, what a turn end does to a step still in
 * progress — is tested directly in `plan-rules.test.ts` and through the loop in the node plan suite.
 * What is left here is the part a rule test cannot see: whether a live chunk reaches the checklist,
 * whether the row the user is looking at is updated rather than replaced, and whether a session with
 * no plan renders anything at all.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the chunks below are delivered
 * the way main delivers them.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` measures the scroll element's own `offsetWidth`/`offsetHeight`, and jsdom
 * implements no layout, so both read as 0 — and a zero-height window makes the virtualizer render no
 * rows at all, because its range calculation bails on `outerSize === 0`. The first test below asserts
 * that a turn with no plan renders the answer and nothing for the plan, and that answer lives in the
 * transcript; without this it would be asserting against an empty list.
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
  // Deleted rather than redefined, so jsdom's own accessor is what any later reader sees.
  delete proto.offsetWidth
  delete proto.offsetHeight
})

/**
 * The session store's seeded state: one session, already open.
 *
 * Named deliberately, because the first-send path only titles an untitled session — this suite is
 * about the checklist, not about the title.
 */
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

function stubChat(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({ chatWithTools: () => undefined, ...overrides })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  setActiveStub(stub)
  return stub
}

function renderChat() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Message')) as HTMLTextAreaElement
}

/**
 * The stream main would push chunks down.
 *
 * Read from the recorded start call rather than invented: the id is `<module>.<method>#<uuid>`, and a
 * test that guessed it would be testing its own guess instead of the transport.
 */
async function streamChannel(stub: BridgeStub): Promise<string> {
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

/** Send a message and hand back the channel main's reply would arrive on. */
async function startRun(stub: BridgeStub): Promise<string> {
  renderChat()
  await userEvent.type(await composer(), 'refactor the parser{Enter}')
  return streamChannel(stub)
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

describe('the plan checklist', () => {
  it('renders nothing at all for a session with no plan', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    // A turn that declared no plan, ended as a normal stream ends.
    chunk(stub, channel, { type: 'text_delta', text: 'No plan needed.' })
    chunk(stub, channel, { type: 'done', reason: 'complete' })
    stub.emit(channel, { type: 'end' })

    // Absence is the degraded state: no checklist, no placeholder, no warning about the missing plan.
    expect(await screen.findByText('No plan needed.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull()
  })

  it('renders each step with the status the model gave it', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, {
      type: 'plan',
      plan: [
        { id: 'read', text: 'Read the parser', status: 'pending' },
        { id: 'write', text: 'Write the tests', status: 'in_progress' },
        { id: 'run', text: 'Run the suite', status: 'done' },
      ],
    })

    // Each row names its own status, so the marker is never the only thing carrying it.
    expect(await screen.findByLabelText('Pending: Read the parser')).toBeTruthy()
    expect(screen.getByLabelText('In progress: Write the tests')).toBeTruthy()
    expect(screen.getByLabelText('Done: Run the suite')).toBeTruthy()
  })

  it('updates the row a second plan chunk changes, in place', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, {
      type: 'plan',
      plan: [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'write', text: 'Write the tests', status: 'in_progress' },
      ],
    })

    // The same row element is the one that must change: a list that re-created its rows on every
    // chunk would look identical in a screenshot and lose focus and scroll position in the app.
    const row = await screen.findByLabelText('In progress: Write the tests')

    chunk(stub, channel, {
      type: 'plan',
      // The whole plan, merged, exactly as main sends it: the reducer records rather than merges, so a
      // chunk carrying only what changed would be asserting a message the loop never emits. The
      // merging itself is covered by the rule tests and the node plan suite.
      plan: [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'write', text: 'Write the tests', status: 'done' },
        { id: 'run', text: 'Run the suite', status: 'pending' },
      ],
    })

    await waitFor(() => expect(row.getAttribute('aria-label')).toBe('Done: Write the tests'))
    // The text was never sent again, and it is still there: the update matched the id, not the row.
    expect(row.textContent).toContain('Write the tests')
    // And the step added behind it is a new row, in order.
    expect(screen.getByLabelText('Pending: Run the suite')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Done: Read the parser',
      'Done: Write the tests',
      'Pending: Run the suite',
    ])
  })

  it('marks a step still in progress as interrupted when the turn ends', async () => {
    const stub = stubChat()
    const channel = await startRun(stub)

    chunk(stub, channel, {
      type: 'plan',
      plan: [
        { id: 'read', text: 'Read the parser', status: 'done' },
        { id: 'write', text: 'Write the tests', status: 'in_progress' },
      ],
    })
    await screen.findByLabelText('In progress: Write the tests')

    // The stream ends, as it does when the model is done or the run is stopped. Nothing can still be
    // running, so the plan must not say that it is.
    stub.emit(channel, { type: 'end' })

    expect(await screen.findByLabelText('Interrupted: Write the tests')).toBeTruthy()
    expect(screen.getByLabelText('Done: Read the parser')).toBeTruthy()
  })

  it('shows the plan a reopened session stored', async () => {
    const snapshot: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
        {
          id: 'assistant-2',
          role: 'assistant',
          content: 'Two of three done.',
          steps: [],
          // The plan as it was frozen when its turn ended: the step left mid-flight is recorded as
          // interrupted, so a reopened session makes no claim about work that stopped.
          plan: [
            { id: 'read', text: 'Read the parser', status: 'done' },
            { id: 'write', text: 'Write the tests', status: 'interrupted' },
            { id: 'run', text: 'Run the suite', status: 'pending' },
          ],
        },
      ],
    }

    stubChat({ loadTranscript: () => snapshot })
    renderChat()

    expect(await screen.findByLabelText('Done: Read the parser')).toBeTruthy()
    expect(screen.getByLabelText('Interrupted: Write the tests')).toBeTruthy()
    expect(screen.getByLabelText('Pending: Run the suite')).toBeTruthy()
  })
})
