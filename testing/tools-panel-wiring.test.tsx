/**
 * The tools resident: the right rail's last dock, and the Skills tab its panel hosts.
 *
 * Some of the rail's own claims are not repeated here, because `right-rail-docking.test.tsx` owns them
 * and now reads four residents: that a docked panel is handed the persisted inner share rather than a
 * default, and that the open state is memory only. What this file adds is what only the last resident
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
 *
 * The MCP servers tab is the second turn's, and it is the same panel rather than a second one: the same
 * two reads, the same four-value status filter, the same five-row window, and the same one dispatch out.
 * What it adds to the tab row is a count of its own — the mirror store's, so it is stated before either
 * tab is visited — and what it must not add is any second write: the switch on a row dispatches the
 * settings section's own `setEnabled`, and nothing here starts or stops anything. The rows' rules are
 * `conveyor/protocol/mcp-panel.ts`'s, asserted directly in `tests/mcp/mcp-panel-test.ts`; what is here
 * is what only a render can show — which of those rows the panel draws, what each mark on one says, and
 * which of the two tabs a reader's own typing belongs to.
 */
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { percentSize, type LayoutSizes } from '@/app/components/workbench/layout'
import { queryClient } from '@/conveyor/client'
import { useMcpServersStore } from '@/conveyor/stores/mcp-servers'
import type { SkillListing, SkillScope, SkillSummary, SkillTierId, SkillTierListing } from '@/conveyor/protocol/skills'
import {
  activeStub,
  CHAT_SESSIONS_STORE_ID,
  createBridgeStub,
  setActiveStub,
  stubStore,
  type BridgeStub,
} from './bridge-stub'

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

/** One server, as `mcp.listServers` reports one: the fields the panel's rows read, and no secrets. */
function mcpServer(scope: 'user' | 'project', id: string, enabled: boolean, trust?: 'matched' | 'mismatched') {
  return {
    id,
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', `${id}-server`],
    cwd: null,
    env: {},
    enabled,
    scope,
    trust: scope === 'project' ? (trust ?? 'absent') : null,
    secrets: [],
    autoApprove: false,
  }
}

/**
 * Three of the user's servers and six of this folder's: nine rows, two pages, and every status present.
 *
 * `filesystem` and `github` are the two runners, one per scope; `playwright` and `legacy` are switched off,
 * one of them untrusted as well; `atlas` is running with no grant at all, which is the row that tells
 * "needs trust" apart from "running"; `notes` is the grant that no longer matches; and `memory` and
 * `serena` and `chrome-devtools` are the ordinary stopped rows the second page is made of.
 */
const MCP_LISTING = {
  user: [
    mcpServer('user', 'filesystem', true),
    mcpServer('user', 'memory', true),
    mcpServer('user', 'playwright', false),
  ],
  project: [
    mcpServer('project', 'github', true, 'matched'),
    mcpServer('project', 'atlas', true),
    mcpServer('project', 'notes', true, 'mismatched'),
    mcpServer('project', 'legacy', false),
    mcpServer('project', 'serena', true, 'matched'),
    mcpServer('project', 'chrome-devtools', true, 'matched'),
  ],
  errors: [],
}

/**
 * The live tool list, as `mcp.listRunningTools` reports it: which servers answer, and with how many tools.
 *
 * `atlas` is among them on purpose, so the tab has a running row whose status is still `needs-trust`.
 */
const MCP_TOOLS = [
  { serverId: 'filesystem', tool: { name: 'read_file' } },
  { serverId: 'filesystem', tool: { name: 'write_file' } },
  { serverId: 'github', tool: { name: 'search_issues' } },
  { serverId: 'github', tool: { name: 'create_issue' } },
  { serverId: 'github', tool: { name: 'list_branches' } },
  { serverId: 'atlas', tool: { name: 'lookup' } },
]

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
    // The two reads the MCP tab draws from, and the one write it has. The second tab forced these three
    // lines and no other change to this stub: the panel now refreshes the mirror when it opens — the
    // count in the tab row is the mirror's — so a docked Tools panel reaches for both reads whether or
    // not the MCP tab is ever opened, and a read with no handler would fail the dock rather than this
    // suite's claim about it.
    listServers: () => MCP_LISTING,
    listRunningTools: () => MCP_TOOLS,
    setEnabled: (input) => ({
      id: (input as { serverId: string }).serverId,
      enabled: (input as { enabled: boolean }).enabled,
    }),
    // The two process calls a row's control dispatches, which the panel did not make before this surface
    // had one: each answers the way main answers, so a click has somewhere to land. What the row reads
    // back is the *read's* answer rather than this call's — `MCP_TOOLS` above is fixed — which is why a
    // started row's glyph is the play the mirror still reports rather than a stop this stub implied.
    startServer: (input) => ({ id: (input as { serverId: string }).serverId, tools: [] }),
    stopServer: (input) => ({ id: (input as { serverId: string }).serverId, running: false }),
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
  // The MCP mirror is a renderer-side store rather than a mirrored one, so it outlives a test unless it
  // is put back: a listing left over from the case above would be drawn before this case's read lands.
  useMcpServersStore.setState({ loading: true, listing: null, running: [], error: null })
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
  it('is the rail’s last, in order and unpressed, and docks at the persisted inner percentage', async () => {
    // A set dragged in this window state, which is what "the persisted inner percentage" means: the dock
    // reads a share that was chosen rather than the default the group would have opened with.
    const dragged: LayoutSizes = { outer: { drawer: 34, main: 66 }, main: { chat: 41, viewer: 59 } }
    stubWorkbench()
    act(() => useWorkbenchStore.getState().saveLayout('windowed', dragged))

    const { container } = renderWorkbench()

    const buttons = [...rightRail().querySelectorAll('button')]
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Code', 'Preview', 'Overview', 'Tools'])
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

describe('the MCP servers tab', () => {
  /** One of the panel's own tabs, which the settings screen's row of tabs is not. */
  function panelTab(name: RegExp): HTMLElement {
    const list = document.querySelector<HTMLElement>('[data-slot="tools-tabs"]')
    if (!list) throw new Error('no tools tab row')
    return within(list).getByRole('tab', { name })
  }

  /** Every MCP row the panel is drawing, in the order it drew them. */
  function mcpRows(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>('[data-slot="mcp-panel-row"]')]
  }

  /** The ids those rows are about, which is what a filter claim is really about. */
  function mcpRowIds(): string[] {
    return mcpRows().map((row) => row.getAttribute('data-row-id') ?? '?')
  }

  /** The ranged count line under the MCP list. */
  function mcpCountLine(): string {
    return document.querySelector('[data-slot="tools-mcp-range"]')?.textContent ?? ''
  }

  /** One drawn MCP row, by the server it is about. */
  function mcpRow(id: string): HTMLElement {
    const row = document.querySelector<HTMLElement>(`[data-slot="mcp-panel-row"][data-row-id="${id}"]`)
    if (!row) throw new Error(`no MCP row for ${id}`)
    return row
  }

  /**
   * The one process control a row carries, by the server it is about.
   *
   * Found by its slot rather than by its label, because the label is one of the things under assertion:
   * the glyph the button draws, the word it says and the command it dispatches are three claims about one
   * node, and a helper that looked it up by the claim would fail as "not found" rather than as a wrong
   * word.
   */
  function processControl(id: string): HTMLButtonElement {
    const button = mcpRow(id).querySelector<HTMLButtonElement>('[data-slot="mcp-panel-process"]')
    if (!button) throw new Error(`no process control on ${id}`)
    return button
  }

  /** The second tab of the docked panel, open on its own read. */
  async function dockMcp(): Promise<void> {
    await userEvent.click(panelTab(/^MCP servers/))
    await screen.findByLabelText('Search MCP servers')
  }

  it('states both tabs with their own counts, and keeps each tab’s narrowing across a switch', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()

    // The tab row lists both, Skills first as shipped, and each count is of a whole listing rather than of
    // the page under it: six skills, and nine servers across the user's file and this folder's.
    const list = document.querySelector<HTMLElement>('[data-slot="tools-tabs"]')
    expect(
      within(list as HTMLElement)
        .getAllByRole('tab')
        .map((tab) => tab.getAttribute('data-slot'))
    ).toEqual(['tools-tab-skills', 'tools-tab-mcp'])
    expect(document.querySelector('[data-slot="tools-skills-count"]')?.textContent).toBe('6')
    // The MCP count is the mirror's, which is read when the panel opens rather than when its tab does:
    // a tab row stating one of its two counts would be a tab row that says half of what it knows.
    await waitFor(() => expect(document.querySelector('[data-slot="tools-mcp-count"]')?.textContent).toBe('9'))

    // The skills list, on its own second page.
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(rowIds()).toEqual(['echo', 'gamma'])
    expect(countLine()).toBe('6–7 of 7')

    // The other tab, narrowed its own way: a query that keeps six of its nine, and its second page.
    await dockMcp()
    await userEvent.type(screen.getByLabelText('Search MCP servers'), 'e')
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(mcpRowIds()).toEqual(['chrome-devtools'])
    expect(mcpCountLine()).toBe('6 of 6')

    // Back, and the page the reader left is the page they return to — with an empty search box, because a
    // query belongs to the tab it was typed in.
    await userEvent.click(panelTab(/^Skills/))
    expect(rowIds()).toEqual(['echo', 'gamma'])
    expect(countLine()).toBe('6–7 of 7')
    expect((screen.getByLabelText('Search skills') as HTMLInputElement).value).toBe('')

    // And the MCP tab's own query and page are still its own.
    await dockMcp()
    expect((screen.getByLabelText('Search MCP servers') as HTMLInputElement).value).toBe('e')
    expect(mcpRowIds()).toEqual(['chrome-devtools'])
    expect(mcpCountLine()).toBe('6 of 6')
  })

  it('draws each row’s id, scope, tool count and process control, and the trust chip only where it belongs', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()
    await dockMcp()

    // The first page of the whole list, in the order the settings section draws the same two reads in.
    expect(mcpRowIds()).toEqual(['filesystem', 'memory', 'playwright', 'github', 'atlas'])

    // A running user row: the id, the scope it came from, what the process is offering, and the one thing
    // the row can do about it — a Stop, which is the status drawn rather than written.
    const file = mcpRow('filesystem')
    expect(within(file).getByText('filesystem')).toBeTruthy()
    expect(within(file).getByText('User')).toBeTruthy()
    expect(within(file).getByText('2 tools')).toBeTruthy()
    expect(within(file).queryByText('Needs trust')).toBeNull()
    expect(processControl('filesystem').getAttribute('data-glyph')).toBe('stop')

    // The same marks on a trusted project server, with its own tool count and its own control.
    const github = mcpRow('github')
    expect(within(github).getByText('Project')).toBeTruthy()
    expect(within(github).getByText('3 tools')).toBeTruthy()
    expect(within(github).queryByText('Needs trust')).toBeNull()
    expect(processControl('github').getAttribute('data-glyph')).toBe('stop')

    // An enabled server with nothing behind it says so through the control and claims no count: a play,
    // and no process to have counted anything.
    expect(mcpRow('memory').textContent ?? '').not.toContain('tool')
    expect(processControl('memory').getAttribute('data-glyph')).toBe('play')

    // The chip: a project row whose grant is absent (`atlas`) carries it even though it is running, which
    // is the one thing a row's marks say that its status does not.
    expect(within(mcpRow('atlas')).getByText('Needs trust')).toBeTruthy()

    // A mismatched grant, and a switched-off untrusted row: both keep the chip behind whatever else the
    // row is about, and neither is a user row.
    await userEvent.type(screen.getByLabelText('Search MCP servers'), 'legacy')
    expect(mcpRowIds()).toEqual(['legacy'])
    expect(within(mcpRow('legacy')).getByText('Needs trust')).toBeTruthy()

    await userEvent.clear(screen.getByLabelText('Search MCP servers'))
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(within(mcpRow('notes')).getByText('Needs trust')).toBeTruthy()
    // A grant that still matches is not a chip, and neither is any user row.
    expect(within(mcpRow('serena')).queryByText('Needs trust')).toBeNull()
    expect(within(mcpRow('chrome-devtools')).queryByText('Needs trust')).toBeNull()
  })

  it('keeps the rows one status names: running, stopped, disabled, or the ones that need trust', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()
    await dockMcp()

    // `atlas` is running and is not in this first answer: the missing grant is what its row is about.
    await chooseStatus('Running')
    expect(mcpRowIds()).toEqual(['filesystem', 'github'])
    expect(mcpCountLine()).toBe('1–2 of 2')

    await chooseStatus('Stopped')
    expect(mcpRowIds()).toEqual(['memory', 'serena', 'chrome-devtools'])
    expect(mcpCountLine()).toBe('1–3 of 3')

    // A switched-off untrusted row is switched off, not needing trust: the flag decides first.
    await chooseStatus('Disabled')
    expect(mcpRowIds()).toEqual(['playwright', 'legacy'])

    await chooseStatus('Needs trust')
    expect(mcpRowIds()).toEqual(['atlas', 'notes'])
    expect(mcpCountLine()).toBe('1–2 of 2')

    await chooseStatus('All statuses')
    expect(mcpRows()).toHaveLength(5)
    expect(mcpCountLine()).toBe('1–5 of 9')
  })

  it('narrows by server id, case-insensitively, and says which query came back empty', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()
    await dockMcp()

    const search = screen.getByLabelText('Search MCP servers')
    await userEvent.type(search, 'GitHub')
    expect(mcpRowIds()).toEqual(['github'])

    await userEvent.clear(search)
    await userEvent.type(search, 'null')
    expect(mcpRows()).toEqual([])
    expect(document.querySelector('[data-slot="tools-mcp-nomatch"]')?.textContent).toContain('null')
    expect(mcpCountLine()).toBe('0 of 0')
  })

  it('draws five rows with the ranged count line, and advances to the short last page', async () => {
    stubWorkbench()
    renderWorkbench()
    await dockTools()
    await dockMcp()

    expect(mcpRows()).toHaveLength(5)
    expect(mcpCountLine()).toBe('1–5 of 9')
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }))

    // The last page is partial, and the line names the four rows it is holding.
    expect(mcpRowIds()).toEqual(['notes', 'legacy', 'serena', 'chrome-devtools'])
    expect(mcpCountLine()).toBe('6–9 of 9')
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(mcpRows()).toHaveLength(5)
    expect(mcpCountLine()).toBe('1–5 of 9')
  })

  it('switches a row off through the settings command, and asks for the list again', async () => {
    const stub = stubWorkbench()
    renderWorkbench()
    await dockTools()
    await dockMcp()

    const readsBefore = stub.methodsOn('mcp').filter((method) => method === 'listServers').length
    await userEvent.click(within(mcpRow('filesystem')).getByRole('switch'))

    await waitFor(() => expect(stub.methodsOn('mcp')).toContain('setEnabled'))
    // The whole write the settings section makes, and nothing else: no start, no stop, no trust, no secret.
    const write = stub.callsTo('mcp').find((entry) => entry.method === 'setEnabled')
    expect(write?.args[0]).toEqual({ scope: 'user', rootPath: ROOT, serverId: 'filesystem', enabled: false })
    expect(stub.methodsOn('mcp')).not.toContain('startServer')
    expect(stub.methodsOn('mcp')).not.toContain('stopServer')
    expect(stub.methodsOn('mcp')).not.toContain('setTrust')
    // The list is the disk's answer, so it is asked for again rather than patched here.
    await waitFor(() =>
      expect(stub.methodsOn('mcp').filter((method) => method === 'listServers').length).toBe(readsBefore + 1)
    )
  })

  it('switches a row back on, which is the same command with the row’s own scope and flag', async () => {
    const stub = stubWorkbench()
    renderWorkbench()
    await dockTools()
    await dockMcp()

    // A switched-off project row, found by id: the scope and the direction both travel from the row rather
    // than from anything this tab assumes about either.
    await userEvent.type(screen.getByLabelText('Search MCP servers'), 'legacy')
    expect(mcpRowIds()).toEqual(['legacy'])
    await userEvent.click(within(mcpRow('legacy')).getByRole('switch'))

    await waitFor(() => expect(stub.methodsOn('mcp')).toContain('setEnabled'))
    const write = stub.callsTo('mcp').find((entry) => entry.method === 'setEnabled')
    expect(write?.args[0]).toEqual({ scope: 'project', rootPath: ROOT, serverId: 'legacy', enabled: true })
  })

  it('says what the code means when the switch is refused', async () => {
    stubWorkbench({
      setEnabled: () => {
        throw new ConveyorError('MCP_CONFIG_INVALID', 'main says the record is malformed')
      },
    })
    renderWorkbench()
    await dockTools()
    await dockMcp()

    await userEvent.click(within(mcpRow('filesystem')).getByRole('switch'))

    // The sentence is chosen by the code rather than by main's message, and the row is left saying what it
    // said: the write did not happen.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tools-mcp-write-error"]')?.textContent).toBe(
        'This configuration is not one this app can run.'
      )
    )
  })

  it('opens Settings on the MCP Servers section, in one dispatch', async () => {
    stubWorkbench()
    renderWorkbench()

    // A view other than the conversation, so "back" has a different place to go to than the fallback.
    await userEvent.click(railControl('Explorer'))
    await dockTools()
    await dockMcp()

    await userEvent.click(screen.getByRole('button', { name: 'Manage MCPs' }))

    expect(useWorkbenchStore.getState().activeActivity).toBe('settings')
    expect(useWorkbenchStore.getState().settingsSection).toBe('mcp-servers')
    expect(useWorkbenchStore.getState().settingsReturnView).toBe('files')
    await screen.findByRole('heading', { name: 'MCP servers' })
    expect(screen.getByRole('tab', { name: 'MCP Servers' }).getAttribute('aria-selected')).toBe('true')
    // The section a visit landed on is a memory, not a preference, so nothing was written for it.
    expect(localStorage.getItem(STORED_KEY)).toBeNull()
  })

  it('says what the code means when the whole listing could not be read', async () => {
    stubWorkbench({
      listServers: () => {
        throw new ConveyorError('MCP_CONFIG_INVALID', 'main says the file is not JSON')
      },
    })
    renderWorkbench()
    await dockTools()
    await dockMcp()

    // The code-branched sentence, which is the settings section's own wording for the same code rather
    // than a second copy of it — the shared map is `mcp-notices.ts`, and one code cannot come to mean two
    // things depending on which surface was open when the read failed.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tools-mcp-read-error"]')?.textContent).toBe(
        'This configuration could not be read, so the server lists may be incomplete.'
      )
    )
    // No list at all is not an empty list: the failure is the whole answer, and there are no rows to page.
    expect(mcpRows()).toEqual([])
  })

  it('falls back to the plain sentence for a failure that carries no code of ours', async () => {
    stubWorkbench({ listServers: () => Promise.reject(new Error('the bridge is gone')) })
    renderWorkbench()
    await dockTools()
    await dockMcp()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="tools-mcp-read-error"]')?.textContent).toBe(
        'The server lists could not be read. The last answer is still shown.'
      )
    )
  })

  /**
   * A row's one process control: which glyph it draws, what it names, and the command a click sends.
   *
   * Which of the four states a row's facts produce is `conveyor/protocol/mcp-panel.ts`'s rule, asserted
   * without a render in `tests/mcp/mcp-panel-button-test.ts`. What is here is what only a render can show:
   * that the row carries the control the rule describes, that pressing it dispatches the traced conveyor
   * action with the settings section's own payload, and that the enable switch beside it still means what
   * it meant. The words this suite reads are the button's label, not a status: nothing on the rail states
   * what a server is doing in text, which is the claim the last case here pins.
   */
  describe('a row’s process control', () => {
    /**
     * The bridge call on one mcp method, in order, which is what a "dispatched once" claim is about.
     *
     * Counted rather than looked up as the first one: a row that fired twice would still have a first
     * call whose payload is right, and the count is the half of that claim a single lookup cannot make.
     */
    function callsOn(method: string): number {
      return activeStub()
        .methodsOn('mcp')
        .filter((called) => called === method).length
    }

    it('starts a stopped server through the settings command, naming the action and the server', async () => {
      const stub = stubWorkbench()
      renderWorkbench()
      await dockTools()
      await dockMcp()

      // A row with nothing behind it offers the start, and says so in the two places a reader can reach:
      // the label everything hears, and the tooltip a pointer sees. Neither states a status.
      const control = processControl('memory')
      expect(control.getAttribute('data-glyph')).toBe('play')
      expect(control.getAttribute('aria-label')).toBe('Start memory')
      expect(control.getAttribute('title')).toBe('Start memory')
      expect(control.disabled).toBe(false)

      const readsBefore = callsOn('listServers')
      await userEvent.click(control)

      // One dispatch, and the settings section's payload exactly: the row's own scope, the folder that is
      // open, and the id. A second payload shape for the same command is how two surfaces start to mean
      // different things.
      await waitFor(() => expect(callsOn('startServer')).toBe(1))
      expect(stub.callsTo('mcp').find((call) => call.method === 'startServer')?.args[0]).toEqual({
        scope: 'user',
        rootPath: ROOT,
        serverId: 'memory',
      })
      expect(callsOn('stopServer')).toBe(0)
      expect(callsOn('setEnabled')).toBe(0)

      // And the list is asked for again, because the running set is main's answer rather than this
      // click's memory of it — the glyph has to follow a process that started, not an intention that it had.
      await waitFor(() => expect(callsOn('listServers')).toBe(readsBefore + 1))
      // What the mirror reports decides the glyph, so a server the read still calls stopped is a play.
      expect(processControl('memory').getAttribute('data-glyph')).toBe('play')
    })

    it('stops a running server through the settings command, and sends the id alone', async () => {
      const stub = stubWorkbench()
      renderWorkbench()
      await dockTools()
      await dockMcp()

      const control = processControl('filesystem')
      expect(control.getAttribute('data-glyph')).toBe('stop')
      expect(control.getAttribute('aria-label')).toBe('Stop filesystem')

      await userEvent.click(control)

      await waitFor(() => expect(callsOn('stopServer')).toBe(1))
      // The stop takes the id and nothing else, as the settings section's own Stop does: scope and folder
      // are what a start needs, and a stop that asked for them would be reading a file to kill a process.
      expect(stub.callsTo('mcp').find((call) => call.method === 'stopServer')?.args[0]).toEqual({
        serverId: 'filesystem',
      })
      expect(callsOn('startServer')).toBe(0)
    })

    it('draws a disabled spinner while a call is in flight, and dispatches nothing on a second click', async () => {
      const releases: Array<() => void> = []
      stubWorkbench({
        startServer: () =>
          new Promise<void>((resolve) => {
            releases.push(resolve)
          }),
        stopServer: () =>
          new Promise<void>((resolve) => {
            releases.push(resolve)
          }),
      })
      renderWorkbench()
      await dockTools()
      await dockMcp()

      await userEvent.click(processControl('memory'))
      await waitFor(() => expect(processControl('memory').getAttribute('data-glyph')).toBe('spinner'))
      const starting = processControl('memory')
      expect(starting.getAttribute('aria-label')).toBe('Starting memory')
      expect(starting.disabled).toBe(true)

      // The click is refused twice over, and the second is the one this asserts: a disabled button is
      // handed no pointer, and the control reads its own action before dispatching, so a click that
      // arrives anyway — a synthetic one, or a keyboard activation on a node the DOM has already disabled
      // — has nothing to send. `fireEvent` is used precisely because it dispatches regardless of the
      // disabled attribute, which is what makes the assertion about the component rather than about jsdom.
      fireEvent.click(starting)
      expect(callsOn('startServer')).toBe(1)

      // And the other direction, so the spinner is not only the start's: a stop in flight is one too.
      await userEvent.click(processControl('filesystem'))
      await waitFor(() => expect(processControl('filesystem').getAttribute('data-glyph')).toBe('spinner'))
      expect(processControl('filesystem').getAttribute('aria-label')).toBe('Stopping filesystem')
      expect(processControl('filesystem').disabled).toBe(true)

      for (const release of releases) release()
      // Both calls land, and each row goes back to what the mirror says rather than to what was asked for.
      await waitFor(() => expect(processControl('memory').getAttribute('data-glyph')).toBe('play'))
      expect(processControl('filesystem').getAttribute('data-glyph')).toBe('stop')
    })

    it('offers the retry after a start that failed, dispatching that same start again', async () => {
      const stub = stubWorkbench({
        startServer: () => {
          throw new ConveyorError('MCP_SPAWN_FAILED', 'main says the spawn failed at a path you have never seen')
        },
      })
      renderWorkbench()
      await dockTools()
      await dockMcp()

      await userEvent.click(processControl('memory'))

      await waitFor(() => expect(processControl('memory').getAttribute('data-glyph')).toBe('retry'))
      const retry = processControl('memory')
      expect(retry.getAttribute('aria-label')).toBe('Retry memory')
      expect(retry.disabled).toBe(false)

      // Why it is a retry is the panel's line, in the shared words for the code — the same sentence and the
      // same slot the switch's refusals use. Main's message is for a log and never reaches the screen.
      await waitFor(() =>
        expect(document.querySelector('[data-slot="tools-mcp-write-error"]')?.textContent).toBe(
          'memory: The command could not be started on this machine.'
        )
      )
      expect(document.body.textContent ?? '').not.toContain('main says')

      await userEvent.click(retry)
      await waitFor(() => expect(callsOn('startServer')).toBe(2))
      expect(callsOn('stopServer')).toBe(0)
      // A start that succeeded on the second attempt would clear the line, so a failed one leaves it: this
      // is the row still saying what went wrong.
      expect(document.querySelector('[data-slot="tools-mcp-write-error"]')?.textContent).toBe(
        'memory: The command could not be started on this machine.'
      )
      expect(stub.methodsOn('mcp')).toContain('listServers')
    })

    it('keeps the switch and the control apart: neither dispatches the other’s command', async () => {
      const stub = stubWorkbench()
      renderWorkbench()
      await dockTools()
      await dockMcp()

      // The switch, unchanged: the settings section's write, with the row's own scope and the flag turned
      // over, and no process touched by it.
      await userEvent.click(within(mcpRow('memory')).getByRole('switch'))
      await waitFor(() => expect(callsOn('setEnabled')).toBe(1))
      expect(stub.callsTo('mcp').find((call) => call.method === 'setEnabled')?.args[0]).toEqual({
        scope: 'user',
        rootPath: ROOT,
        serverId: 'memory',
        enabled: false,
      })
      expect(callsOn('startServer')).toBe(0)
      expect(callsOn('stopServer')).toBe(0)

      // The control beside it is the same control: the switch redraws the row, and what the row offers is
      // still a Start for a server the mirror reports as stopped. Nothing about the flag reached it.
      expect(processControl('memory').getAttribute('data-glyph')).toBe('play')
      expect(processControl('memory').getAttribute('aria-label')).toBe('Start memory')

      // And the other way round: a start is not the enable flag's write.
      await userEvent.click(processControl('memory'))
      await waitFor(() => expect(callsOn('startServer')).toBe(1))
      expect(callsOn('setEnabled')).toBe(1)
    })

    it('states no status word on any row, on either page', async () => {
      stubWorkbench()
      renderWorkbench()
      await dockTools()
      await dockMcp()

      // Every row of the first page, and then the second: the words the rail used to write about a process
      // are gone, and what says it is the control's glyph. The status filter's own options are the one
      // place those words remain, which is why this reads rows rather than the whole panel.
      for (const row of mcpRows()) {
        expect(row.textContent ?? '').not.toMatch(/Running|Stopped/)
      }

      await userEvent.click(screen.getByRole('button', { name: 'Next page' }))
      expect(mcpRows().length).toBeGreaterThan(0)
      for (const row of mcpRows()) {
        expect(row.textContent ?? '').not.toMatch(/Running|Stopped/)
      }
    })
  })
})

describe('a failed skills read', () => {
  it('renders the code-branched sentence in the panel, as the settings section already does', async () => {
    stubWorkbench({
      listSkills: () => {
        throw new ConveyorError('SKILL_IO_ERROR', 'main says the folder is not readable')
      },
    })
    renderWorkbench()

    // The panel is opened by hand rather than through `dockTools`, because a failed listing is exactly the
    // case with no search box to wait for: the sentence is the whole tab.
    await userEvent.click(resident('Tools'))

    // The sentence the shared map holds for this code, asserted on the panel this turn closes the gap for:
    // the wording is one function, and both surfaces that draw the read now have a case that pins it.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="tools-skills-read-error"]')?.textContent).toBe(
        'The skill folders could not be opened. Check that they are readable, then reopen this screen.'
      )
    )
  })
})
