import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { ExplorerPanel } from '@/app/components/workbench/explorer-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { WORKSPACE_MISSING } from '@/conveyor/protocol/recent-roots'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The switcher's wiring, asserted where it can actually break.
 *
 * The ordering and deduplication rules are covered without a DOM in `recent-roots-rules.test.ts`.
 * What only a DOM test can see is whether the menu reaches them: that a row carries the check for
 * the open root, that clicking one asks main to open that root, that forgetting one only forgets it,
 * and that the confirm in front of a switch really does hold the switch back when it is declined.
 *
 * Every assertion is on the call the panel makes, not on the rule's arithmetic — the failure this
 * guards against is a control that renders correctly and calls nothing.
 *
 * Rendered under the app's own `queryClient`, because the conveyor client captures that instance at
 * construction. It is cleared between tests.
 */

const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const ARCHIVE = 'C:/work/archive'
/** A file open in the viewer, belonging to the folder that is currently open. */
const FILE = `${ROOT}/src/app.ts`

/** One recorded store action, in the shape the wire delivers it. */
interface RecordedAction {
  method: string
  payload: unknown
}

/**
 * A workspace with three known roots: one open, one other, and one that is gone.
 *
 * The dialog and the switch are both answered by `main` here, so an assertion can tell which of them
 * the panel actually reached.
 */
function stubExplorer(
  options: {
    rootPath?: string | null
    overrides?: Record<string, (input: unknown) => unknown>
  } = {}
): { stub: BridgeStub; actions: RecordedAction[] } {
  const rootPath = options.rootPath === undefined ? ROOT : options.rootPath

  const stub = createBridgeStub({
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    pickFolder: () => NOTES,
    openRoot: () => ({ path: NOTES }),
    ...options.overrides,
  })

  stubStore(stub, 'workspace', { rootPath, recentRoots: [ROOT, NOTES, ARCHIVE] })

  // Store actions arrive as invokes on the store channel with the action name as the method, which
  // is how the client dispatches them. Wrapped *after* `stubStore`, so its own state answer still
  // stands: a wrapper that swallowed the `__get__` read would leave the mirror with no state at all
  // and let every case below pass for the wrong reason.
  const actions: RecordedAction[] = []
  const procedures = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === 'conveyor:store:workspace') {
      if (method === '__get__') return { rootPath, recentRoots: [ROOT, NOTES, ARCHIVE] }
      actions.push({ method, payload: args[0] })
      return undefined
    }
    return procedures(channel, method, ...args)
  }

  setActiveStub(stub)
  return { stub, actions }
}

function renderExplorer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ExplorerPanel />
    </QueryClientProvider>
  )
}

/** Open the header dropdown, and wait for the menu to be there. */
async function openMenu(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Recent folders' }))
  await screen.findByRole('button', { name: 'notes' })
}

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
  queryClient.clear()
})

describe('the recents menu', () => {
  it('lists the recent roots, with a check on the open one', async () => {
    stubExplorer()
    renderExplorer()
    await openMenu()

    const open = screen.getByRole('button', { name: 'sam-ai' })
    expect(open.getAttribute('aria-current')).toBe('true')
    expect(open.querySelector('svg')).not.toBeNull()
    // The tooltip is the whole path: the label is only ever the last segment.
    expect(open.getAttribute('title')).toBe(ROOT)

    const other = screen.getByRole('button', { name: 'notes' })
    expect(other.getAttribute('aria-current')).toBeNull()
    expect(other.querySelector('svg')).toBeNull()
    expect(other.getAttribute('title')).toBe(NOTES)

    expect(screen.getByRole('button', { name: 'archive' })).toBeTruthy()
  })

  it('asks main to open the root of the row that was clicked', async () => {
    const { stub } = stubExplorer()
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'notes' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openRoot'))
    const opened = stub.callsTo('workspace').find((call) => call.method === 'openRoot')
    expect(opened?.args[0]).toEqual({ path: NOTES })
  })

  it('forgets a row without switching to it', async () => {
    const { stub, actions } = stubExplorer()
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'Forget notes' }))

    // Forgetting is a store action and nothing else: the folder that is open does not move.
    await waitFor(() => expect(actions.some((a) => a.method === 'forgetRoot')).toBe(true))
    expect(actions.find((a) => a.method === 'forgetRoot')?.payload).toEqual({ payload: NOTES })
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
  })

  it('invokes the folder dialog from the Open Folder item', async () => {
    const { stub } = stubExplorer()
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'Open Folder' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('pickFolder'))
  })
})

describe('switching away from unsaved edits', () => {
  /** The dirty editor: a file open with edits that were never saved. */
  function dirtyEditor(): void {
    useWorkbenchStore.setState({
      selectedFile: FILE,
      editor: { path: FILE, dirty: true, externalNonce: 0 },
    })
  }

  it('asks first, and a cancel leaves the editor and the folder untouched', async () => {
    const { stub } = stubExplorer()
    dirtyEditor()
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'notes' }))

    expect(await screen.findByText('Discard unsaved edits?')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }))

    await waitFor(() => expect(screen.queryByText('Discard unsaved edits?')).toBeNull())
    // Nothing moved: the switch was never attempted, so the edits are still open and unsaved.
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
    expect(useWorkbenchStore.getState().selectedFile).toBe(FILE)
    expect(useWorkbenchStore.getState().editor.dirty).toBe(true)
  })

  it('switches and clears the editor once the discard is confirmed', async () => {
    const { stub } = stubExplorer()
    dirtyEditor()
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'notes' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Discard and switch' }))

    await waitFor(() => expect(stub.methodsOn('workspace')).toContain('openRoot'))
    // The open file belonged to the folder that just stopped being open, so the viewer is cleared.
    await waitFor(() => expect(useWorkbenchStore.getState().selectedFile).toBeNull())
    expect(useWorkbenchStore.getState().editor.dirty).toBe(false)
  })

  it('closes the open file on a clean switch too, because it belonged to the other folder', async () => {
    const { stub } = stubExplorer()
    // No edits, so nothing is asked: opening another folder is a switch, not a decision.
    useWorkbenchStore.setState({
      selectedFile: FILE,
      editor: { path: FILE, dirty: false, externalNonce: 0 },
    })
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'notes' }))

    await waitFor(() => expect(useWorkbenchStore.getState().selectedFile).toBeNull())
    expect(screen.queryByText('Discard unsaved edits?')).toBeNull()
    expect(stub.methodsOn('workspace')).toContain('openRoot')
  })

  it('does not interrupt a switch to the folder that is already open', async () => {
    const { stub } = stubExplorer()
    dirtyEditor()
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'sam-ai' }))

    // There is nothing to switch, so there is nothing to warn about — and nothing to call.
    await waitFor(() => expect(screen.queryByText('Discard unsaved edits?')).toBeNull())
    expect(stub.methodsOn('workspace')).not.toContain('openRoot')
    expect(useWorkbenchStore.getState().selectedFile).toBe(FILE)
  })
})

describe('a root that is gone', () => {
  it('reports it by code and leaves the open folder alone', async () => {
    const { stub } = stubExplorer({
      overrides: {
        openRoot: () => {
          throw new ConveyorError(WORKSPACE_MISSING, 'C:/work/archive is not a folder that exists.')
        },
      },
    })
    useWorkbenchStore.setState({
      selectedFile: FILE,
      editor: { path: FILE, dirty: false, externalNonce: 0 },
    })
    renderExplorer()
    await openMenu()

    await userEvent.click(screen.getByRole('button', { name: 'notes' }))

    // The wording is the renderer's, chosen by the code — never main's sentence.
    expect(await screen.findByText(/no longer there/i)).toBeTruthy()
    expect(stub.methodsOn('workspace')).toContain('openRoot')
    // A failed switch must not cost the user what is on screen.
    expect(useWorkbenchStore.getState().selectedFile).toBe(FILE)
  })
})
