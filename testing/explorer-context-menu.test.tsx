import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { PATH_GONE } from '@/conveyor/protocol/path-actions'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * A right-click on an explorer row: the row's own menu, at the pointer.
 *
 * What only a rendered workbench can show is that the gesture reaches a menu at all, that the menu is
 * where the pointer was, that its items are the rows' own actions in the order the brief names, and
 * that choosing one dispatches the command the app already had — the delete asking first, and nothing
 * being dispatched until it is answered.
 *
 * Every assertion is on the app's state after the gesture — the menu node, its position, the calls the
 * bridge recorded — never on a handler having run, because the failure this guards against is a menu
 * that draws and dispatches nothing.
 *
 * Rendered whole rather than as the explorer alone for the reason `explorer-double-click.test.tsx`
 * renders it whole: the row lives in the tree the workbench mounts, and the tree is only reachable
 * through it. The resize primitive is stood in for exactly as that suite stands in for it, which also
 * keeps Radix's own separators off the page: this suite counts the menu's separators, so the layout's
 * must not be there to be counted.
 *
 * Residual, named rather than claimed: jsdom lays nothing out, so the menu's own size is zero and the
 * clamp against the window edges is a no-op here. What is pinned is that the pointer's position is the
 * position the menu opens at; where a menu near an edge lands in a real window is a window's to prove.
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
const SRC = 'C:/w/src'
const NOTES = 'C:/w/notes.txt'
const MANUAL = 'C:/w/manual.pdf'

const NOTES_SOURCE = ['just words', 'on two lines', ''].join('\n')

/**
 * The whole workbench, over a folder holding one folder, one text file and one document.
 *
 * The two files are the point of the fixture: the menu's third group is the app's existing document
 * hand-off, which main refuses for anything but a pdf, a docx or a doc — so a pdf row and a text-file
 * row are what tell "offered where the command accepts the kind" apart from "offered everywhere".
 */
function stubWorkbench(handlers: Record<string, (input: unknown) => unknown> = {}) {
  const stub = createBridgeStub({
    isMaximized: () => false,
    listDirectory: (input) => {
      const path = (input as { path: string }).path
      if (path !== ROOT) return []
      return [
        { name: 'src', path: SRC, isDirectory: true },
        { name: 'notes.txt', path: NOTES, isDirectory: false },
        { name: 'manual.pdf', path: MANUAL, isDirectory: false },
      ]
    },
    readFile: (input) => {
      const path = (input as { path: string }).path
      return { path, content: NOTES_SOURCE, baselineMtime: 0 }
    },
    deletePath: (input) => ({ path: (input as { path: string }).path }),
    revealPath: (input) => ({ path: (input as { path: string }).path }),
    openDocument: (input) => ({ path: (input as { path: string }).path }),
    // Every other read a pane makes is answered emptily: the git panel, the provider lists and the
    // mention index are not this file's subject, and an unstubbed query would be noise in the middle
    // of a menu claim.
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    openRoot: () => ROOT,
    ...handlers,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
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

/** One row of the tree, by the name it shows. Found rather than got: the listing arrives async. */
function row(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name })
}

/** The open menu. `getByRole` throws when it is absent, which is what "it did not open" needs. */
function menu(): HTMLElement {
  return screen.getByRole('menu', { name: 'File actions' })
}

/** The items the menu offers, in the order it draws them. */
function items(): string[] {
  return within(menu())
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
}

/** Right-click a row at a known point, the way a pointer would. */
function rightClick(target: HTMLElement, x = 120, y = 240): void {
  fireEvent.contextMenu(target, { clientX: x, clientY: y })
}

/** The one bridge call made to a member, or null when it was never called. */
function callTo(stub: ReturnType<typeof stubWorkbench>, method: string) {
  return stub.callsTo('workspace').find((entry) => entry.method === method) ?? null
}

/** How many times the root listing has been asked for, which is how a re-read is observed. */
function rootReads(stub: ReturnType<typeof stubWorkbench>): number {
  return stub
    .callsTo('workspace')
    .filter((entry) => entry.method === 'listDirectory' && (entry.args[0] as { path: string }).path === ROOT).length
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({
    // The explorer's own drawer view: the tree has to be on screen for its rows to be right-clicked.
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
    drawerCollapsed: false,
    rightPanel: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
    layoutPreferences: {},
  })
  queryClient.clear()
})

describe('a right-click on a file row', () => {
  it('opens the menu at the pointer, with the row actions in order', async () => {
    stubWorkbench()
    renderWorkbench()

    rightClick(await row('manual.pdf'), 120, 240)

    const opened = menu()
    // The pointer's position, in pixels: the menu is placed where the click was rather than anchored
    // to the row, so the same row right-clicked at its top and at its bottom opens in two places.
    expect(opened.style.left).toBe('120px')
    expect(opened.style.top).toBe('240px')

    expect(items()).toEqual(['Delete', 'Show in folder', 'Attach to conversation', 'Open in default app'])
    // Two rules rather than one per item: the groups are Delete, what is done to the path itself, and
    // the rest.
    expect(within(opened).getAllByRole('separator')).toHaveLength(2)
  })

  it('offers the document hand-off only where that command accepts the kind', async () => {
    stubWorkbench()
    renderWorkbench()

    rightClick(await row('notes.txt'))

    // `workspace.openDocument` is a document opener — main refuses anything that is not a pdf, a docx
    // or a doc — so a text file is not offered an item that would come back with a refusal. Attaching
    // it is a different question, and a file row is offered that wherever it lives in the tree.
    expect(items()).toEqual(['Delete', 'Show in folder', 'Attach to conversation'])
    expect(within(menu()).getAllByRole('separator')).toHaveLength(1)
  })

  it('closes on Escape, on an outside click, and leaves nothing behind', async () => {
    stubWorkbench()
    renderWorkbench()

    rightClick(await row('notes.txt'))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    rightClick(await row('notes.txt'))
    expect(menu()).toBeTruthy()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})

describe('choosing Delete on a row', () => {
  it('asks first, naming the path and the cost, and dispatches nothing until it is answered', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('notes.txt'))
    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog')
    // The path, not the name: two files of the same name can be open in one tree, and the question has
    // to be about the one that was right-clicked.
    expect(within(dialog).getByText(/C:\/w\/notes\.txt/)).toBeTruthy()
    expect(dialog.textContent).toMatch(/removed from disk/)
    expect(dialog.textContent).toMatch(/cannot be undone/)
    // The question is the whole of the act so far: nothing has been handed to main.
    expect(stub.methodsOn('workspace')).not.toContain('deletePath')
  })

  it('dispatches the delete with the path on confirm, and leaves the row alone until main answers', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('notes.txt'))
    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('deletePath'))
    expect(callTo(stub, 'deletePath')?.args[0]).toEqual({ path: NOTES, rootPath: ROOT })
    // The menu is gone once the act is chosen, and the row is where main's own event will re-read it.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(await row('notes.txt')).toBeTruthy()
  })

  it('closes and changes nothing on cancel', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('notes.txt'))
    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(stub.methodsOn('workspace')).not.toContain('deletePath')
    expect(await row('notes.txt')).toBeTruthy()
  })

  it('refuses a path that is gone by naming it, and asks the tree to read the folder again', async () => {
    const stub = stubWorkbench({
      deletePath: () => {
        throw new ConveyorError(PATH_GONE, 'notes.txt is no longer there.')
      },
    })
    renderWorkbench()

    rightClick(await row('notes.txt'))
    const before = rootReads(stub)

    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // A refusal is the one case main announces nothing for, so the pane says why and re-reads the
    // folder itself — the row that was right-clicked may not be there to be drawn anymore.
    expect(await screen.findByText(/no longer there/i)).toBeTruthy()
    await waitFor(() => expect(rootReads(stub)).toBeGreaterThan(before))
  })
})

describe("choosing one of the row's other actions", () => {
  it('dispatches Show in folder with the row path, and closes', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('manual.pdf'))
    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Show in folder' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('revealPath'))
    expect(callTo(stub, 'revealPath')?.args[0]).toEqual({ path: MANUAL })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })

  it('dispatches the document hand-off unchanged, with the row path and nothing else', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('manual.pdf'))
    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Open in default app' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openDocument'))
    expect(callTo(stub, 'openDocument')?.args[0]).toEqual({ path: MANUAL })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})

describe('choosing Attach to conversation on a file row', () => {
  it('chips the row path into the live draft and closes the menu', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('notes.txt'))
    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Attach to conversation' }))

    // The chip is the draft's, and the name it is removed by is the whole path rather than the tail the
    // label shows — the same chip the `@` picker and the plus produce.
    expect(await screen.findByRole('button', { name: `Remove ${NOTES}` })).toBeTruthy()
    expect(screen.getByTitle(NOTES).textContent).toBe('notes.txt')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    // A draft edit rather than a command: nothing was asked of the disk to attach a path.
    expect(stub.methodsOn('workspace')).not.toContain('deletePath')
  })

  it('is not offered on a folder row', async () => {
    stubWorkbench()
    renderWorkbench()

    rightClick(await row('src'))

    expect(items()).not.toContain('Attach to conversation')
  })
})

describe('a right-click on a folder row', () => {
  it('offers the same menu, with the folder as its subject', async () => {
    const stub = stubWorkbench()
    renderWorkbench()

    rightClick(await row('src'))
    // No attach item: a chip names a file the send reads, and a folder is not one.
    expect(items()).toEqual(['Delete', 'Show in folder'])

    await userEvent.click(within(menu()).getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/C:\/w\/src/)).toBeTruthy()
    expect(dialog.textContent).toMatch(/everything inside it/)

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('deletePath'))
    expect(callTo(stub, 'deletePath')?.args[0]).toEqual({ path: SRC, rootPath: ROOT })
  })
})
