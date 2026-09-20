import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '@/conveyor/protocol/transcript'
import { MAX_MENTION_PATHS } from '@/conveyor/protocol/mentions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The composer's mentions, as wiring rather than as rules.
 *
 * Every rule this exercises — what the `@` token is, which path matches a query, when a chip is
 * refused — is tested directly in `mentions-rules.test.ts`. What is left here is the part a rule test
 * cannot see: whether the composer actually asks the registered query, whether a key reaches the
 * handler, and whether the path the user picked is what crosses the bridge on send.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payload asserted below is
 * the payload main would receive, not a reconstruction of it.
 */

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * `@tanstack/react-virtual` sizes its window from the scroll element's own `offsetWidth`/`offsetHeight`,
 * and jsdom implements no layout, so both read as 0 — and a zero-height window makes the virtualizer
 * render no rows at all, because its range calculation bails on `outerSize === 0`. The transcript is
 * where a notice row and a sent message's chips end up, so this suite has to state the viewport the
 * browser would have measured; without it every assertion about a bubble would be asserting against an
 * empty list. It says nothing about layout: nothing here depends on an element's real pixels.
 *
 * Scoped to this file, and restored afterwards, so no other suite inherits a fabricated size.
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
const FILES = ['src/app.tsx', 'src/lib/utils.ts', 'docs/notes.md', 'README.md']

/**
 * A session whose title is already set.
 *
 * Named deliberately: the first-send title path only fires for an untitled session and would add a
 * store write this suite is not about.
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

/** Install a stub whose `listFilesFlat` answers with the workspace the test describes. */
function stubWorkspace(overrides: Record<string, (input: unknown) => unknown> = {}, files = FILES): BridgeStub {
  const stub = createBridgeStub({ listFilesFlat: () => files, ...overrides })
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

/** The composer, once React has mounted it. */
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

// The code viewer's open file lives in the workbench store, which outlives a test; clear it so a test
// that asserts the attach button is disabled cannot be made to pass by the previous test's file.
beforeEach(() => {
  useWorkbenchStore.setState({ selectedFile: null })
})

describe('the @ picker', () => {
  it('opens on @ with the paths the registered query returned', async () => {
    const stub = stubWorkspace()
    renderChat()

    await userEvent.type(await composer(), 'look at @')

    expect(await screen.findByRole('listbox', { name: 'Mention a file' })).toBeTruthy()
    // Every path, because an empty query filters nothing.
    expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual(FILES)
    // And it came from the query main registered, not from anything the renderer walked itself.
    expect(stub.callsTo('mentions').map((call) => call.method)).toContain('listFilesFlat')
  })

  it('filters the list as the query is typed', async () => {
    stubWorkspace()
    renderChat()

    const area = await composer()
    await userEvent.type(area, 'look at @utils')

    await waitFor(() => {
      expect(screen.getAllByRole('option').map((row) => row.textContent)).toEqual(['src/lib/utils.ts'])
    })

    // Backspacing back to a broader query widens it again: the filter follows the text, it does not
    // remember a narrower one.
    await userEvent.type(area, '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}')
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(FILES.length))
  })

  it('says there is no match rather than failing when the filter finds nothing', async () => {
    stubWorkspace()
    renderChat()

    await userEvent.type(await composer(), '@nothing-like-this')

    expect(await screen.findByText('No matching files')).toBeTruthy()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('says a folder has to be open when the workspace has no files', async () => {
    // Exactly what main returns with no folder open: an empty list, not an error.
    stubWorkspace({}, [])
    renderChat()

    await userEvent.type(await composer(), '@')

    expect(await screen.findByText(/open a folder first/i)).toBeTruthy()
  })

  it('moves the selection with the arrow keys and inserts the highlighted file on Enter', async () => {
    stubWorkspace()
    renderChat()

    const area = await composer()
    await userEvent.type(area, '@src')

    // `src` matches two paths, in the walk's order: the first is highlighted until the arrows move it.
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2))
    await userEvent.keyboard('{ArrowDown}')

    const highlighted = screen.getAllByRole('option').find((row) => row.getAttribute('aria-selected') === 'true')
    expect(highlighted?.textContent).toBe('src/lib/utils.ts')

    await userEvent.keyboard('{Enter}')

    // The chip is the second file, because that is the one the arrow key chose.
    expect(await screen.findByTitle('src/lib/utils.ts')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
    // And the `@src` it was chosen from is consumed: the token became the chip.
    expect(area.value).toBe('')
  })

  it('closes on Escape without adding a chip, leaving the typed token alone', async () => {
    stubWorkspace()
    renderChat()

    const area = await composer()
    await userEvent.type(area, '@app')
    expect(await screen.findByRole('listbox')).toBeTruthy()

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(screen.queryByTitle('src/app.tsx')).toBeNull()
    // Escape is not a cancel of what was typed: the text is where the user left it.
    expect(area.value).toBe('@app')
  })

  it('inserts a chip when a row is clicked', async () => {
    stubWorkspace()
    renderChat()

    const area = await composer()
    await userEvent.type(area, 'read @')
    await userEvent.click(await screen.findByRole('option', { name: 'README.md' }))

    expect(await screen.findByTitle('README.md')).toBeTruthy()
    // The rest of the sentence survives the insertion, with the token replaced.
    expect(area.value).toBe('read ')
  })
})

describe('the chips', () => {
  it('shows the path tail with the full path in the tooltip', async () => {
    stubWorkspace()
    renderChat()

    await userEvent.type(await composer(), '@app{Enter}')

    const chip = await screen.findByTitle('src/app.tsx')
    expect(chip.textContent).toBe('app.tsx')
  })

  it('collapses a repeated path into the one chip and says so', async () => {
    stubWorkspace()
    renderChat()

    const area = await composer()
    await userEvent.type(area, '@app{Enter}')
    await userEvent.type(area, '@app{Enter}')

    expect(await screen.findByText('That file is already attached.')).toBeTruthy()
    // One remove control, so one chip: the duplicate collapsed rather than stacking.
    expect(screen.getAllByRole('button', { name: 'Remove src/app.tsx' }).length).toBe(1)
  })

  it('drops a removed chip from the next send', async () => {
    const sent: unknown[] = []
    stubWorkspace({ chatWithTools: (input) => void sent.push(input) })
    renderChat()

    const area = await composer()
    await userEvent.type(area, '@app{Enter}')
    await userEvent.type(area, '@utils{Enter}')

    await userEvent.click(screen.getByRole('button', { name: 'Remove src/app.tsx' }))
    expect(screen.queryByTitle('src/app.tsx')).toBeNull()

    await userEvent.type(area, 'explain it{Enter}')
    await waitFor(() => expect(sent.length).toBe(1))

    expect((sent[0] as { mentionPaths?: string[] }).mentionPaths).toEqual(['src/lib/utils.ts'])
  })

  it('refuses past the cap from both the picker and the attach button, saying so', async () => {
    // Zero-padded so each query matches exactly one file: the names are the test's, not the app's.
    const many = Array.from({ length: MAX_MENTION_PATHS }, (_, i) => `file-${String(i + 1).padStart(2, '0')}.ts`)
    useWorkbenchStore.setState({ selectedFile: 'one-too-many.ts' })
    stubWorkspace({}, many)
    renderChat()

    const area = await composer()
    for (const name of many) {
      await userEvent.type(area, `@${name.slice(5, 7)}{Enter}`)
    }
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Remove / }).length).toBe(MAX_MENTION_PATHS))

    // The picker says it rather than silently listing files the message could not carry.
    await userEvent.type(area, '@')
    expect(await screen.findByText(/at most 20 files/)).toBeTruthy()

    // And so does the attach control, which is refused for the same reason the picker is.
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByLabelText('Attach the open file'))
    await waitFor(() => expect(screen.getAllByText(/at most 20 files/).length).toBeGreaterThan(0))
    // Refused, not added.
    expect(screen.queryByTitle('one-too-many.ts')).toBeNull()
  })
})

describe('attaching the open file', () => {
  it('is disabled while the code viewer has nothing open', async () => {
    stubWorkspace()
    renderChat()

    const attach = (await screen.findByLabelText('Attach the open file')) as HTMLButtonElement
    expect(attach.disabled).toBe(true)
  })

  it('adds the open file as a chip', async () => {
    // What a click in the explorer leaves behind, written the way the code viewer writes it.
    useWorkbenchStore.setState({ selectedFile: 'src/lib/utils.ts' })
    stubWorkspace()
    renderChat()

    await userEvent.click(await screen.findByLabelText('Attach the open file'))

    const chip = await screen.findByTitle('src/lib/utils.ts')
    expect(chip.textContent).toBe('utils.ts')
  })
})

describe('sending with mentions', () => {
  it('sends the chip paths as mentionPaths and clears the composer', async () => {
    const sent: unknown[] = []
    stubWorkspace({ chatWithTools: (input) => void sent.push(input) })
    renderChat()

    const area = await composer()
    await userEvent.type(area, '@app{Enter}')
    await userEvent.type(area, 'what does this file do{Enter}')

    await waitFor(() => expect(sent.length).toBe(1))
    // The payload main validates and reads the files from. Paths, and only paths.
    expect((sent[0] as { mentionPaths?: string[] }).mentionPaths).toEqual(['src/app.tsx'])

    // The composer is empty of the chip; the message keeps it as a record in its bubble.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove src/app.tsx' })).toBeNull())
    expect(screen.getByTitle('src/app.tsx')).toBeTruthy()
  })

  it('omits mentionPaths when nothing was attached', async () => {
    const sent: unknown[] = []
    stubWorkspace({ chatWithTools: (input) => void sent.push(input) })
    renderChat()

    await userEvent.type(await composer(), 'no files attached{Enter}')

    await waitFor(() => expect(sent.length).toBe(1))
    expect((sent[0] as { mentionPaths?: string[] }).mentionPaths).toBeUndefined()
  })

  it('renders a warning row for a file that could not be included', async () => {
    const stub = stubWorkspace({ chatWithTools: () => undefined })
    renderChat()

    await userEvent.type(await composer(), 'look at this{Enter}')

    // The chunks main yields for mentions it could not read, pushed down the stream it opened. Two
    // different codes in one turn, because the row has to be branched on the code: identical wording
    // for both would pass a single-notice test and tell the user nothing.
    const channel = await streamChannel(stub)
    stub.emit(channel, {
      type: 'data',
      value: { type: 'context_notice', path: 'huge.ts', code: 'CONTEXT_FILE_TOO_LARGE' },
    })
    stub.emit(channel, {
      type: 'data',
      value: { type: 'context_notice', path: '../outside.ts', code: 'CONTEXT_FILE_REFUSED' },
    })

    // Named with the path and the code, and worded per code rather than per message text.
    expect(await screen.findByText('huge.ts')).toBeTruthy()
    expect(screen.getByText(/too large to attach/)).toBeTruthy()
    expect(screen.getByText('(CONTEXT_FILE_TOO_LARGE)')).toBeTruthy()

    expect(screen.getByText('../outside.ts')).toBeTruthy()
    expect(screen.getByText(/outside the workspace/)).toBeTruthy()
    expect(screen.getByText('(CONTEXT_FILE_REFUSED)')).toBeTruthy()

    stub.emit(channel, { type: 'end' })
  })
})

describe('a reopened conversation', () => {
  it('renders the stored mentionPaths as chips in the user bubble', async () => {
    const snapshot: TranscriptSnapshot = {
      version: TRANSCRIPT_VERSION,
      interrupted: false,
      turns: [
        {
          id: 'user-1',
          role: 'user',
          content: 'what does this do',
          steps: [],
          mentionPaths: ['src/app.tsx', 'README.md'],
        },
        { id: 'assistant-2', role: 'assistant', content: 'It starts the app.', steps: [] },
      ],
    }
    stubWorkspace({ loadTranscript: () => snapshot })
    renderChat()

    // From the stored paths and nothing else: nothing about a file's contents was ever saved.
    expect(await screen.findByText('what does this do')).toBeTruthy()
    expect(screen.getByTitle('src/app.tsx')).toBeTruthy()
    expect(screen.getByTitle('README.md')).toBeTruthy()
  })
})
