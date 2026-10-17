import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import type { ContextSnapshot } from '@/conveyor/protocol/context-window'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Automatic compaction, as wiring rather than as rules.
 *
 * The cut point and the summary's fallback are `tests/ui/compaction-test.ts`'s, and the meter's strings
 * are `tests/llm/context-card-test.ts`'s. What only the pane can get wrong is the moment: a send that
 * leaves the conversation past its compact point has to fold the older turns once the reply has landed,
 * the summary that fold writes has to be the Sam loop's own words rather than the connection's fallback,
 * and the transcript the user is reading has to gain a seam without losing a turn.
 *
 * The transport is the real conveyor client over a stubbed bridge, so both streams are driven the way a
 * run delivers them: the reply first, then the summary the compaction asks for.
 */

const SESSION_ID = 'cccccccc-3333-4333-8333-333333333333'

/** A viewport for the virtualized transcript, which jsdom does not have. */
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

/**
 * What the conversation had spent before this send: 50 000 of `deepseek-chat`'s 64 000-token window is
 * past the launch compact point of 70 percent (44 800), which is the state the trigger is about.
 */
const SPENT: ContextSnapshot = {
  tools: 0,
  systemPrompt: 0,
  projectInstructions: 0,
  skills: 0,
  messages: 50_000,
  other: 0,
  used: 50_000,
  at: 1_700_000_000_000,
}

/** Five turns already on disk: question, answer, question, answer, question. */
function saved(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: ['user', 'assistant', 'user', 'assistant', 'user'].map((role, index) => ({
      id: `${role}-${index}`,
      role: role as 'user' | 'assistant',
      content: `${role} ${index}`,
      steps: [],
    })),
  }
}

/** The Sam loop's answer to the summary request, written as the model would write it. */
const SAM_SUMMARY = 'The user compared two parsers and settled on the second.'

/** One send's worth of transport: the reply stream and the summary stream the compaction opens. */
function stubSession(): { stub: BridgeStub; saves: TranscriptSnapshot[] } {
  const saves: TranscriptSnapshot[] = []
  const stub = createBridgeStub({
    chatWithTools: () => undefined,
    loadTranscript: () => saved(),
    saveTranscript: (input) => {
      const request = input as { snapshot?: TranscriptSnapshot } | undefined
      if (request?.snapshot) saves.push(request.snapshot)
      return undefined
    },
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: SESSION_ID,
        title: 'a conversation that has grown',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        contextSnapshot: SPENT,
      },
    ],
    activeSessionId: SESSION_ID,
  })
  setActiveStub(stub)
  return { stub, saves }
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

/** The channel one stream's chunks arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub, index: number): Promise<string> {
  await waitFor(() => {
    const starts = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (starts.length <= index) throw new Error(`stream ${index} has not started`)
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[index]
  return `conveyor:stream:${started?.method}`
}

/** The seam row at the head of a compacted conversation. */
function seam(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-slot="summary-seam"]')
  if (!found) throw new Error('no summary seam in the transcript')
  return found
}

describe('automatic compaction after a send', () => {
  it('folds the older turns with the Sam loop’s summary once the reply lands', async () => {
    const { stub, saves } = stubSession()
    const { container } = renderChat()

    const composer = (await screen.findByLabelText('Message')) as HTMLTextAreaElement
    // The transcript has to be on screen before the send, or the run would be handed the empty one the
    // mount starts from and the range below would be measured against the wrong conversation.
    await waitFor(() => expect(screen.getByText('user 0')).toBeTruthy())
    await userEvent.type(composer, 'and what about the third parser?{Enter}')

    // The reply stream: the answer lands, and the run ends.
    const reply = await streamChannel(stub, 0)
    stub.emit(reply, { type: 'data', value: { type: 'text_delta', text: 'The third parser is slower.' } })
    stub.emit(reply, { type: 'end' })

    // The summary the compaction asks the Sam loop for, and its answer.
    const summary = await streamChannel(stub, 1)
    stub.emit(summary, { type: 'data', value: SAM_SUMMARY })
    stub.emit(summary, { type: 'end' })

    // Six turns are folded — every turn the send left behind the new question — and the conversation
    // is added to, never cut: the seam is the head and the turns it stands for are still in the file.
    await waitFor(() => expect(seam(container).textContent).toContain('Turns 1 through 6 summarized'))

    // The summary is the loop's own words, not the connection that concatenates user messages.
    await waitFor(() => expect(saves.length).toBeGreaterThan(0), { timeout: 3000 })
    const written = saves[saves.length - 1]
    expect(written.turns[0].content).toBe(SAM_SUMMARY)
    expect(written.turns[0].content).not.toContain('Summary of turns')
    expect(written.turns[0].summarizesTurns).toHaveLength(6)
    expect(written.turns).toHaveLength(8)
  })
})
