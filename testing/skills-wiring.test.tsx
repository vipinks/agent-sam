/**
 * The Skills control, as wiring rather than as rules.
 *
 * Every rule this exercises — where a SKILL.md may live, what its manifest may say, how many skills may
 * be active, how the Active Skills section is ordered — is tested directly in the node suites. What is
 * left here is the part a rule test cannot see: whether the composer asks the registered query, whether
 * a toggle reaches the session record, and whether the control is unavailable exactly when it must be.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payloads asserted below are
 * the payloads main would receive, not reconstructions of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { MAX_ACTIVE_SKILLS, type SkillListing } from '@/conveyor/protocol/skills'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window makes the virtualizer
 * render no rows at all. A send from the composer adds a turn to that list, so this suite has to state
 * the viewport the browser would have measured. It says nothing about layout: nothing here asserts on an
 * element's real pixels. Scoped to this file, and restored afterwards.
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
const STORE_CHANNEL = `conveyor:store:${CHAT_SESSIONS_STORE_ID}`
const STORE_CHANGED = `${STORE_CHANNEL}:changed`

/** A project skill and a user skill, which is the two scopes a picker has to show apart. */
const LISTING: SkillListing = {
  project: [
    {
      id: 'code-review',
      scope: 'project',
      title: 'Code Review',
      summary: 'Review a diff before it lands.',
      tags: [],
    },
  ],
  user: [
    {
      id: 'deploy-runbook',
      scope: 'user',
      title: 'Deploy Runbook',
      summary: 'Ship it, then watch the logs.',
      tags: [],
    },
  ],
  errors: [],
}

/** Three that fit under the cap, and one that does not, so the limit has something to refuse. */
const CROWDED: SkillListing = {
  project: [
    { id: 'a-skill', scope: 'project', title: 'Alpha Skill', summary: 'First.', tags: [] },
    { id: 'b-skill', scope: 'project', title: 'Beta Skill', summary: 'Second.', tags: [] },
    { id: 'c-skill', scope: 'project', title: 'Gamma Skill', summary: 'Third.', tags: [] },
  ],
  user: [{ id: 'd-skill', scope: 'user', title: 'Delta Skill', summary: 'Fourth.', tags: [] }],
  errors: [],
}

/** The session list main holds, with the conversation open unless a test says otherwise. */
function sessionState(options: { activeSkillIds?: string[]; open?: boolean } = {}) {
  return {
    sessions: [
      {
        id: SESSION_ID,
        title: 'an existing conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        ...(options.activeSkillIds ? { activeSkillIds: options.activeSkillIds } : {}),
      },
    ],
    activeSessionId: options.open === false ? null : SESSION_ID,
  }
}

/** Install a stub whose `skills.list` answers with what main would have scanned, and render the pane. */
async function renderChat(options: { listing?: SkillListing; state?: unknown } = {}) {
  const stub = createBridgeStub({
    list: () => options.listing ?? LISTING,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    chatWithTools: () => undefined,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, options.state ?? sessionState())
  // `stubStore` pushes its state on a later tick, and this file seeds the same store more than once:
  // the mirror is module-scoped, so without waiting here the pane's first render would read whatever
  // the previous test left in it and could settle on a conversation this test did not seed. One tick
  // is enough — the push was queued first — and it makes every test in the file start from its own
  // state rather than from the last one's.
  await Promise.resolve()

  // `stubStore` answers the store's own channel itself, so a dispatch on that channel is consumed by
  // the seed and never reaches the stub's call record. The forwarder below sees the same `{ payload }`
  // envelope conveyor sends in production, so what it reports is the payload main would have received
  // rather than a reconstruction of it.
  const dispatches: Array<{ method: string; payload: unknown }> = []
  const invoke = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === STORE_CHANNEL) {
      dispatches.push({ method, payload: (args[0] as { payload?: unknown } | undefined)?.payload })
    }
    return invoke(channel, method, ...args)
  }

  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return {
    view,
    stub,
    /** What the pane asked the session store to do, by action name. */
    storePayloads: (method: string) => dispatches.filter((d) => d.method === method).map((d) => d.payload),
  }
}

/** The composer's Skills control. Named by its own label, which carries the count when it has one. */
function skillControl(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Skills/ }) as HTMLButtonElement
}

/** Open the picker and wait for the rows main's answer produces. */
async function openPicker(): Promise<void> {
  await userEvent.click(skillControl())
  await screen.findByRole('button', { name: /Code Review/ })
}

/** One skill's row, by the title it shows. */
async function skillRow(name: RegExp): Promise<HTMLButtonElement> {
  return (await screen.findByRole('button', { name })) as HTMLButtonElement
}

/** The chip that removes a skill, which is the chip itself as far as the user is concerned. */
function removeControl(id: string): HTMLButtonElement {
  return screen.getByRole('button', { name: `Remove skill ${id}` }) as HTMLButtonElement
}

/** The channel the run's chunks arrive on, read from the recorded start rather than guessed. */
async function streamChannel(stub: BridgeStub): Promise<string> {
  await waitFor(() => {
    if (!stub.calls.some((call) => call.channel === 'conveyor:stream:start')) throw new Error('no stream started')
  })
  const started = stub.calls.find((call) => call.channel === 'conveyor:stream:start')
  return `conveyor:stream:${started?.method}`
}

/** Send one message, so the pane has a turn in flight. */
async function startRun(stub: BridgeStub): Promise<string> {
  await userEvent.type(await screen.findByLabelText('Message'), 'get started{Enter}')
  return streamChannel(stub)
}

/** A pause as main sends one: the decision the run is waiting on. */
function pause(): Record<string, unknown> {
  return {
    type: 'awaiting_approval',
    callId: 'c1',
    tool: 'write_file',
    args: { path: 'a.ts' },
    messages: [],
    steps: 1,
    plan: [],
    calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.ts"}' } }],
  }
}

// ---------------------------------------------------------------- the cases

describe('the composer skills control', () => {
  it('opens the picker and shows the project and user skills the registered query returned', async () => {
    const { stub } = await renderChat()

    await openPicker()

    expect(screen.getByText('Project')).toBeTruthy()
    expect(screen.getByText('User')).toBeTruthy()
    expect(screen.getByText('Code Review')).toBeTruthy()
    expect(screen.getByText('Deploy Runbook')).toBeTruthy()
    // And they came from the query main registered, not from anything the renderer read itself.
    expect(stub.methodsOn('skills')).toContain('list')
  })

  it('shows a per-file load error beside the skills that did load', async () => {
    await renderChat({
      listing: {
        ...LISTING,
        errors: [
          {
            id: 'broken',
            scope: 'project' as const,
            code: 'SKILL_MANIFEST_INVALID' as const,
            message: 'The manifest is not valid JSON.',
          },
        ],
      },
    })

    await openPicker()

    expect(await screen.findByText('Load errors')).toBeTruthy()
    const row = screen.getByText('broken').closest('div') as HTMLElement
    expect(within(row).getByText(/SKILL_MANIFEST_INVALID/)).toBeTruthy()
    // Non-destructive: the skills that parsed are still there, and still offerable.
    expect(await skillRow(/Code Review/)).toBeTruthy()
  })

  it('writes a toggle onto the conversation the user is in', async () => {
    const { storePayloads } = await renderChat()
    await openPicker()

    await userEvent.click(await skillRow(/Code Review/))

    await waitFor(() => expect(storePayloads('touchSession').length).toBe(1))
    expect(storePayloads('touchSession')[0]).toEqual({ id: SESSION_ID, activeSkillIds: ['code-review'] })
  })

  it('renders what is already active as chips and removes one through its own control', async () => {
    const { storePayloads } = await renderChat({ state: sessionState({ activeSkillIds: ['code-review'] }) })

    expect(await screen.findByText('Code Review')).toBeTruthy()

    await userEvent.click(removeControl('code-review'))

    await waitFor(() => expect(storePayloads('touchSession').length).toBe(1))
    expect(storePayloads('touchSession')[0]).toEqual({ id: SESSION_ID, activeSkillIds: [] })
  })

  it('keeps the active skills across a keyed remount', async () => {
    const { view, stub, storePayloads } = await renderChat()
    await openPicker()
    await userEvent.click(await skillRow(/Code Review/))
    await waitFor(() => expect(storePayloads('touchSession').length).toBe(1))

    // Main applies the action and broadcasts what it stored, which is the only thing that moves the
    // mirror; the pane is read against that state and not against its own optimism.
    stub.pushToChannel(STORE_CHANGED, sessionState({ activeSkillIds: ['code-review'] }))
    expect(await screen.findByRole('button', { name: 'Remove skill code-review' })).toBeTruthy()

    view.unmount()
    await renderChat({ state: sessionState({ activeSkillIds: ['code-review'] }) })

    // A remount is the workbench keying its panes on the window state: the chips are back because the
    // choice lives on the record, not in the component that drew them.
    expect(await screen.findByRole('button', { name: 'Remove skill code-review' })).toBeTruthy()
  })

  it('disables the control while a run is in flight', async () => {
    const { stub } = await renderChat()

    await startRun(stub)

    await waitFor(() => expect(skillControl().disabled).toBe(true))
  })

  it('disables the control while a decision is pending, after the stream itself has ended', async () => {
    const { stub } = await renderChat()
    const channel = await startRun(stub)

    stub.emit(channel, { type: 'data', value: pause() })

    // The pause ends the stream — the decision starts a new one — so what keeps the control shut here
    // is the pending decision and nothing else.
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Approve' }).length).toBe(1))
    expect(skillControl().disabled).toBe(true)
  })

  it('disables the skills that do not fit under the cap', async () => {
    await renderChat({
      listing: CROWDED,
      state: sessionState({ activeSkillIds: ['a-skill', 'b-skill', 'c-skill'] }),
    })

    await userEvent.click(skillControl())
    const row = await skillRow(/Delta Skill/)

    expect(MAX_ACTIVE_SKILLS).toBe(3)
    expect(row.disabled).toBe(true)
    expect(screen.getByText(/of 3 active/)).toBeTruthy()
  })

  it('carries a choice made on the home screen onto the conversation the first message creates', async () => {
    // The home screen with nothing in it, which is what a window that has never sent a message is. A
    // seed with a conversation in it would not be home: the pane restores the newest one and the
    // toggle would write to that record instead of waiting for the one the message creates.
    const { storePayloads } = await renderChat({ state: { sessions: [], activeSessionId: null } })
    await openPicker()

    await userEvent.click(await skillRow(/Code Review/))

    // Nothing is created by the toggle: the home screen is not a conversation, so there is no record to
    // write to yet — the choice is held by the composer and lands with the message.
    expect(storePayloads('addSession').length).toBe(0)
    expect(removeControl('code-review')).toBeTruthy()

    await userEvent.type(await screen.findByLabelText('Message'), 'get started{Enter}')

    await waitFor(() => expect(storePayloads('addSession').length).toBe(1))
    expect(storePayloads('addSession')[0]).toMatchObject({ activeSkillIds: ['code-review'] })
  })
})
