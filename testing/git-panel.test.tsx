import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import type { GitStatusEntry } from '@/conveyor/protocol/git'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * Git as its own rail item, and as its own panel.
 *
 * The change this pins: the Changes section used to be a section of the explorer, where it was a
 * reading of the folder above it. It is now the panel of a rail item of its own, which makes three
 * things true that no rule test can see — the rail has the item and in the right place, selecting it
 * is what draws the section, and the explorer no longer draws it. The last one is the one that fails
 * silently if it is forgotten: a section rendered in two panels still looks right in whichever one you
 * happen to be looking at.
 *
 * The row that opens the diff pane is asserted through the workbench rather than through the section
 * alone, because the claim is about the pair: the section is in the drawer and the pane is beside it,
 * and a row that selects a change still has to reach a viewer that is rendering.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payloads and the panel
 * contents asserted below are the ones main would answer.
 */

const ROOT = 'C:/w'

const STATUS: GitStatusEntry[] = [
  { path: 'src/staged.ts', indexState: 'M', worktreeState: '.', kind: 'ordinary' },
  { path: 'src/edited.ts', indexState: '.', worktreeState: 'M', kind: 'ordinary' },
]

/** The diff the pane is asked for when a staged row is opened. */
const DIFF = {
  lines: [{ kind: 'added' as const, text: 'staged side' }],
  added: 1,
  removed: 0,
  truncated: false,
}

/** The whole workbench over a repository with the open folder already set. */
function stubWorkbench(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    // The window state the workbench lays out for. Windowed, which is the window the app opens.
    isMaximized: () => false,
    readFile: () => ({ path: '', content: '', baselineMtime: 0 }),
    listDirectory: () => [],
    status: () => STATUS,
    branch: () => ({ name: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1 }),
    log: () => [],
    localBranches: () => ['main', 'feature/panel'],
    diff: () => DIFF,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    ...overrides,
  })
  // Seeded with the shape main delivers whole: the folder is open, which is the state the git panel
  // reports on.
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
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

/** The secondary panel — the drawer the rail switches between panels in. */
function drawer(container: HTMLElement): HTMLElement {
  const panel = container.querySelector<HTMLElement>('[data-panel]#secondary')
  if (!panel) throw new Error('the workbench rendered no secondary panel')
  return panel
}

/** Click a rail item by the label it states to everything that is not a pointer. */
async function selectRail(label: string): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: label }))
}

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    commitMessage: '',
    viewerExpanded: false,
  })
  queryClient.clear()
})

describe('the rail', () => {
  it('carries the three residents the drawer holds, with Settings listed beside them', async () => {
    stubWorkbench()
    renderWorkbench()

    // Every item states its label through `aria-label`, because the buttons are icons. Phase 39 left this
    // rail with the drawer's own three views: the shell is a resident of the right rail now, and the
    // collapse control retired from here when the way into the drawer moved to the drawer's own header.
    // Settings is listed with them and is not one of them — it is a place you visit and leave.
    const nav = screen.getByRole('navigation', { name: 'Workbench' })
    const labels = [...nav.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))

    expect(labels).toEqual(['Chat', 'Explorer', 'Git', 'Settings'])
    expect(labels.filter((label) => label !== 'Settings')).toHaveLength(3)
  })

  it('marks the git item as the current view once it is selected', async () => {
    stubWorkbench()
    renderWorkbench()

    const before = screen.getByRole('button', { name: 'Git' })
    expect(before.getAttribute('aria-pressed')).toBe('false')

    await selectRail('Git')

    expect(screen.getByRole('button', { name: 'Git' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Explorer' }).getAttribute('aria-pressed')).toBe('false')
  })
})

describe('the git panel', () => {
  it('draws the changes section in the drawer when its rail item is selected', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await selectRail('Git')

    // The whole section: the branch, its divergence, the groups, and the commit box — in the drawer,
    // which is the panel that belongs to the rail item rather than to the explorer.
    expect(within(drawer(container)).getByText('Staged · 1')).toBeTruthy()
    expect(within(drawer(container)).getByText('Changes · 1')).toBeTruthy()
    expect(within(drawer(container)).getByText('2 ahead, 1 behind')).toBeTruthy()
    expect(within(drawer(container)).getByLabelText('Commit message')).toBeTruthy()
    expect(within(drawer(container)).getByLabelText('Refresh changes')).toBeTruthy()
    expect(within(drawer(container)).getByLabelText('Switch branch')).toBeTruthy()
  })

  it('is not a section of the explorer any more', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await selectRail('Git')
    await screen.findByText('Staged · 1')

    await selectRail('Explorer')

    // The explorer is up, and it is the explorer: its own header control and the folder it is showing.
    const panel = drawer(container)
    expect(within(panel).getByRole('button', { name: 'Recent folders' })).toBeTruthy()
    expect(within(panel).getByTitle(ROOT)).toBeTruthy()
    // And nothing of git is in it — not the groups, not the branch line, not the commit box. A section
    // left behind in both panels is the failure this exists to catch.
    expect(within(panel).queryByText('Staged · 1')).toBeNull()
    expect(within(panel).queryByText('Changes · 1')).toBeNull()
    expect(within(panel).queryByLabelText('Commit message')).toBeNull()
    expect(within(panel).queryByLabelText('Refresh changes')).toBeNull()
  })

  it('says the folder is not a repository inside the git panel, in its own words', async () => {
    // Exactly what main raises for a folder with no repository: a code, on the first read the panel
    // makes. The wording is the renderer's, chosen by the code.
    stubWorkbench({
      status: () => {
        throw new ConveyorError('GIT_NOT_REPO', 'This folder is not a git repository.')
      },
      branch: () => {
        throw new ConveyorError('GIT_NOT_REPO', 'This folder is not a git repository.')
      },
    })
    const { container } = renderWorkbench()

    await selectRail('Git')

    const message = await within(drawer(container)).findByText('This folder is not a git repository.')
    expect(message).toBeTruthy()
    expect(within(drawer(container)).queryByText(/something went wrong/i)).toBeNull()
  })
})

describe('a row in the git panel', () => {
  it('opens the staged side of the change in the diff pane', async () => {
    const stub = stubWorkbench()
    // The diff pane is docked, because the rail opens with the dock closed and a change opened into a
    // pane that is not on screen is a read nobody makes — which is what this test is about.
    useWorkbenchStore.setState({ rightPanel: 'code' })
    const { container } = renderWorkbench()

    await selectRail('Git')
    await screen.findByText('Staged · 1')

    // The row, not the action beside it: the row states the whole path as its tooltip, and its
    // accessible name is the badge letter and the shortened path run together (`Msrc/staged.ts`),
    // which is a rendering detail rather than the row's identity. `Unstage src/staged.ts` is the
    // control that would move the change instead of opening it.
    const row = within(drawer(container)).getByTitle('src/staged.ts')
    await userEvent.click(row)

    // The pane is asked for the staged side of that file, and it renders what it was given.
    await waitFor(() => expect(stub.methodsOn('git')).toContain('diff'))
    const asked = stub.callsTo('git').find((call) => call.method === 'diff')
    expect(asked?.args[0]).toEqual({ rootPath: ROOT, path: 'src/staged.ts', side: 'staged' })
    expect(useWorkbenchStore.getState().selectedChange).toEqual({ path: 'src/staged.ts', side: 'staged' })
    expect(await screen.findByText('1 added, 0 removed')).toBeTruthy()
    // And the row says it is the one on screen, so the drawer and the pane agree about the selection.
    expect(row.getAttribute('aria-current')).toBe('true')
  })
})
