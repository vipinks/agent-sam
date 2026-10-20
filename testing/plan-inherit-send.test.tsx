import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import type { PlanStep } from '@/conveyor/protocol/plan'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The plan a send carries, which is the half of the plan-unfinished card that crosses the boundary.
 *
 * The card is emitted by main, and main can only count the work it knows about: a run opens with an
 * empty plan of its own, so a send that does not hand the conversation's plan over opens a turn that
 * believes there is nothing left to do. The pane meanwhile draws the checklist from the transcript, so
 * the two disagree exactly where the user is looking — the checklist shows two steps left, and the turn
 * that stops reports none.
 *
 * The shape under test is the ordinary one after a model quits mid-plan: the plan belongs to the turn
 * above, and the send that picks the work back up declares nothing of its own. So the payload is the
 * only route it has to main, and this file asserts the route rather than the wording.
 *
 * The transport is the real conveyor client over a stubbed bridge, so what is read here is the envelope
 * a real send would have produced rather than a prop drilled into a component.
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

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** A plan with work still on it: one step done, one interrupted by the turn that stopped, one to come. */
const PLAN: PlanStep[] = [
  { id: 'read', text: 'Read the parser', status: 'done' },
  { id: 'edit', text: 'Change the precedence table', status: 'interrupted' },
  { id: 'tests', text: 'Add tests for it', status: 'pending' },
]

const SESSION_STATE = {
  sessions: [
    {
      id: SESSION_ID,
      title: 'the plan mid-way',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      providerId: 'deepseek',
      model: 'deepseek-chat',
    },
  ],
  activeSessionId: SESSION_ID,
}

/** The conversation a nudge arrives into: a question, the reply that declared the plan, and it. */
function stoppedMidPlan(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'user-1', role: 'user', content: 'refactor the parser', steps: [] },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'I have started on the precedence table.',
        steps: [],
        plan: PLAN,
      },
    ],
  }
}

function transcriptFiles(initial: Record<string, TranscriptSnapshot>) {
  const files: Record<string, TranscriptSnapshot> = { ...initial }
  return {
    load: (input: unknown) => files[(input as { id: string }).id] ?? null,
    save: (input: unknown) => {
      const { id, snapshot: written } = input as { id: string; snapshot: TranscriptSnapshot }
      files[id] = written
      return undefined
    },
  }
}

/** The panel over the stopped conversation, with every run's payload recorded as it goes out. */
function renderChat() {
  const sent: Array<Record<string, unknown>> = []
  const transcripts = transcriptFiles({ [SESSION_ID]: stoppedMidPlan() })
  const stub = createBridgeStub({
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: transcripts.load,
    saveTranscript: transcripts.save,
    chatWithTools: (input) => void sent.push(input as Record<string, unknown>),
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

  return { stub, sent }
}

/** Send one message from the composer and leave the run open, so its payload can be read. */
async function say(stub: ReturnType<typeof createBridgeStub>, text: string): Promise<void> {
  await userEvent.type(await screen.findByLabelText('Message'), `${text}{Enter}`)
  // The stream's start call is recorded against the channel the run's chunks arrive on, and its
  // closing frame is what leaves the pane with no run in flight for the next assertion.
  await waitFor(() => {
    const starts = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (starts.length === 0) throw new Error('no stream started')
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[0]
  stub.emit(`conveyor:stream:${started?.method}`, { type: 'end' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy())
}

describe('the plan a send carries', () => {
  it('hands main the plan the conversation still has work on', async () => {
    const { stub, sent } = renderChat()

    await say(stub, 'continue')

    await waitFor(() => expect(sent.length).toBe(1))
    // The plan the checklist is drawing, key for key: a send that drops it is a run that starts from an
    // empty plan, and a turn that stops again from there has nothing to report.
    expect(sent[0]?.plan).toEqual(PLAN)
  })
})
