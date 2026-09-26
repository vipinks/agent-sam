import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { HOME_HEADLINE } from '@/app/components/workbench/home'
import { useThemeStore } from '@/app/shell/theme-store'
import { COMPOSER_COMMANDS } from '@/conveyor/protocol/composer-commands'
import type { ChatSession } from '@/conveyor/stores/chat-sessions'
import type { TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The composer's slash commands, as wiring rather than as rules.
 *
 * Every rule this exercises — where a slash counts as a command, what a filter matches, which command
 * is hidden on home, which row a highlight resolves to — is proven directly in
 * `tests/ui/composer-commands-test.ts`. What is left here is the part a rule test cannot see: that the
 * picker opens on the keystroke and not on any other, that the keys reach the handler, and that each
 * command reaches the *real* store action it stands for rather than an arrangement of it.
 *
 * The actions are asserted where the app keeps them: the workbench store's own fields, the theme
 * store's own theme, and the chat-sessions store action `goHome` dispatches. Nothing here asserts on a
 * private detail of the panel, because the failure being guarded against is a row that renders
 * perfectly and runs nothing.
 *
 * The two claims that are about what *does not* happen — a command is not a message, and `/help` is
 * not a transcript entry — are asserted on the transport: nothing is saved, and nothing is sent.
 */

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` measures the scroll element's own `offsetWidth`/`offsetHeight`, and jsdom
 * implements no layout, so a zero-height window renders no rows. This suite does not assert on a
 * message bubble, but it does assert on the screen *leaving home* — and the transcript is what home is
 * replaced by. Scoped to this file and restored afterwards, so no other suite inherits a fabricated
 * size.
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
/** What main would answer with, distinctive so a rendered version cannot be a coincidence. */
const VERSION = '9.9.9'

/** A session whose title is already set, so no first-send naming path runs behind these assertions. */
const SESSION: ChatSession = {
  id: SESSION_ID,
  title: 'an existing conversation',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  providerId: 'deepseek',
  model: 'deepseek-chat',
}

interface Fixture {
  stub: BridgeStub
  /** Every action dispatched at the chat-sessions store, in order. */
  sessionActions: { method: string; payload: Record<string, unknown> }[]
}

/**
 * Main, as the three stores and one query this suite reads.
 *
 * The chat-sessions store is applied rather than only recorded, for the reason the home suite applies
 * it: `atHome` is the store's `activeSessionId`, so a stub that only recorded `setActive` would leave
 * the panel exactly where it was and `/new` could pass while doing nothing.
 */
function stubComposer(
  options: {
    sessions?: ChatSession[]
    activeSessionId?: string | null
    overrides?: Record<string, (input: unknown) => unknown>
  } = {}
): Fixture {
  const chat: { sessions: ChatSession[]; activeSessionId: string | null } = {
    sessions: options.sessions ?? [SESSION],
    activeSessionId: options.activeSessionId === undefined ? SESSION_ID : options.activeSessionId,
  }
  const workspace = { rootPath: null, recentRoots: [] }
  const transcripts: Record<string, TranscriptSnapshot> = {}

  const stub = createBridgeStub({
    listFilesFlat: () => [],
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    loadTranscript: (input) => transcripts[(input as { id: string }).id] ?? null,
    saveTranscript: (input) => {
      const { id, snapshot } = input as { id: string; snapshot: TranscriptSnapshot }
      transcripts[id] = snapshot
      return undefined
    },
    version: () => VERSION,
    ...options.overrides,
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, chat)
  stubStore(stub, 'workspace', workspace)

  const sessionActions: Fixture['sessionActions'] = []
  const procedures = stub.bridge.invoke

  // Wrapped after `stubStore`, so its own state answer still stands: a wrapper that swallowed the read
  // would leave the mirror with no state and let every case below pass for the wrong reason.
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === `conveyor:store:${CHAT_SESSIONS_STORE_ID}`) {
      if (method === '__get__') return chat
      const action = args[0] as { payload: Record<string, unknown> }
      sessionActions.push({ method, payload: action.payload })
      if (method === 'setActive') chat.activeSessionId = action.payload.id as string | null
      stub.pushToChannel(`${channel}:changed`, { ...chat, sessions: [...chat.sessions] })
      return undefined
    }

    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)

  // Seeded and pushed, because the two cover different cases: the seed answers the initial read, which
  // a mirror makes once per store id for the life of the process, and the push is the only route that
  // reaches a mirror an earlier test has already cached.
  stub.pushToChannel(`conveyor:store:${CHAT_SESSIONS_STORE_ID}:changed`, { ...chat, sessions: [...chat.sessions] })
  stub.pushToChannel('conveyor:store:workspace:changed', { ...workspace })

  return { stub, sessionActions }
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

/** The composer, once React has mounted it. */
async function composer(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('Message')) as HTMLTextAreaElement
}

/** The picker's rows, in display order, read off the list the picker labels. */
function commandRows(): HTMLElement[] {
  return within(screen.getByRole('listbox', { name: 'Run a command' })).getAllByRole('option')
}

/** Which commands are on offer, by id — the row's own hook rather than its rendered text. */
function offeredCommands(): (string | null)[] {
  return commandRows().map((row) => row.getAttribute('data-command'))
}

/** The ephemeral notice card, if one is showing. */
function noticeCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="command-notice"]')
}

// The workbench store outlives a test, so the two flags these cases assert on are put back where each
// case expects to find them — otherwise `/terminal` would pass on the previous test's toggle.
beforeEach(() => {
  useWorkbenchStore.setState({ activeActivity: 'chat', settingsSection: 'providers', bottomPanelOpen: false })
})

describe('the slash picker', () => {
  it('opens on a slash at position zero, offering every command', async () => {
    stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/')

    expect(await screen.findByRole('listbox', { name: 'Run a command' })).toBeTruthy()
    expect(offeredCommands()).toEqual(COMPOSER_COMMANDS.map((command) => command.id))
    // The row is the command in monospace and its one line, so the user reads what it does rather than
    // a word they have to already know.
    expect(commandRows()[0]?.textContent).toContain('/new')
    expect(commandRows()[0]?.textContent).toContain('Start a new conversation')
  })

  it('narrows the list as the word is typed', async () => {
    stubComposer()
    renderChat()

    const area = await composer()
    await userEvent.type(area, '/term')
    await waitFor(() => expect(offeredCommands()).toEqual(['terminal']))

    // And widening it back brings the rest of the set back: the filter follows the text.
    await userEvent.type(area, '{Backspace}{Backspace}{Backspace}{Backspace}')
    await waitFor(() => expect(offeredCommands().length).toBe(COMPOSER_COMMANDS.length))
  })

  it('says so rather than failing when the word matches nothing', async () => {
    stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/zzzz')

    expect(await screen.findByText('No matching commands')).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('leaves a slash that is not at position zero as text', async () => {
    stubComposer()
    renderChat()

    const area = await composer()
    await userEvent.type(area, 'see src/utils')

    expect(screen.queryByRole('listbox', { name: 'Run a command' })).toBeNull()

    // And once the draft moves past the word there is nothing to offer either: a command takes no
    // arguments, so `/new please` is a sentence from the first space onwards.
    await userEvent.clear(area)
    await userEvent.type(area, '/new please')

    expect(screen.queryByRole('listbox', { name: 'Run a command' })).toBeNull()
    expect(area.value).toBe('/new please')
  })

  it('walks with the arrow keys and runs the row the highlight is on when Enter is pressed', async () => {
    stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/')
    // The second row is `/terminal`, reached by the arrow key rather than by its name.
    await userEvent.keyboard('{ArrowDown}')

    const highlighted = commandRows().find((row) => row.getAttribute('aria-selected') === 'true')
    expect(highlighted?.getAttribute('data-command')).toBe('terminal')

    await userEvent.keyboard('{Enter}')

    await waitFor(() => expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(true))
    expect(screen.queryByRole('listbox', { name: 'Run a command' })).toBeNull()
  })

  it('runs the row that was clicked, without sending anything', async () => {
    const { stub } = stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/')
    await userEvent.click(screen.getByRole('option', { name: /\/version/ }))

    await waitFor(() => expect(noticeCard()?.textContent).toContain(VERSION))
    expect(stub.methodsOn('agent')).toEqual([])
  })

  it('closes on Escape and leaves the draft exactly where it was', async () => {
    const { sessionActions } = stubComposer()
    renderChat()

    const area = await composer()
    await userEvent.type(area, '/new')
    expect(await screen.findByRole('listbox', { name: 'Run a command' })).toBeTruthy()

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    // Escape is not a cancel of what was typed, and it is not a command either: the text is where the
    // user left it and nothing ran.
    expect(area.value).toBe('/new')
    expect(sessionActions).toEqual([])
    expect(useWorkbenchStore.getState().settingsSection).toBe('providers')
  })
})

describe('the commands', () => {
  it('leaves the conversation on /new, and empties the draft it was typed in', async () => {
    const { sessionActions } = stubComposer()
    renderChat()

    const area = await composer()
    await userEvent.type(area, '/new{Enter}')

    // Home is the store's own state rather than a class name: the panel is at home when nothing is
    // active, which is what `goHome` writes.
    expect(await screen.findByText(HOME_HEADLINE)).toBeTruthy()
    expect(sessionActions.map((action) => action.method)).toContain('setActive')
    expect(sessionActions.at(-1)?.payload.id).toBeNull()
    // The token was consumed rather than left behind as the word `new`.
    expect(area.value).toBe('')
  })

  it('leaves /new out of the picker on home, where it would do nothing', async () => {
    stubComposer({ sessions: [], activeSessionId: null })
    renderChat()

    // The screen is home before anything is typed — the same pane with nothing open.
    expect(await screen.findByText(HOME_HEADLINE)).toBeTruthy()

    await userEvent.type(await composer(), '/')

    expect(await screen.findByRole('listbox', { name: 'Run a command' })).toBeTruthy()
    expect(offeredCommands()).toEqual(
      COMPOSER_COMMANDS.filter((command) => command.id !== 'new').map((command) => command.id)
    )
    // Not hidden by the query: naming it finds nothing, because it could not run here.
    await userEvent.type(await composer(), 'new')
    expect(await screen.findByText('No matching commands')).toBeTruthy()
  })

  it('toggles the bottom panel on /terminal', async () => {
    stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/terminal{Enter}')

    await waitFor(() => expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(true))

    // The same flag the title bar's glyph reads, so a second run puts it back rather than setting it.
    await userEvent.type(await composer(), '/terminal{Enter}')
    await waitFor(() => expect(useWorkbenchStore.getState().bottomPanelOpen).toBe(false))
  })

  it('opens the settings section each of /settings, /mcp and /skills names', async () => {
    stubComposer()
    renderChat()

    const cases = [
      { typed: '/settings{Enter}', section: 'providers' },
      { typed: '/mcp{Enter}', section: 'mcp-servers' },
      { typed: '/skills{Enter}', section: 'skills' },
    ] as const

    for (const { typed, section } of cases) {
      await userEvent.type(await composer(), typed)
      await waitFor(() => expect(useWorkbenchStore.getState().settingsSection).toBe(section))
      expect(useWorkbenchStore.getState().activeActivity).toBe('settings')
    }
  })

  it('flips the window mode on /theme, through the toggle the title bar uses', async () => {
    stubComposer()
    renderChat()

    const before = useThemeStore.getState().theme
    await userEvent.type(await composer(), '/theme{Enter}')

    await waitFor(() => expect(useThemeStore.getState().theme).not.toBe(before))
    expect(useThemeStore.getState().theme).toBe(before === 'dark' ? 'light' : 'dark')
  })

  it('lists every command on /help, in a card that is not a transcript entry', async () => {
    const { stub } = stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/help{Enter}')

    const card = await screen.findByText('Commands')
    const notice = card.closest('[data-slot="command-notice"]')
    expect(notice).toBeTruthy()
    // Every command available here, each with the line that says what it does.
    for (const command of COMPOSER_COMMANDS) {
      expect(notice?.textContent, `/${command.name}`).toContain(`/${command.name}`)
      expect(notice?.textContent, command.description).toContain(command.description)
    }

    // And nothing about it is written down: the answer to a keystroke is not part of the conversation,
    // so no transcript is saved and no message is sent.
    expect(stub.methodsOn('sessions')).not.toContain('saveTranscript')
    expect(stub.methodsOn('agent')).toEqual([])
  })

  it('asks main for the version on /version and shows what it answered', async () => {
    const { stub } = stubComposer()
    renderChat()

    await userEvent.type(await composer(), '/version{Enter}')

    expect(await screen.findByText(VERSION)).toBeTruthy()
    // The string is main's, not the renderer's: the query is what it crossed the bridge on.
    expect(stub.methodsOn('system')).toContain('version')
    expect(stub.callsTo('system').map((call) => call.channel)).toEqual(['conveyor:system'])
  })
})
