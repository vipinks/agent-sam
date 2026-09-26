import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { COMPOSER_MIN_HEIGHT } from '@/app/components/workbench/composer-resize'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The composer's half-written message, across a window-state swap.
 *
 * The workbench keys both of its resize groups on the window state, because the resize library takes a
 * declared layout once and owns it from then on — so a maximize or a restore arrives as a new group and
 * the panes under it remount. Phase 34 moved the consent pause above that key for exactly this reason.
 * The composer was left behind, and what the remount threw away was everything the user had not sent
 * yet: the text in the box, the files attached to it, and the height they had dragged it to. A maximize
 * silently deleted a written message.
 *
 * So these claims are about the pane the swap built, for both directions: the draft is still there, the
 * chips are still there, the height is still there — and a real send still clears the composer exactly
 * as it did before, which is the half of this that must not change.
 *
 * The workbench is rendered whole rather than the pane in isolation, because the remount is the
 * mechanism: a standalone pane has no key above it and cannot fail this way.
 */

/**
 * The resize primitive, stood in for.
 *
 * The real one takes the caret on a pointerdown as it mounts; jsdom then does not follow that with the
 * click's own focus, so the composer would never receive a keystroke here. Nothing about the claim goes
 * with it — the key is the workbench's, on the element the workbench creates — and the two markers keep
 * the structure queryable: `data-group` with the group's id, `data-panel` with the panel's.
 */
vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-group id={id}>
      {children}
    </div>
  ),
  ResizablePanel: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-panel id={id}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'
const SESSION_ID = 'cccccccc-3333-4333-8333-333333333333'
const OPEN_FILE = 'src/parser.ts'

/** A viewport for the virtualized transcript, which jsdom does not have. */
const VIEWPORT = { width: 900, height: 800 }
/** The chat column's height, which is what the composer's ceiling is a share of. */
const PANE_HEIGHT = 500

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

/** The whole workbench, over a folder, with the window in the given state. */
function stubWorkbench(windowed = true): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => !windowed,
    chatWithTools: () => undefined,
    resume: () => undefined,
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    readFile: () => ({ path: '', content: '', baselineMtime: 0 }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    // The image store's one write, answered with a reference the way main answers: the composer carries
    // what the store returned, so a stub that answered `undefined` would be a store that stored nothing
    // and a turn naming a reference that does not exist.
    save: (input) => {
      const request = input as { name: string; mimeType: string; bytes: Uint8Array }
      return {
        id: `stored-${request.name}`,
        name: request.name,
        mimeType: request.mimeType,
        size: request.bytes.byteLength,
      }
    },
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, SESSION_STATE)
  // Seeded as image-capable, because the composer refuses images outright for a provider whose record
  // says nothing and one of the cases below is about an image the user dropped surviving the swap. The
  // empty `enabledModels` is deliberate: it leaves the model list reading from the seeded catalogue
  // exactly as it did before this store was seeded at all.
  stubStore(stub, 'provider-config', {
    providers: { deepseek: { enabledModels: [], fetchedModels: [], supportsImages: true } },
    customProviders: [],
  })
  setActiveStub(stub)
  return stub
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/**
 * The chat column's own node, which is how a remount is observed rather than assumed.
 *
 * The group is keyed, so a state swap does not re-render this element — it replaces it.
 */
function chatColumn(container: HTMLElement): HTMLElement {
  const column = container.querySelector<HTMLElement>('[data-panel]#chat')
  if (!column) throw new Error('the workbench rendered no chat column')
  return column
}

/**
 * The pane the composer's ceiling is measured against, with the height jsdom cannot give it.
 *
 * Defined on the element the pane actually renders rather than on `HTMLElement.prototype`, so no other
 * element in this file inherits a size it does not have — and redefined after each swap, because a swap
 * replaces the element that carried it.
 *
 * The pane is reached through the chat column's own conversation panel rather than as the column's first
 * child, because the column is no longer a bare pane: its vertical group holds that panel with the
 * bottom terminal panel's own under it. The element carrying the composer's separator is still the same
 * one either way, and measuring the group instead would be measuring a box the composer does not read.
 */
function measurablePane(container: HTMLElement): void {
  const pane = chatColumn(container).querySelector<HTMLElement>('[data-panel]#conversation')?.firstElementChild
  if (!pane?.querySelector('[role="separator"]')) throw new Error('the rendered panel is not a chat pane')
  Object.defineProperty(pane, 'clientHeight', { value: PANE_HEIGHT, configurable: true })
}

/**
 * Wait for the launch query's answer to land.
 *
 * `useWorkbenchLayout` assumes a windowed window until main answers, so a maximized launch re-keys the
 * group once, after the first paint. Typing before that lands is typing into the pane the answer is
 * about to replace — the keystrokes would go to a detached node and React would never see them — which
 * is a race in the test rather than a claim about a swap.
 */
async function layoutSettled(container: HTMLElement): Promise<void> {
  const first = chatColumn(container)
  await waitFor(() => expect(chatColumn(container)).not.toBe(first))
}

/** Push a window-state change, as main's own maximize/unmaximize listeners do. */
async function swapWindowState(container: HTMLElement, stub: BridgeStub, maximized: boolean): Promise<void> {
  const before = chatColumn(container)
  act(() => stub.emit('conveyor:event:window:onMaximizeChange', maximized))
  // Waited on rather than assumed: the push is applied on the next render, and the node it leaves
  // behind is the evidence that the pane under the keyed group was replaced. Everything after this
  // therefore runs against the pane the swap built, which is what a user's typing lands in too.
  await waitFor(() => expect(chatColumn(container)).not.toBe(before))
}

/** The composer, as the field the user types into. */
const composer = async (): Promise<HTMLTextAreaElement> =>
  (await screen.findByLabelText('Message')) as HTMLTextAreaElement

/** The composer's top edge, as the user grabs it. */
const handle = (): Promise<HTMLElement> => screen.findByRole('separator', { name: 'Resize the composer' })

/** One drag: where the pointer went down, where it moved to, and the element it started on. */
function drag(from: number, to: number, on: HTMLElement): void {
  fireEvent.pointerDown(on, { clientY: from, button: 0 })
  fireEvent.pointerMove(window, { clientY: to })
  fireEvent.pointerUp(window)
}

/** The halfway-typed message every swap test starts from. */
const HALF_TYPED = 'refactor the lexer, but leave the tokens alone'

/**
 * One image, as a drop would hand it over.
 *
 * A real `File` over real bytes rather than a stand-in object: the composer reads the file's own
 * `arrayBuffer()`, so a stub would be measuring the stub. jsdom gives the bytes and the name; what it
 * cannot give is a boundary to clone them across, which is the app's and not this suite's.
 */
const droppedImage = (): File => new File([new Uint8Array(48)], 'shot.png', { type: 'image/png' })

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
})

describe('the composer across a window-state swap', () => {
  it('keeps a half-typed message when the window is maximized', async () => {
    const stub = stubWorkbench()
    const { container } = renderWorkbench()
    measurablePane(container)

    const before = await composer()
    await userEvent.click(before)
    await userEvent.type(before, HALF_TYPED)
    expect(before.value).toBe(HALF_TYPED)

    await swapWindowState(container, stub, true)

    // The pane the swap built, typed into and left as it was. Before the fix this read empty: the draft
    // was the pane's own state, and the pane had just been replaced.
    expect((await composer()).value).toBe(HALF_TYPED)
  })

  it('keeps it when a maximized window is restored, which is the other direction', async () => {
    // Launched maximized, so the swap below is the restore. The state is main's answer as this suite's
    // stub reports it, which is the same route into the state the app takes.
    const stub = stubWorkbench(false)
    const { container } = renderWorkbench()
    measurablePane(container)
    await layoutSettled(container)
    measurablePane(container)

    const before = await composer()
    await userEvent.click(before)
    await userEvent.type(before, HALF_TYPED)
    expect(before.value).toBe(HALF_TYPED)

    await swapWindowState(container, stub, false)

    expect((await composer()).value).toBe(HALF_TYPED)
  })

  it('keeps the attached files and the dragged height with it', async () => {
    // The other two things the composer was holding, and both are visible to the user: the chips under
    // the box, and the height they dragged its top edge to.
    useWorkbenchStore.setState({ selectedFile: OPEN_FILE })
    const stub = stubWorkbench()
    const { container } = renderWorkbench()
    measurablePane(container)

    const before = await composer()
    await userEvent.click(before)
    await userEvent.type(before, HALF_TYPED)
    await userEvent.click(await screen.findByRole('button', { name: 'Attach the open file' }))
    expect(await screen.findByRole('button', { name: `Remove ${OPEN_FILE}` })).toBeTruthy()

    drag(400, 340, await handle())
    expect(before.style.height).toBe(`${COMPOSER_MIN_HEIGHT + 60}px`)

    await swapWindowState(container, stub, true)
    measurablePane(container)

    expect((await composer()).value).toBe(HALF_TYPED)
    expect(await screen.findByRole('button', { name: `Remove ${OPEN_FILE}` })).toBeTruthy()
    expect((await composer()).style.height).toBe(`${COMPOSER_MIN_HEIGHT + 60}px`)
  })

  it('keeps a dropped image across the swap, and still sends it afterwards', async () => {
    // An image is the fourth thing the composer holds, and the one with the least to fall back on: the
    // text can be retyped and the height redragged, but a pasted screenshot that the swap threw away is
    // gone, because the bytes were written nowhere until a send. So it rides the same lift, and this is
    // the case that says so.
    const stub = stubWorkbench()
    const { container } = renderWorkbench()
    measurablePane(container)

    const before = await composer()
    await userEvent.click(before)
    await userEvent.type(before, HALF_TYPED)
    fireEvent.drop(before, { dataTransfer: { files: [droppedImage()] } })
    await waitFor(() => expect(screen.queryAllByRole('button', { name: 'Remove shot.png' }).length).toBe(1))

    await swapWindowState(container, stub, true)
    measurablePane(container)

    // The words and the picture are both still there, and the chip belongs to the pane the swap built
    // rather than the one it replaced.
    expect((await composer()).value).toBe(HALF_TYPED)
    expect(screen.queryAllByRole('button', { name: 'Remove shot.png' }).length).toBe(1)

    // And a send still takes it: the draft that survived the swap is the draft the send reads, which is
    // the whole point of holding it above the key.
    await userEvent.type(await composer(), '{Enter}')
    await waitFor(() => expect(stub.methodsOn('attachments')).toEqual(['save']))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove shot.png' })).toBeNull())
  })

  it('still clears the composer when the message is actually sent', async () => {
    useWorkbenchStore.setState({ selectedFile: OPEN_FILE })
    const stub = stubWorkbench()
    const { container } = renderWorkbench()
    measurablePane(container)

    const before = await composer()
    await userEvent.click(before)
    await userEvent.type(before, HALF_TYPED)
    await userEvent.click(await screen.findByRole('button', { name: 'Attach the open file' }))
    await screen.findByRole('button', { name: `Remove ${OPEN_FILE}` })

    // A swap first, so what is cleared here is the composer the swap built rather than the one the
    // message was typed into — which is the state a user is actually in when they hit Enter.
    await swapWindowState(container, stub, true)
    measurablePane(container)
    const after = await composer()
    await userEvent.type(after, '{Enter}')

    await waitFor(() => expect(stub.calls.some((call) => call.channel === 'conveyor:stream:start')).toBe(true))

    // The message is gone from the box and the chips went with it: the draft belonged to the send, and
    // keeping it would leave the user looking at a message that had already been sent.
    await waitFor(() => expect(after.value).toBe(''))
    expect(screen.queryByRole('button', { name: `Remove ${OPEN_FILE}` })).toBeNull()
  })
})
