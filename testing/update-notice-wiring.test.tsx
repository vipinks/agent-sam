import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import type { UpdateStatusState } from '@/conveyor/stores/update-status'
import { UPDATES_DOWNLOAD_FAILED, UPDATE_STATES } from '@/conveyor/protocol/updates'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The update-ready notice: the one surface that interrupts, and how it is silenced.
 *
 * A downloaded update installs on quit by itself, so this notice is not what makes the update happen —
 * it is what tells the user it already has, while offering to stop waiting. That is the whole reason it
 * is announced at exactly one state: `ready`. Every other state of the updater is either ordinary
 * background work or already reported in the Updates section, and a card that spoke for those would be
 * interrupting a user to tell them nothing they can act on.
 *
 * It is mounted in the workbench rather than in a panel, and this file renders the workbench whole to
 * prove it: the notice has to be able to reach a user who is looking at the conversation, the explorer
 * or a document — not only the one who happens to be in Settings. The rendering is done over a folder
 * with one file in it, so nothing here is a stand-in for the app's own layout.
 *
 * Two silences are asserted, and they are different claims:
 *
 * - In development the notice never appears at all, because nothing ever tells the mirror an update is
 *   ready. That is the updater module's refusal — `conveyor/modules/updates.ts` wires nothing outside a
 *   packaged build — and what this file can show is the consequence: no state but `ready` draws a card.
 * - In a packaged build, a `ready` a user has already dismissed stays dismissed for the rest of the
 *   launch. The dismissal is the notice's own memory, held for as long as the shell that draws it lives,
 *   so a second transition into `ready` — or any re-render of the shell — must not bring it back.
 *
 * jsdom proves the wiring and the words, not the pixels. Whether the card sits where a person notices it
 * without it covering their work, in either theme, is the reviewer's eyes.
 */

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'

/** One provider that ships, because the Settings screen this file clicks through draws the provider row. */
const DEEPSEEK = { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }

/** The status store's state, as the mirror hands it to the notice. */
function statusState(over: Partial<UpdateStatusState> = {}): UpdateStatusState {
  return {
    state: 'idle',
    availableVersion: null,
    currentVersion: '1.2.0',
    lastCheckedAt: null,
    errorCode: null,
    ...over,
  }
}

/**
 * The whole workbench over a folder with one file in it.
 *
 * Every read is answered emptily except the two the shell needs to draw: the provider list the Settings
 * screen renders, and the folder itself. The update status store is seeded by each test with the state it
 * is about, because the notice reads nothing else.
 */
function stubWorkbench(status: UpdateStatusState = statusState()): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    readFile: () => ({ path: TEXT_PATH, content: 'just words\n', baselineMtime: 0 }),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [DEEPSEEK],
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    listFilesFlat: () => [],
    listServers: () => ({ user: [], project: [], errors: [] }),
    listRunningTools: () => [],
    // The three acts the notice and the section can ask for. They answer emptily: the updater is a
    // packaged build's business, and what is asserted here is which act a click reached.
    check: () => undefined,
    download: () => undefined,
    install: () => undefined,
  })
  stubStore(stub, 'update-status', status)
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

/** Return the notice from the mirror's state: the card is drawn by the store, not by a click. */
function pushStatus(stub: BridgeStub, status: UpdateStatusState) {
  stubStore(stub, 'update-status', status)
}

/** The notice's own wrapper, or null while nothing is announced. */
function notice(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="update-ready-notice"]')
}

/** The notice, or a failure — every case that reads inside it has already proved it is drawn. */
function drawnNotice(): HTMLElement {
  const node = notice()
  if (!node) throw new Error('the update-ready notice is not drawn')
  return node
}

/** The methods the shell called on the updates module, in order. */
function updateMethods(stub: BridgeStub): string[] {
  return stub.methodsOn('updates')
}

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's, and the store is module-level: a case that left the workbench in
  // Settings would otherwise decide the next one's first paint.
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    settingsReturnView: null,
    settingsSection: 'providers',
    drawerCollapsed: false,
  })
})

describe('the update-ready notice', () => {
  it('announces a downloaded update, with the install it offers and the way to silence it', async () => {
    const stub = stubWorkbench()
    renderWorkbench()
    // The shell is up, and nothing has happened: a window that has never heard from the updater is silent.
    await screen.findByRole('navigation', { name: 'Workbench' })
    expect(notice()).toBeNull()

    pushStatus(stub, statusState({ state: 'ready', availableVersion: '1.3.0' }))

    await waitFor(() => expect(notice()).not.toBeNull())
    // The words say what has happened and what the user can do about it — not what the app is doing, which
    // is the status line's job one screen away.
    expect(drawnNotice().textContent).toContain('Update ready — restart to install')

    // The action is the install, and it is the same act the Updates section offers: one dispatcher, two
    // surfaces, so a click here cannot do something a click there would not.
    await userEvent.click(within(drawnNotice()).getByRole('button', { name: 'Install and restart' }))
    await waitFor(() => expect(updateMethods(stub)).toContain('install'))

    // A dismissal is a real control with a name of its own, rather than only the shell's own chrome.
    expect(within(drawnNotice()).getByRole('button', { name: 'Dismiss update notice' })).toBeTruthy()
  })

  it('draws nothing for every state that is not a downloaded update', async () => {
    const stub = stubWorkbench(statusState({ state: 'idle' }))
    renderWorkbench()
    await screen.findByRole('navigation', { name: 'Workbench' })

    // In development the mirror sits at `idle` for the life of the launch, so this walk is also what the
    // app does in every `npm run dev`: nothing is announced, because nothing was ever downloaded.
    for (const state of UPDATE_STATES) {
      pushStatus(stub, statusState({ state, errorCode: state === 'error' ? UPDATES_DOWNLOAD_FAILED : null }))
      // A state that is not `ready` is drawn as no card at all, which is what makes the one card mean
      // something. `available` and `downloading` included: the updater's own progress is not news.
      expect(notice()).toBeNull()
    }
  })

  it('stays silent after a dismissal, for the rest of the launch', async () => {
    const stub = stubWorkbench(statusState({ state: 'ready', availableVersion: '1.3.0' }))
    renderWorkbench()
    await screen.findByRole('navigation', { name: 'Workbench' })
    await waitFor(() => expect(notice()).not.toBeNull())

    await userEvent.click(within(drawnNotice()).getByRole('button', { name: 'Dismiss update notice' }))
    await waitFor(() => expect(notice()).toBeNull())

    // A second transition into `ready` — the updater reporting the same update again, or a newer one —
    // arrives on the same channel the first one did, so the mirror is live here. The card must not come
    // back: a user who has read the news has read it.
    pushStatus(stub, statusState({ state: 'checking' }))
    pushStatus(stub, statusState({ state: 'ready', availableVersion: '1.3.1' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notice()).toBeNull()

    // And the same is true through a re-render of the shell, which is the honest reading of "this launch"
    // rather than of "this tick": the dismissal is remembered while the shell lives, so a user moving
    // between the conversation and Settings does not get told again.
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await waitFor(() => expect(document.querySelector('[data-slot="settings-rail"]')).not.toBeNull())
    expect(notice()).toBeNull()
  })
})
