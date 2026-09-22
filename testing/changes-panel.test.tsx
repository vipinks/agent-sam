import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { GitPanel } from '@/app/components/workbench/git-panel'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { ConveyorError } from 'electron-conveyor/react'
import { queryClient } from '@/conveyor/client'
import type { GitStatusEntry } from '@/conveyor/protocol/git'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The Changes section, as wiring rather than as rules.
 *
 * Every rule this exercises — which group a row belongs to, what letter it shows, what a failure says
 * — is tested directly in `changes-rules.test.ts`. What is left here is the part a rule test cannot
 * see: whether the section asks the registered queries, whether a click reaches the right command
 * with the right arguments, and whether the not-a-repository state is a state rather than an error.
 *
 * Render GitPanel rather than the section alone, because that is what the app renders: the section is
 * the git rail item's panel body, and the folder it reports on arrives from the same panel the way it
 * does in the app.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payloads asserted below are
 * the payloads main would receive.
 */

const ROOT = 'C:/w'

const STATUS: GitStatusEntry[] = [
  { path: 'src/staged.ts', indexState: 'M', worktreeState: '.', kind: 'ordinary' },
  { path: 'src/edited.ts', indexState: '.', worktreeState: 'M', kind: 'ordinary' },
  { path: 'src/both.ts', indexState: 'M', worktreeState: 'M', kind: 'ordinary' },
  { path: 'src/new.ts', indexState: '?', worktreeState: '?', kind: 'untracked' },
]

/**
 * A repository with the open folder already set.
 *
 * The root arrives through the workspace store, which is a cross-window store main owns: seeding it
 * is what puts the explorer in the state of having a folder open.
 */
function stubRepo(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    status: () => STATUS,
    branch: () => ({ name: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1 }),
    log: () => [{ hash: 'a1b2c3d', subject: 'feat(workbench): add a panel' }],
    localBranches: () => ['main', 'feature/panel'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    stage: () => ({ staged: 1 }),
    unstage: () => ({ unstaged: 1 }),
    commit: () => ({ committed: true }),
    discardWorktree: () => ({ discarded: [], failed: [] }),
    ...overrides,
  })
  // Seeded with the shape main delivers whole: the store's persisted state is merged over its initial
  // state, so a mirror that omitted `recentRoots` would not be a state main can produce.
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  setActiveStub(stub)
  return stub
}

/** Render the git panel, which is where the section lives. */
function renderGitPanel() {
  return render(
    <QueryClientProvider client={queryClient}>
      <GitPanel />
    </QueryClientProvider>
  )
}

function renderViewer() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CodeViewer />
    </QueryClientProvider>
  )
}

/**
 * The store outlives a test, so a selection from one must not leak into the next — and so does the
 * query cache.
 *
 * The cache is shared on purpose. The app's client is created once with the QueryClient from
 * `conveyor/client.ts`, and `invalidate()` invalidates against that captured instance rather than
 * against whatever client a component happens to be under — so a suite that wrapped these components
 * in a fresh client would observe no refetch at all, and would be testing a wiring the app does not
 * use. `clear()` between tests keeps that honest: every test starts with an empty cache.
 */
beforeEach(() => {
  useWorkbenchStore.setState({ selectedFile: null, selectedChange: null, commitMessage: '' })
  queryClient.clear()
})

describe('the changes section', () => {
  it('renders the branch, its divergence, and both groups', async () => {
    stubRepo()
    renderGitPanel()

    // The branch line, with the counts the upstream block reported. `getAllByText` because the name
    // is also one of the entries in the branch picker, which is a different thing on screen.
    expect((await screen.findAllByText('main')).length).toBeGreaterThan(0)
    expect(screen.getByText('2 ahead, 1 behind')).toBeTruthy()

    // Grouped by side: two rows are staged (the staged edit and the file that is both), and three
    // are unstaged (the worktree edit, the same both-sides file, and the untracked one) — so the
    // file that is both appears in both lists, which is the case a single status letter loses.
    expect(screen.getByText('Staged · 2')).toBeTruthy()
    expect(screen.getByText('Changes · 3')).toBeTruthy()
    expect(screen.getAllByLabelText('Unstage src/both.ts').length).toBe(1)
    expect(screen.getAllByLabelText('Stage src/both.ts').length).toBe(1)
  })

  it('stages the row that was clicked, naming that path and no other', async () => {
    const stub = stubRepo()
    renderGitPanel()

    await userEvent.click(await screen.findByLabelText('Stage src/edited.ts'))

    await waitFor(() => expect(stub.methodsOn('git')).toContain('stage'))
    // The payload main validates: the open root, and exactly the one path.
    const staged = stub.callsTo('git').find((call) => call.method === 'stage')
    expect(staged?.args[0]).toEqual({ rootPath: ROOT, paths: ['src/edited.ts'] })
  })

  it('unstages a staged row', async () => {
    const stub = stubRepo()
    renderGitPanel()

    await userEvent.click(await screen.findByLabelText('Unstage src/staged.ts'))

    await waitFor(() => expect(stub.methodsOn('git')).toContain('unstage'))
    const unstaged = stub.callsTo('git').find((call) => call.method === 'unstage')
    expect(unstaged?.args[0]).toEqual({ rootPath: ROOT, paths: ['src/staged.ts'] })
  })

  it('sends the commit message that was typed', async () => {
    const stub = stubRepo()
    renderGitPanel()

    const box = await screen.findByLabelText('Commit message')
    await userEvent.type(box, 'feat(git): a message')
    await userEvent.click(screen.getByLabelText('Commit staged changes'))

    await waitFor(() => expect(stub.methodsOn('git')).toContain('commit'))
    const committed = stub.callsTo('git').find((call) => call.method === 'commit')
    expect(committed?.args[0]).toEqual({ rootPath: ROOT, message: 'feat(git): a message' })

    // The box is emptied on success, so the next commit does not repeat this message.
    await waitFor(() => expect((screen.getByLabelText('Commit message') as HTMLInputElement).value).toBe(''))
  })

  it('will not commit an empty message or with nothing staged', async () => {
    stubRepo({ status: () => [STATUS[1]] })
    renderGitPanel()

    const button = (await screen.findByLabelText('Commit staged changes')) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await userEvent.type(screen.getByLabelText('Commit message'), 'something')
    // Still disabled: the message is there but nothing is staged, and there is nothing to commit.
    expect((screen.getByLabelText('Commit staged changes') as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks before discarding, naming the paths', async () => {
    const stub = stubRepo()
    renderGitPanel()

    await userEvent.click(await screen.findByLabelText('Discard changes to src/edited.ts'))

    // The confirmation names the file rather than counting them: "discard 1 file" does not tell the
    // user whether the file they care about is the one.
    expect(await screen.findByText('Discard changes to these files?')).toBeTruthy()
    // Scoped to the dialog: the same path is also on the row that opened it, and the assertion is
    // about what the confirmation says it is going to do.
    const dialog = within(screen.getByRole('alertdialog'))
    expect(dialog.getByText('src/edited.ts')).toBeTruthy()
    // Nothing has been discarded yet — the dialog is the decision point.
    expect(stub.methodsOn('git')).not.toContain('discardWorktree')

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(stub.methodsOn('git')).toContain('discardWorktree'))
    const discarded = stub.callsTo('git').find((call) => call.method === 'discardWorktree')
    expect(discarded?.args[0]).toEqual({ rootPath: ROOT, paths: ['src/edited.ts'] })
  })

  it('does nothing when the discard is cancelled', async () => {
    const stub = stubRepo()
    renderGitPanel()

    await userEvent.click(await screen.findByLabelText('Discard changes to src/edited.ts'))
    await userEvent.click(await screen.findByRole('button', { name: 'Keep them' }))

    await waitFor(() => expect(screen.queryByText('Discard changes to these files?')).toBeNull())
    expect(stub.methodsOn('git')).not.toContain('discardWorktree')
  })

  it('offers the refresh control, which asks git again', async () => {
    const stub = stubRepo()
    renderGitPanel()

    // Waited for rather than clicked straight away: the control is disabled while a read is in
    // flight, so a click before the first render settles would simply be ignored.
    await screen.findByText('Staged · 2')
    const before = stub.callsTo('git').filter((call) => call.method === 'status').length

    await userEvent.click(screen.getByLabelText('Refresh changes'))

    await waitFor(() => {
      const after = stub.callsTo('git').filter((call) => call.method === 'status').length
      expect(after).toBeGreaterThan(before)
    })
  })

  it('switches to a branch the repository actually has', async () => {
    const stub = stubRepo()
    renderGitPanel()

    await userEvent.selectOptions(await screen.findByLabelText('Switch branch'), 'feature/panel')

    await waitFor(() => expect(stub.methodsOn('git')).toContain('checkoutBranch'))
    const checkedOut = stub.callsTo('git').find((call) => call.method === 'checkoutBranch')
    expect(checkedOut?.args[0]).toEqual({ rootPath: ROOT, name: 'feature/panel' })
  })
})

describe('a workspace with no repository', () => {
  it('says so plainly rather than raising an error', async () => {
    // Exactly what main raises for a folder without one: a code, on the first read the panel makes.
    stubRepo({
      status: () => {
        throw new ConveyorError('GIT_NOT_REPO', 'This folder is not a git repository.')
      },
      branch: () => {
        throw new ConveyorError('GIT_NOT_REPO', 'This folder is not a git repository.')
      },
    })
    renderGitPanel()

    // A state, in our own words, with no toast and no retry for something that is not broken.
    expect(await screen.findByText('This folder is not a git repository.')).toBeTruthy()
    expect(screen.queryByText(/something went wrong/i)).toBeNull()
  })

  it('says git is missing when the binary is not there', async () => {
    stubRepo({
      status: () => {
        throw new ConveyorError('GIT_NOT_INSTALLED', 'Git is not installed, or is not on PATH.')
      },
      branch: () => {
        throw new ConveyorError('GIT_NOT_INSTALLED', 'Git is not installed, or is not on PATH.')
      },
    })
    renderGitPanel()

    expect(await screen.findByText('Git is not installed, or is not on your PATH.')).toBeTruthy()
  })
})

describe('the diff pane', () => {
  it('shows the diff for the selected change, from the side that was clicked', async () => {
    const stub = stubRepo({
      diff: (input) => {
        expect(input).toMatchObject({ rootPath: ROOT, path: 'src/both.ts', side: 'staged' })
        return { lines: [{ kind: 'added', text: 'two' }], added: 1, removed: 0, truncated: false }
      },
    })
    // What clicking the row does: the pane is asked for that change, on that side.
    useWorkbenchStore.setState({ selectedChange: { path: 'src/both.ts', side: 'staged' } })
    renderViewer()

    // Each line renders its marker and its text, so the row's own text is `+ two` rather than `two`.
    expect(await screen.findByText(/two/)).toBeTruthy()
    expect(screen.getByText('1 added, 0 removed')).toBeTruthy()
    // The side is named, because the same file can be open as two different questions.
    expect(stub.methodsOn('git')).toContain('diff')
  })

  it('renders its empty state when nothing is selected', async () => {
    stubRepo()
    renderViewer()

    expect(await screen.findByText('No file open')).toBeTruthy()
  })
})
