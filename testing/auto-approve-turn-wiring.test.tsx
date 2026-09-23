import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider, useChatSessionsContext } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { RESUME_MESSAGE } from '@/conveyor/protocol/turn-end'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The consent setting, across everything a turn writes.
 *
 * `auto-approve-rules.test.ts` owns the record's own rule and `auto-approve-session-wiring.test.tsx`
 * owns the toggle, the switch and the launch. What neither of them can show is the defect this file
 * pins: the setting did not survive a *turn*. A run rewrites the transcript on every chunk and at every
 * ending, and the write it used replaced the whole record — so the consent flag, which the run had
 * never touched, went with it. The toggle then read off again on the very next render, and the file was
 * saved without the key, which the next read resolves to off. The user's choice was gone before they
 * could see why.
 *
 * So each test below drives one of the ways a turn writes — a completed turn, a Continue, a regenerate,
 * an edit-and-resend — and makes the same two claims about each: the toggle still reads what the user
 * set, and the *next* run goes out with that value. The second claim is the load-bearing one. Main gates
 * a tool call on `needsApproval(call) && !input.autoApprove`, so the payload is the whole difference
 * between a run that asks and a run that does not, and a pane that rendered a toggle reading on while
 * sending `false` would be a lie rendered in the one place the user is looking.
 *
 * The transport is the real conveyor client over a stubbed bridge, so a run is driven by the chunks main
 * would send rather than by a prop drilled into a component.
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

const FIRST_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222'

const QUESTION = 'delete the build folder'
const REPLY = 'Removing it now.'

const SESSION_STATE = {
  sessions: [FIRST_ID, SECOND_ID].map((id, index) => ({
    id,
    title: id === FIRST_ID ? 'the first conversation' : 'the second conversation',
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    providerId: 'deepseek',
    model: 'deepseek-chat',
  })),
  activeSessionId: FIRST_ID,
}

/** A conversation that already has a question in it, which is what makes it worth saving at all. */
function asked(): TranscriptTurn[] {
  return [{ id: 'user-1', role: 'user', content: QUESTION, steps: [] }]
}

/** The same, with a reply after it — the shape a regenerate needs a target in. */
function answered(): TranscriptTurn[] {
  return [...asked(), { id: 'assistant-2', role: 'assistant', content: REPLY, steps: [] }]
}

/**
 * A reply with turns after it.
 *
 * Needed because the dialog is the point: a regenerate that would cut nothing runs straight away, and
 * the cut is one of the writes this file exists to hold to account.
 */
function answeredWithMore(): TranscriptTurn[] {
  return [
    ...answered(),
    { id: 'user-3', role: 'user', content: 'now the other one', steps: [] },
    { id: 'assistant-4', role: 'assistant', content: 'Done.', steps: [] },
  ]
}

function snapshot(turns: TranscriptTurn[], autoApprove?: boolean): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns,
    ...(autoApprove === true ? { autoApprove: true } : {}),
  }
}

/** The transcript files, held in memory and read back exactly as written. */
function transcriptFiles(initial: Record<string, TranscriptSnapshot>) {
  const files: Record<string, TranscriptSnapshot> = { ...initial }
  return {
    files,
    load: (input: unknown) => files[(input as { id: string }).id] ?? null,
    save: (input: unknown) => {
      const { id, snapshot: written } = input as { id: string; snapshot: TranscriptSnapshot }
      files[id] = written
      return undefined
    },
  }
}

/**
 * The switch between two conversations, in the open.
 *
 * These call the same `openSession` the workbench hands to the session list's `onOpen`, which is what
 * makes the switch here a switch through the real save-then-load path rather than a store write.
 */
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

/** The panel over a stored conversation, with every run's payload recorded as it goes out. */
function renderChat(options: { files?: Record<string, TranscriptSnapshot> } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const transcripts = transcriptFiles(options.files ?? {})
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
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
        <SessionSwitch />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { ...view, stub, sent, transcripts }
}

/** The header's toggle, as the state it reports. */
function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'Auto-approve tool actions' })
}

function isOn(): boolean {
  return toggle().getAttribute('aria-checked') === 'true'
}

/** The channel main's chunks arrive on, read from the recorded start call rather than guessed. */
async function streamChannel(stub: BridgeStub, index = 0): Promise<string> {
  await waitFor(() => {
    const starts = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')
    if (starts.length <= index) throw new Error(`no stream started at ${index}`)
  })
  const started = stub.calls.filter((call) => call.channel === 'conveyor:stream:start')[index]
  return `conveyor:stream:${started?.method}`
}

function chunk(stub: BridgeStub, channel: string, value: unknown): void {
  stub.emit(channel, { type: 'data', value })
}

/** Send one message from the composer and return the channel that run's chunks arrive on. */
async function say(stub: BridgeStub, text: string, index = 0): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), `${text}{Enter}`)
  return streamChannel(stub, index)
}

/** End a run the ordinary way: the model finished, and the stream closed. */
async function finishRun(stub: BridgeStub, channel: string, reply = REPLY): Promise<void> {
  chunk(stub, channel, { type: 'text_delta', text: reply })
  chunk(stub, channel, { type: 'turn_end', cause: 'model_stop' })
  stub.emit(channel, { type: 'end' })
  // Waited on rather than assumed: the ending is applied in the loop's own continuation, and every
  // assertion below is about the state the pane is left in rather than the state the stream left it in.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy())
}

describe('the consent setting across a turn', () => {
  it('still reads on after a completed turn, and the next run goes out ungated', async () => {
    const { stub, sent, transcripts } = renderChat({ files: { [FIRST_ID]: snapshot(asked(), true) } })

    await waitFor(() => expect(isOn()).toBe(true))

    const first = await say(stub, 'go ahead')
    await waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]?.autoApprove).toBe(true)
    await finishRun(stub, first)

    // The turn is over and the setting is still what the user left it as. Before the fix this read off,
    // because the run's own write to the transcript had replaced the record the toggle reads from.
    expect(isOn()).toBe(true)
    expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true)

    // And the next run is sent with it, which is what actually keeps the tool calls ungated: main gates
    // a call on this field, so a pane rendering "on" while sending false is a toggle that lies.
    await say(stub, 'and again')
    await waitFor(() => expect(sent.length).toBe(2))
    expect(sent[1]?.autoApprove).toBe(true)
    await finishRun(stub, await streamChannel(stub, 1))
  })

  it('still reads on after a Continue, and the resumed message goes out with it', async () => {
    const { stub, sent, transcripts } = renderChat({ files: { [FIRST_ID]: snapshot(asked(), true) } })

    await waitFor(() => expect(isOn()).toBe(true))

    const first = await say(stub, 'go ahead')
    // A reply the provider cut off: the turn can be picked up, so the card offers the click.
    chunk(stub, first, { type: 'text_delta', text: 'Halfway through' })
    chunk(stub, first, { type: 'turn_end_notice', cause: 'truncated', resumable: true })
    stub.emit(first, { type: 'end' })

    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))

    // Continue is an ordinary send, so it is an ordinary payload — and the same field decides whether
    // the run it starts asks for permission.
    await waitFor(() => expect(sent.length).toBe(2))
    const payload = sent[1] as { messages: { role: string; content: string }[]; autoApprove?: boolean }
    expect(payload.messages[payload.messages.length - 1]?.content).toBe(RESUME_MESSAGE)
    expect(payload.autoApprove).toBe(true)
    expect(isOn()).toBe(true)

    await finishRun(stub, await streamChannel(stub, 1))
    expect(isOn()).toBe(true)
    expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true)
  })

  it('still reads on after a regenerate, and the reply’s run goes out with it', async () => {
    const { stub, sent, transcripts } = renderChat({ files: { [FIRST_ID]: snapshot(answeredWithMore(), true) } })

    await waitFor(() => expect(isOn()).toBe(true))
    // The first reply, so the cut it asks about is a real one. Two replies are on screen, so this picks
    // the earlier one rather than letting the role query be ambiguous.
    const regenerate = (await screen.findAllByRole('button', { name: 'Regenerate reply' }))[0]
    await userEvent.click(regenerate!)
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Regenerate' }))

    // The run that answers the message again carries the setting, and the cut that preceded it did not
    // take the record's flag with it.
    await waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]?.autoApprove).toBe(true)
    expect(isOn()).toBe(true)
    // The cut wrote a record on its way past, so the file is read here as well as after the run: that
    // write is the one that used to arrive without the key.
    expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true)

    await finishRun(stub, await streamChannel(stub))
    expect(isOn()).toBe(true)
    expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true)
  })

  it('still reads on after an edit-and-resend, and the edited message goes out with it', async () => {
    const { stub, sent, transcripts } = renderChat({ files: { [FIRST_ID]: snapshot(answered(), true) } })

    await waitFor(() => expect(isOn()).toBe(true))

    await userEvent.click(await screen.findByRole('button', { name: 'Edit message' }))
    const field = (await screen.findByLabelText('Edit message text')) as HTMLTextAreaElement
    await userEvent.clear(field)
    await userEvent.type(field, 'delete the dist folder instead')
    await userEvent.click(screen.getByRole('button', { name: 'Save and resend' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Resend' }))

    // The resend runs through the ordinary send path, and the cut it made before sending is the thing
    // that used to leave the record carrying turns and no flag.
    await waitFor(() => expect(sent.length).toBe(1))
    const payload = sent[0] as { messages: { role: string; content: string }[]; autoApprove?: boolean }
    expect(payload.messages[payload.messages.length - 1]?.content).toBe('delete the dist folder instead')
    expect(payload.autoApprove).toBe(true)
    expect(isOn()).toBe(true)

    await finishRun(stub, await streamChannel(stub))
    expect(isOn()).toBe(true)
    expect(transcripts.files[FIRST_ID]?.autoApprove).toBe(true)
  })

  it('keeps each conversation on its own value across a switch, after a turn', async () => {
    const { stub } = renderChat({ files: { [FIRST_ID]: snapshot(asked(), true) } })

    await waitFor(() => expect(isOn()).toBe(true))
    await finishRun(stub, await say(stub, 'go ahead'))

    // A turn later, the switch still carries each conversation's own setting: the one that was left on
    // is on, and the one with no record at all is off.
    await userEvent.click(screen.getByRole('button', { name: 'open the second conversation' }))
    await waitFor(() => expect(isOn()).toBe(false))

    await userEvent.click(screen.getByRole('button', { name: 'open the first conversation' }))
    await waitFor(() => expect(isOn()).toBe(true))
  })

  it('reopens with the toggle on at launch, from the file the app itself wrote', async () => {
    const first = renderChat({ files: { [FIRST_ID]: snapshot(asked()) } })

    await waitFor(() => expect(isOn()).toBe(false))
    await userEvent.click(toggle())
    await waitFor(() => expect(first.transcripts.files[FIRST_ID]?.autoApprove).toBe(true))

    // A relaunch: the record the app's own save produced, read by a fresh pane. Nothing about the
    // setting is supplied by this test in memory — the second pane has only what was written.
    const writtenByTheApp = { ...first.transcripts.files }
    first.unmount()
    renderChat({ files: writtenByTheApp })

    await waitFor(() => expect(isOn()).toBe(true))
  })
})
