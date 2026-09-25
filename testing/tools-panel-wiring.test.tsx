/**
 * The tools resident: the right rail's fourth dock, and the Skills tab its panel hosts.
 *
 * Some of the rail's own claims are not repeated here, because `right-rail-docking.test.tsx` owns them
 * and now reads four residents: that a docked panel is handed the persisted inner share rather than a
 * default, and that the open state is memory only. What this file adds is what only a fourth resident
 * can show — that Tools joins the rail in the one order the registry states, docks at that same
 * persisted percentage, and that a relaunch hydrates nothing docked.
 *
 * The rest is the panel. Each claim is in the shape a reader would check by hand: the count in the tab
 * row comes from the listing, the search and the status filter narrow *rows*, and the window is five at
 * a time with a count line that names which rows it is holding.
 *
 * The availability toggle is the parity claim. The panel offers one write — the switch on a row — and it
 * has to be the Settings card's write rather than a second one: the same command, the same whole-record
 * payload, and the same confirm that says how many conversations are about to lose the skill.
 *
 * The manage button is a deep link. It opens the settings screen on its Skills section in one dispatch,
 * and the section is a memory of the visit rather than a preference: the back glyph returns to the
 * drawer view the visit took over, and nothing about the trip is written to storage.
 *
 * The listing is a fixture, and a small one on purpose: seven rows, so the second page is short by two
 * and the count line has a range to state. A scan is the node suites' subject.
 */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { percentSize, type LayoutSizes } from '@/app/components/workbench/layout'
import { queryClient } from '@/conveyor/client'
import type { SkillListing, SkillScope, SkillSummary, SkillTierId, SkillTierListing } from '@/conveyor/protocol/skills'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The resize primitive is stood in for, exactly as the other layout suites stand in for it: with the real
 * library in jsdom everything measures zero, so the declared sizes are replaced on the first layout effect
 * with `0px` on every panel. The stand-in records what the workbench passed, which is the claim — a docked
 * panel is handed the *persisted* share of the inner group. It keeps the library's own hooks, so the
 * panels are found the way the neighbouring suite finds them.
 */
const standIn = vi.hoisted(() => ({
  groups: new Map<string, { defaultLayout?: Record<string, number> }>(),
}))

vi.mock('@/app/components/ui/resizable', () => ({
  ResizablePanelGroup: ({
    id,
    defaultLayout,
    children,
  }: {
    id?: string
    defaultLayout?: Record<string, number>
    children?: ReactNode
  }) => {
    if (id) standIn.groups.set(id, { defaultLayout })
    return (
      <div data-group id={id}>
        {children}
      </div>
    )
  },
  ResizablePanel: ({ id, defaultSize, children }: { id?: string; defaultSize?: string; children?: ReactNode }) => (
    <div data-panel id={id} data-default-size={defaultSize}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'
const STORED_KEY = 'sam-ai-layout-preferences'
const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** One tier row, with the fields the panel reads filled in the way a scan fills them. */
function skill(tier: SkillTierId, id: string, title: string, summary: string): SkillSummary {
  const scope: SkillScope = tier.startsWith('project') ? 'project' : 'user'
  return { id, scope, tier, title, summary, tags: [], sourcePath: `${ROOT}/${tier}/${id}/SKILL.md` }
}

/**
 * Six skills and one file that would not load, with one of the skills switched off in the user's folder.
 *
 * Seven rows: five on the first page and two on the second. The word "copies" is in one summary and
 * nowhere else, and "gamma" is one id and its own title, so the search has a name match and a summary
 * match to tell apart rather than one substring that happens to be everywhere.
 */
const LISTING: SkillListing = {
  tiers: [
    {
      tier: 'project-native',
      scope: 'project',
      kind: 'native',
      sourceDir: `${ROOT}/.sam/skills`,
      skills: [
        skill('project-native', 'code-review', 'Code Review', 'Review a diff before it lands.'),
        skill('project-native', 'release-notes', 'Release Notes', 'How to ship a release.'),
        skill('project-native', 'alpha', 'Alpha', 'The first letter.'),
      ],
    },
    { tier: 'project-compat', scope: 'project', kind: 'compat', sourceDir: `${ROOT}/.agents/skills`, skills: [] },
    {
      tier: 'user-native',
      scope: 'user',
      kind: 'native',
      sourceDir: 'C:/u/era/skills',
      skills: [
        skill('user-native', 'deploy-runbook', 'Deploy Runbook', 'Ship it, then watch the logs.'),
        skill('user-native', 'echo', 'Echo', 'Copies the last line.'),
        skill('user-native', 'gamma', 'Gamma', 'The third letter.'),
      ],
    },
    { tier: 'user-compat', scope: 'user', kind: 'compat', sourceDir: 'C:/Users/me/.agents/skills', skills: [] },
  ] as SkillTierListing[],
  errors: [
    {
      id: 'broken-one',
      scope: 'project',
      tier: 'project-native',
      code: 'SKILL_MANIFEST_INVALID',
      message: 'The manifest block is not readable.',
    },
  ],
  disabled: [{ tier: 'user-native', rootPath: null, skillId: 'gamma' }],
  counts: { total: 6, project: 3, user: 3, errors: 1, hidden: 1 },
}

/** One conversation, holding one project skill — what the disable confirm has to be able to name. */
function sessionStore() {
  return {
    sessions: [
      {
        id: SESSION_ID,
        title: 'the parser drops newlines',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        rootPath: ROOT,
        activeSkillIds: ['code-review'],
      },
    ],
    activeId: SESSION_ID,
  }
}

/**
 * The whole workbench, over the folder the fixture describes.
 *
 * The window is windowed — the state the app opens — and every read a pane makes is answered in the
 * smallest way that lets it draw: the explorer, the changes panel and the provider lists are not this
 * file's subject, and an unstubbed query is noise in the middle of a panel claim.
 */
function stubWorkbench(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
  const stub = createBridgeStub({
    isMaximized: () => false,
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    listFilesFlat: () => [],
    listSkills: () => LISTING,
    setSkillAvailability: () => ({ disabled: [] }),
    ...overrides,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, sessionStore())
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

/** The right rail, by the name it states to everything that is not a pointer. */
function rightRail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Right rail' })
}

/** One of the right rail's residents, by its label. */
function resident(label: string): HTMLElement {
  return within(rightRail()).getByRole('button', { name: label })
}

/** One of the left rail's controls, by the view it names. */
function railControl(label: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Workbench' })).getByRole('button', { name: label })
}

/** The inner group's own columns: the chat, and the docked panel while there is one. */
function innerColumns(container: HTMLElement): { id: string; defaultSize: string | null }[] {
  const group = container.querySelector<HTMLElement>('[data-group]#workbench-main')
  if (!group) throw new Error('no inner group in the rendered workbench')
  return [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')].map((panel) => ({
    id: panel.id,
    defaultSize: panel.getAttribute('data-default-size'),
  }))
}

/** The docked panel's node, or null while the right rail is alone. */
function docked(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-panel]#code')
}

/** Every row the panel is drawing, in the order it drew them. */
function rowsOf(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="skill-panel-row"]')]
}

/** The ids those rows are about, which is what a filter claim is really about. */
function rowIds(): string[] {
  return rowsOf().map((row) => row.getAttribute('data-row-id') ?? '?')
}

/** The ranged count line under the list. */
function countLine(): string {
  return document.querySelector('[data-slot="tools-skills-range"]')?.textContent ?? ''
}

/** The panel's own surface, waited for rather than assumed: the dock renders on a query. */
async function dockTools(): Promise<void> {
  await userEvent.click(resident('Tools'))
  await screen.findByLabelText('Search skills')
}

/**
 * Choose one value of the status filter.
 *
 * Opened from the keyboard for the reason the model-picker suite opens its own combobox that way: a Radix
 * trigger opens on a click only when the pointer event carries a mouse type, and jsdom's carries none.
 */
async function chooseStatus(label: string): Promise<void> {
  const trigger = screen.getByRole('combobox', { name: 'Filter by status' })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const option = (await screen.findAllByRole('option')).find((candidate) => (candidate.textContent ?? '') === label)
  if (!option) throw new Error(`no status option named ${label}`)
  await userEvent.click(option)
}

beforeEach(() => {
  standIn.groups.clear()
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    settingsSection: 'providers',
    settingsReturnView: null,
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

describe('the tools resident', () => {
  it('is the rail’s fourth, in order and unpressed, and docks at the persisted inner percentage', async () => {
    // A set dragged in this window state, which is what "the persisted inner percentage" means: the dock
    // reads a share that was chosen rather than the default the group would have opened with.
    const dragged: LayoutSizes = { outer: { drawer: 34, main: 66 }, main: { chat: 41, viewer: 59 } }
    stubWorkbench()
    act(() => useWorkbenchStore.getState().saveLayout('windowed', dragged))

    const { container } = renderWorkbench()

    const buttons = [...rightRail().querySelectorAll('button')]
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Code', 'Preview', 'Terminal', 'Tools'])
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'false'])

    await dockTools()

    expect(innerColumns(container)).toEqual([
      { id: 'chat', defaultSize: percentSize(41) },
      { id: 'code', defaultSize: percentSize(59) },
    ])
    expect(resident('Tools').getAttribute('aria-pressed')).toBe('true')
    // The resident's own surface, so "it docked" is about content rather than about a slot id.
    expect(document.querySelector('[data-slot="tools-tabs"]')).not.toBeNull()
    // And the dock wrote nothing into either layout set: the share it took was already stored.
    expect(JSON.parse(localStorage.getItem(STORED_KEY) ?? '{}')).toEqual({ layoutWindowed: dragged })
  })

  it('returns to the rail on a second click, and a relaunch hydrates nothing docked', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await dockTools()
    expect(docked(container)).not.toBeNull()

    await userEvent.click(resident('Tools'))
    expect(docked(container)).toBeNull()
    expect(innerColumns(container)).toEqual([{ id: 'chat', defaultSize: percentSize(100) }])
    expect(useWorkbenchStore.getState().rightPanel).toBeNull()
    // A way of looking at the file in front of you is not a preference, so nothing was written on the way.
    expect(localStorage.getItem(STORED_KEY)).toBeNull()

    // A launch is the module graph evaluated again, which is how the other launch claims are reached.
    vi.resetModules()
    const freshStore = await import('@/app/components/workbench/store')
    expect(freshStore.useWorkbenchStore.getState().rightPanel).toBeNull()

    stubWorkbench()
    const { Workbench: FreshWorkbench } = await import('@/app/components/workbench/workbench')
    const freshClient = await import('@/conveyor/client')

    const fresh = render(
      <QueryClientProvider client={freshClient.queryClient}>
        <FreshWorkbench />
      </QueryClientProvider>
    )

    expect(freshStore.useWorkbenchStore.getState().rightPanel).toBeNull()
    expect(fresh.container.querySelector('[data-panel]#code')).toBeNull()
    expect(innerColumns(fresh.container)).toEqual([{ id: 'chat', defaultSize: percentSize(100) }])
  })
})

describe('the Skills tab', () => {
  it('states the listing’s count in the tab row, and narrows rows by name and by summary', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()

    // The count is the listing's, not the page's: six skills, one of them hidden, and the file that would
    // not load is neither of those numbers.
    expect(document.querySelector('[data-slot="tools-skills-count"]')?.textContent).toBe('6')
    // And the rows are the first page of the whole list, error first.
    expect(rowIds()).toEqual(['broken-one', 'code-review', 'release-notes', 'alpha', 'deploy-runbook'])

    const search = screen.getByLabelText('Search skills')
    await userEvent.type(search, 'gamma')
    expect(rowIds()).toEqual(['gamma'])

    await userEvent.clear(search)
    // A summary match, and one no id or title would have found.
    await userEvent.type(search, 'copies')
    expect(rowIds()).toEqual(['echo'])

    await userEvent.clear(search)
    await userEvent.type(search, 'nothing-like-this')
    expect(rowsOf()).toEqual([])
    // One line, and it says what was typed rather than only that something did not match.
    expect(document.querySelector('[data-slot="tools-skills-nomatch"]')?.textContent).toContain('nothing-like-this')
  })

  it('keeps the rows one status names: available, hidden, or the files that would not load', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()

    expect(rowsOf()).toHaveLength(5)

    await chooseStatus('Hidden')
    expect(rowIds()).toEqual(['gamma'])
    expect(countLine()).toBe('1 of 1')

    await chooseStatus('Load error')
    expect(rowIds()).toEqual(['broken-one'])
    expect(countLine()).toBe('1 of 1')

    await chooseStatus('Available')
    // Both rows the status rules out are gone — the file that would not load is not an available skill
    // either — and the count line is a range of five rather than of seven.
    expect(rowIds()).toEqual(['code-review', 'release-notes', 'alpha', 'deploy-runbook', 'echo'])
    expect(countLine()).toBe('1–5 of 5')

    await chooseStatus('All statuses')
    expect(countLine()).toBe('1–5 of 7')
  })

  it('draws five rows with the ranged count line, and advances to the short last page', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()

    expect(rowsOf()).toHaveLength(5)
    expect(countLine()).toBe('1–5 of 7')
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))

    // The last page is partial, and the line names the two rows it is holding rather than how many pages
    // there are.
    expect(rowIds()).toEqual(['echo', 'gamma'])
    expect(countLine()).toBe('6–7 of 7')
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(rowsOf()).toHaveLength(5)
    expect(countLine()).toBe('1–5 of 7')
  })
})

describe('a row’s availability', () => {
  /** The panel's row for one skill id, once it has been drawn. */
  async function rowFor(id: string): Promise<HTMLElement> {
    return waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-slot="skill-panel-row"][data-row-id="${id}"]`)
      if (!node) throw new Error(`no panel row for ${id} yet`)
      return node
    })
  }

  /** The payload of the one availability write this panel has dispatched. */
  function availabilityPayload(stub: BridgeStub): unknown {
    const call = stub.callsTo('skills').find((entry) => entry.method === 'setSkillAvailability')
    if (!call) throw new Error('no setSkillAvailability call')
    return call.args[0]
  }

  it('switches a row off through the settings command, naming the conversation that loses it', async () => {
    const stub = stubWorkbench()
    renderWorkbench()
    await dockTools()

    // How many reads the dock itself cost is the dock's business; what matters is that the write added a
    // read rather than the panel patching its own list from the answer to the write.
    const readsBefore = stub.methodsOn('skills').filter((method) => method === 'listSkills').length

    await userEvent.click(within(await rowFor('code-review')).getByRole('switch'))

    const dialog = await screen.findByRole('alertdialog')
    // One conversation holds it in this fixture, and the confirm is the Settings card's own sentence.
    expect(dialog.textContent).toContain('1 conversation')
    expect(dialog.textContent).toMatch(/will drop it/i)

    await userEvent.click(within(dialog).getByRole('button', { name: /turn it off/i }))
    await waitFor(() => expect(stub.methodsOn('skills')).toContain('setSkillAvailability'))
    // The whole record rather than a count of clicks, and the tier the row came from rather than a scope.
    expect(availabilityPayload(stub)).toEqual({
      scope: 'project',
      tier: 'native',
      skillId: 'code-review',
      disabled: true,
    })
    // The list is the disk's answer, so it is asked for again rather than patched in the renderer.
    await waitFor(() =>
      expect(stub.methodsOn('skills').filter((method) => method === 'listSkills').length).toBe(readsBefore + 1)
    )
  })

  it('switches a hidden row back on without naming any conversation', async () => {
    const stub = stubWorkbench()
    renderWorkbench()
    await dockTools()
    await chooseStatus('Hidden')

    await userEvent.click(within(await rowFor('gamma')).getByRole('switch'))

    const dialog = await screen.findByRole('alertdialog')
    // Becoming available takes nothing from anybody, and saying "0 conversations" would suggest otherwise.
    expect(dialog.textContent).not.toMatch(/conversations/i)

    await userEvent.click(within(dialog).getByRole('button', { name: /turn it on/i }))
    await waitFor(() => expect(stub.methodsOn('skills')).toContain('setSkillAvailability'))
    expect(availabilityPayload(stub)).toEqual({ scope: 'user', tier: 'native', skillId: 'gamma', disabled: false })
  })
})

describe('the manage button', () => {
  it('opens Settings on the Skills section, and the back glyph returns to the drawer view it left', async () => {
    stubWorkbench()
    renderWorkbench()

    // A view other than the conversation, so "back" has a different place to go to than the fallback. The
    // drawer's activity is named for the tree it shows rather than for the rail button that opens it.
    await userEvent.click(railControl('Explorer'))
    await dockTools()

    await userEvent.click(screen.getByRole('button', { name: 'Manage Skills' }))

    // One dispatch: the screen, the section it lands on, and the view the visit took over.
    expect(useWorkbenchStore.getState().activeActivity).toBe('settings')
    expect(useWorkbenchStore.getState().settingsSection).toBe('skills')
    expect(useWorkbenchStore.getState().settingsReturnView).toBe('files')
    await screen.findByRole('heading', { name: 'Skills' })
    expect(screen.getByRole('tab', { name: 'Skills' }).getAttribute('aria-selected')).toBe('true')
    // The section a visit landed on is a memory, not a preference, so nothing was written for it.
    expect(localStorage.getItem(STORED_KEY)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Back' }))

    expect(useWorkbenchStore.getState().activeActivity).toBe('files')
    expect(useWorkbenchStore.getState().settingsReturnView).toBeNull()
    // And the dock is where it was left: which panel is open is a way of looking at the drawer's view, not
    // one of the views.
    expect(useWorkbenchStore.getState().rightPanel).toBe('tools')
    await screen.findByLabelText('Search skills')
  })
})
