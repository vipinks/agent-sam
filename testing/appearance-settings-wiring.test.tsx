/**
 * The Appearance section, and the chat pane it draws, as wiring.
 *
 * Two claims are made here and neither is visible from a rule test. The first is the section: that it is
 * a section of the shell at all — in the row, reachable by deep link — and that both controls offer every
 * option the protocol declares, start on the defaults, and reach the store main owns. The second is the
 * application: that the pane draws what the store says, with the user's bubble on the right under split
 * and on the left under same side, and the message body carrying the selected preset's own size class on
 * the agent's body and the user's alike.
 *
 * Main is simulated rather than faked, in the shape the Buddies suite established: `fakeMain` holds the
 * store's state, applies each action through the store's own reducer and pushes the result down the
 * changed channel. A change made in Settings therefore reaches the chat pane the way it reaches it in the
 * app — through main — and a test can assert both what was asked for and what the pane does once main has
 * answered.
 *
 * The defaults are asserted as the classes the pane draws today: `justify-end` for the user's row,
 * `justify-start` for the agent's, and `text-[13px]` on both message bodies. Those three literals are the
 * whole of this phase's backward-compatibility promise, and they are spelled as literals here on purpose.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 and a zero-height window renders no rows at all. The
 * viewport the browser would have measured is stated here and restored afterwards.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says a 15px body reads well against a 17px one,
 * or that the two bubbles sit where an eye expects under same side: the acceptance is Boss's eyes on both
 * alignments and all four presets, in both themes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot, type TranscriptTurn } from '@/conveyor/protocol/transcript'
import { FONT_PRESET_IDS, FONT_PRESETS, type BubbleAlignment, type FontPresetId } from '@/conveyor/protocol/appearance'
import { appearancePreferencesStore, type AppearancePreferencesState } from '@/conveyor/stores/appearance-preferences'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

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

/** The store's id, as `defineStore('appearance-preferences', ...)` declares it. */
const APPEARANCE_STORE_ID = 'appearance-preferences'

/** The state a launch starts from, read off the definition rather than written out here. */
const INITIAL_STATE = structuredClone(
  (appearancePreferencesStore as unknown as { initialState: AppearancePreferencesState }).initialState
)

/** The two classes the message row has always chosen between, and the body's size. */
const USER_ROW_CLASS = 'justify-end'
const AGENT_ROW_CLASS = 'justify-start'
const TODAYS_BODY_CLASS = 'text-[13px]'

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

const QUESTION = 'set up the parser'
const ANSWER = 'Set up.'

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

function snapshot(turns: TranscriptTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, interrupted: false, turns }
}

function transcriptTurns(): TranscriptTurn[] {
  return [
    { id: 'user-1', role: 'user', content: QUESTION, steps: [] },
    { id: 'assistant-2', role: 'assistant', content: ANSWER, steps: [] },
  ]
}

/**
 * Main's half of the appearance store.
 *
 * The reducer is the definition's own, so a payload this suite asserts on is a payload the shipped store
 * accepts; the broadcast is the route main actually takes, which is the only one that reaches a mirror
 * another test in this file already cached.
 */
function fakeMain(
  stub: BridgeStub,
  initial: AppearancePreferencesState
): {
  state: () => AppearancePreferencesState
  choose: (name: 'alignment', value: BubbleAlignment) => Promise<void>
  setPreset: (value: FontPresetId) => Promise<void>
} {
  let state = structuredClone(initial)
  stubStore(stub, APPEARANCE_STORE_ID, state)
  const invoke = stub.bridge.invoke

  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${APPEARANCE_STORE_ID}` && method in appearancePreferencesStore.actions) {
      // Recorded here rather than by the transport: this loop answers the action itself instead of
      // forwarding it, so without this the call the screen made would leave no trace to assert on.
      stub.calls.push({ channel, method, args })
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const next = structuredClone(state)
      const reduce = appearancePreferencesStore.actions[
        method as keyof typeof appearancePreferencesStore.actions
      ] as unknown as (draft: AppearancePreferencesState, input: unknown) => void
      reduce(next, payload)
      state = next
      queueMicrotask(() => stub.pushToChannel('conveyor:store:appearance-preferences:changed', structuredClone(state)))
      return state
    }
    return invoke(channel, method, ...args)
  }

  // A change as main would broadcast it: applied through the store's own reducer, then pushed down the
  // changed channel inside `act`, which is the only route that reaches a mirror an earlier test cached.
  const apply = async (reduce: (draft: AppearancePreferencesState) => void): Promise<void> => {
    const next = structuredClone(state)
    reduce(next)
    state = next
    await act(async () => {
      stub.pushToChannel(`conveyor:store:${APPEARANCE_STORE_ID}:changed`, structuredClone(state))
    })
  }

  return {
    state: () => state,
    choose: (name, value) =>
      apply((draft) => {
        if (name === 'alignment') appearancePreferencesStore.actions.setAlignment(draft, { alignment: value })
      }),
    setPreset: (value) =>
      apply((draft) => {
        appearancePreferencesStore.actions.setFontPreset(draft, { preset: value })
      }),
  }
}

/** The settings reads the shell makes for whichever section is showing. */
function settingsReads() {
  return {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }],
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
  }
}

/** Install a bridge whose answers are the ones the section needs. */
function stubAppearance(state: AppearancePreferencesState = INITIAL_STATE): {
  stub: BridgeStub
  main: ReturnType<typeof fakeMain>
} {
  const stub = createBridgeStub(settingsReads())
  const main = fakeMain(stub, state)
  setActiveStub(stub)
  return { stub, main }
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )
}

/** The Appearance panel, or null while another section is showing. */
function appearanceSection(): HTMLElement | null {
  const node = document.querySelector<HTMLElement>('[data-slot="settings-section-appearance"]')
  if (!node || node.hasAttribute('hidden')) return null
  return node
}

/** The section row the shell draws. */
function sectionRow(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="settings-sections"]') as HTMLElement
}

/** One of Radix's selects, opened from the keyboard — a click on a trigger is not reliable in jsdom. */
async function openSelect(name: string): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

/** Every option the open select offers, in the order it offers them. */
function optionTexts(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '')
}

/** One control's visible value, read off the trigger the way a reader sees it. */
function controlValue(name: string): string {
  return screen.getByRole('combobox', { name }).textContent ?? ''
}

/** The payload of a store action the screen dispatched, which is what main receives. */
function payloadOf(stub: BridgeStub, method: string): unknown {
  const call = stub.calls.find(
    (entry) => entry.channel === `conveyor:store:${APPEARANCE_STORE_ID}` && entry.method === method
  )
  if (!call) throw new Error(`no ${method} call reached the store`)
  return (call.args[0] as { payload?: unknown } | undefined)?.payload
}

/** A conversation on screen, with the appearance store beside it in main. */
async function renderChat(state: AppearancePreferencesState = INITIAL_STATE) {
  const turns = transcriptTurns()
  const sent: unknown[] = []
  const stub = createBridgeStub({
    ...settingsReads(),
    listFilesFlat: () => [],
    loadTranscript: () => snapshot(turns),
    saveTranscript: () => undefined,
    chatWithTools: (input) => void sent.push(input),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  const main = fakeMain(stub, state)
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  await waitFor(() => expect(messageRows().length).toBe(2))
  return { stub, main, sent }
}

/** Every message row on screen, in transcript order. */
function messageRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="message-row"]')]
}

/** The user's own row, found by the words it draws. */
function userRow(): HTMLElement {
  const found = messageRows().find((row) => row.textContent?.includes(QUESTION))
  if (!found) throw new Error('the user message is not on screen')
  return found
}

/** The agent's row, found by the markdown block only it draws. */
function agentRow(): HTMLElement {
  const found = messageRows().find((row) => row.querySelector('[data-slot="markdown"]') !== null)
  if (!found) throw new Error('the agent reply is not on screen')
  return found
}

/** A row's message body, which is what a preset's size class is applied to. */
function bodyOf(row: HTMLElement): HTMLElement {
  const found = row.querySelector<HTMLElement>('[data-slot="message-body"]')
  if (!found) throw new Error('the row draws no message body')
  return found
}

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's and the store is module-level: a test that left the screen on
  // Appearance would otherwise decide the next one's first render.
  useWorkbenchStore.setState({ activeActivity: 'settings', settingsSection: 'providers', settingsReturnView: null })
})

describe('the Appearance section', () => {
  it('is in the shell’s section row, and openSettingsAt lands on it', async () => {
    stubAppearance()
    renderSettings()

    // A launch opens the first section, and Appearance is the last of the preference sections: the row
    // states the order.
    expect(appearanceSection()).toBeNull()
    expect(
      within(sectionRow())
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Providers', 'MCP Servers', 'Skills', 'Terminal', 'Context', 'Appearance', 'Buddies'])

    act(() => useWorkbenchStore.getState().openSettingsAt('appearance'))

    expect(appearanceSection()).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Appearance' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy()
  })

  it('offers both choices, starts on the defaults, and persists each change through the store', async () => {
    const { stub, main } = stubAppearance()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('appearance'))

    const user = userEvent.setup()

    // The defaults are what the pane draws today, and the controls say so rather than showing blank.
    expect(controlValue('Bubble alignment')).toContain('Split')
    expect(controlValue('Chat font size')).toContain('Default · 13px')
    // One helper line each, so a reader who does not know what "same side" means can find out.
    expect(screen.getByText(/Split keeps your messages on the right/)).toBeTruthy()
    expect(screen.getByText(/The size every message is drawn at/)).toBeTruthy()

    await openSelect('Bubble alignment')
    expect(optionTexts()).toEqual(['Split', 'Same side'])
    await user.click(screen.getByRole('option', { name: 'Same side' }))
    await waitFor(() => expect(controlValue('Bubble alignment')).toContain('Same side'))
    expect(payloadOf(stub, 'setAlignment')).toEqual({ alignment: 'same-side' })
    expect(main.state().alignment).toBe('same-side')

    // The other control is the same wiring one field over: every preset the protocol declares, in the
    // order it declares them, with the pixel size named so the choice is not a guess.
    await openSelect('Chat font size')
    expect(optionTexts()).toEqual(['Small · 12.5px', 'Default · 13px', 'Large · 15px', 'Largest · 17px'])
    await user.click(screen.getByRole('option', { name: 'Largest · 17px' }))
    await waitFor(() => expect(controlValue('Chat font size')).toContain('Largest · 17px'))
    expect(payloadOf(stub, 'setFontPreset')).toEqual({ preset: 'largest' })
    expect(main.state().fontPreset).toBe('largest')

    // Main's copy is what the control is drawn from, so the screen would not move if the action had only
    // been recorded and never applied.
    expect(FONT_PRESET_IDS).toContain(main.state().fontPreset)
  })
})

describe('the chat pane’s appearance', () => {
  it('splits the two sides by default, and puts both on the left under same side', async () => {
    const { main } = await renderChat()

    expect(userRow().className).toContain(USER_ROW_CLASS)
    expect(agentRow().className).toContain(AGENT_ROW_CLASS)

    await main.choose('alignment', 'same-side')

    await waitFor(() => expect(userRow().className).not.toContain(USER_ROW_CLASS))
    expect(userRow().className).toContain(AGENT_ROW_CLASS)
    // The agent's own side is not a second alignment: only the user's row moves.
    expect(agentRow().className).toContain(AGENT_ROW_CLASS)

    await main.choose('alignment', 'split')
    await waitFor(() => expect(userRow().className).toContain(USER_ROW_CLASS))
  })

  it('paints the message body at the stored preset, on the agent’s body and the user’s alike', async () => {
    const { main } = await renderChat()

    // Today's rendering, which is the default: the class the bubble has always carried.
    expect(bodyOf(userRow()).className).toContain(TODAYS_BODY_CLASS)
    expect(bodyOf(agentRow()).className).toContain(TODAYS_BODY_CLASS)

    for (const id of FONT_PRESET_IDS) {
      await main.setPreset(id)
      const sizeClass = FONT_PRESETS[id].sizeClass
      await waitFor(() => expect(bodyOf(userRow()).className).toContain(sizeClass))
      expect(bodyOf(agentRow()).className).toContain(sizeClass)
      // Exactly one size on the body: a preset that left the old class behind would be two declarations
      // of one thing, and the winner would be whichever Tailwind emitted last.
      const applied = [...bodyOf(userRow()).classList].filter((name) => /^text-\[[\d.]+px\]$/.test(name))
      expect(applied).toEqual([sizeClass])
    }
  })

  it('reproduces today’s rows and bodies, class for class, on the defaults', async () => {
    await renderChat()

    // This is the assertion the phase's backward-compatibility promise rests on: the class lists the two
    // rows and the two bodies carry are the ones the tree had before the preference existed, in the order
    // Tailwind's merge emits them. jsdom cannot prove a pixel, but it can prove the emitted class string
    // unchanged, and that is the half of "reproduces today's rendering" a test can hold.
    expect([...userRow().classList]).toEqual(['flex', 'w-full', 'px-4', 'py-2.5', 'justify-end'])
    expect([...agentRow().classList]).toEqual(['flex', 'w-full', 'px-4', 'py-2.5', 'justify-start'])
    expect([...bodyOf(userRow()).classList]).toEqual([
      'min-w-0',
      'rounded-lg',
      'px-3.5',
      'py-2.5',
      TODAYS_BODY_CLASS,
      'leading-relaxed',
      'bg-brand-soft',
      'text-foreground',
    ])
    expect([...bodyOf(agentRow()).classList]).toEqual([
      'min-w-0',
      'rounded-lg',
      'px-3.5',
      'py-2.5',
      TODAYS_BODY_CLASS,
      'leading-relaxed',
      'border',
      'border-border',
      'bg-card',
      'text-card-foreground',
    ])
  })
})
