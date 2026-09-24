import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The settings shell: the way out, and the row of sections at the top of the panel.
 *
 * Settings is a screen that takes the whole main area, so "how do I leave it" is a question the screen
 * itself has to answer — and until now it did not. The shell that lands here is three memories and one
 * control, and each of the three is asserted where it is visible rather than in the store: the prior
 * drawer view is asserted by the drawer that comes back, the section row by the panel that is showing,
 * and the rail by the controls it offers before and after.
 *
 * The rail's own control is pinned as it was, deliberately. It opens settings and does not toggle them —
 * that has been the shape of `icon-rail.tsx:193` since the control was added — and this phase lands the
 * way back in the header rather than quietly turning a stable control into a different one. The way out
 * on the rail is an activity icon, exactly as before.
 *
 * What only a rendered workbench can show is the composition: that the back glyph is in the *settings*
 * header rather than in the drawer's, that the section row really is at the top of the panel, and that
 * leaving settings by either route puts the drawer's columns back. The workbench is rendered whole, over
 * a folder with one file in it, so nothing here is a stand-in for the app's own layout.
 */

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'

/** One provider that ships, so the Providers section has a row to be unchanged about. */
const DEEPSEEK = { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }

/**
 * The whole workbench over a folder with one provider in it.
 *
 * Every other read is answered emptily: the composer, the session list and the changes panel are not
 * this file's subject, and an unstubbed query would be noise in the middle of a shell claim.
 */
function stubWorkbench(overrides: Record<string, (input: unknown) => unknown> = {}): BridgeStub {
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
    // The MCP section is mounted by the tab this file switches to, so its two reads are answered here
    // too — emptily, because this suite is about the shell rather than about the servers in it.
    listServers: () => ({ user: [], project: [], errors: [] }),
    listRunningTools: () => [],
    ...overrides,
  })
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

/** The rail, by the name it states to everything that is not a pointer. */
function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Workbench' })
}

/** One of the rail's own controls, by the direction or the view it names. */
function railControl(label: string): HTMLElement {
  return within(rail()).getByRole('button', { name: label })
}

/** The title the drawer's header is showing, or null while there is no drawer. */
function drawerTitle(container: HTMLElement): string | null {
  const title = container.querySelector<HTMLElement>('[data-panel]#secondary header span[title]')
  return title?.textContent ?? null
}

/**
 * The section row, by the marker the panel carries.
 *
 * Found by slot rather than by role: the row is the shell's, and what it is made of — Radix tabs today,
 * a row of pressed buttons tomorrow — is not what this asserts.
 */
function sectionRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="settings-sections"]')
}

/**
 * One of the two sections' panels, or null while it is the one that is not showing.
 *
 * "Showing" is read off the `hidden` attribute rather than off presence, because Radix keeps the panel
 * that is *not* showing in the document as an empty placeholder: the tab that is selected is the panel
 * that is not hidden, and the content only ever lands in that one. Asserting on the slot alone would
 * find a panel for both tabs at every moment and prove nothing.
 */
function section(slot: string): HTMLElement | null {
  const node = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
  if (!node || node.hasAttribute('hidden')) return null
  return node
}

/** The panel the Providers tab shows, or null while the other one is. */
function providersSection(): HTMLElement | null {
  return section('settings-section-providers')
}

/** The panel the MCP Servers tab shows, or null while the other one is. */
function mcpSection(): HTMLElement | null {
  return section('settings-section-mcp')
}

/** The header's way back, by the label it states. */
function backGlyph(): HTMLElement {
  return screen.getByRole('button', { name: 'Back' })
}

/** One of the two tabs, by its label. */
function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name })
}

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's, and the store is module-level: a test that leaves the panel on
  // MCP Servers would otherwise decide the next one's first render.
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    settingsReturnView: null,
    settingsSection: 'providers',
    drawerCollapsed: false,
  })
})

describe('the settings shell', () => {
  it('opens on the Providers section with the section row at the top of the panel', async () => {
    stubWorkbench()
    renderWorkbench()

    await userEvent.click(railControl('Settings'))

    const row = sectionRow()
    expect(row).not.toBeNull()
    expect(
      within(row as HTMLElement)
        .getAllByRole('tab')
        .map((node) => node.textContent)
    ).toEqual(['Providers', 'MCP Servers'])
    // The first section is the one a launch opens, and it is the one showing.
    expect(tab('Providers').getAttribute('aria-selected')).toBe('true')
    expect(tab('MCP Servers').getAttribute('aria-selected')).toBe('false')

    // The row is above the panel, not beside it: both tabs come before anything either panel renders.
    const section = providersSection()
    expect(section).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Model providers' })).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(mcpSection()).toBeNull()
    expect(
      (row as HTMLElement).compareDocumentPosition(section as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('switches to the MCP Servers section, and switching back shows the providers section unchanged', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(railControl('Settings'))

    const before = (providersSection() as HTMLElement).textContent

    await userEvent.click(tab('MCP Servers'))
    expect(mcpSection()).not.toBeNull()
    expect(providersSection()).toBeNull()
    expect(tab('MCP Servers').getAttribute('aria-selected')).toBe('true')
    // The panel is the screen still: the header the section row sits under does not travel with a tab.
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy()

    await userEvent.click(tab('Providers'))
    expect(providersSection()).not.toBeNull()
    expect(mcpSection()).toBeNull()
    // Unchanged, not merely present: the same rows, word for word.
    expect((providersSection() as HTMLElement).textContent).toBe(before)
  })

  it('returns to the drawer view that was active before settings opened', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(railControl('Explorer'))
    expect(drawerTitle(container)).toBe('Explorer')

    await userEvent.click(railControl('Settings'))
    // The whole main area is the settings screen while it is open, so there is no drawer to read.
    expect(drawerTitle(container)).toBeNull()

    await userEvent.click(backGlyph())
    expect(drawerTitle(container)).toBe('Explorer')
    expect(providersSection()).toBeNull()
  })

  it('remembers the section and the way back for the run, without persisting either', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(railControl('Git'))
    await userEvent.click(railControl('Settings'))
    await userEvent.click(tab('MCP Servers'))
    await userEvent.click(backGlyph())

    // Both memories are the run's: the way back is the view the visit started from...
    expect(drawerTitle(container)).toBe('Git Changes')

    // ...and the section is the one that was showing, so a second visit opens there.
    await userEvent.click(railControl('Settings'))
    expect(tab('MCP Servers').getAttribute('aria-selected')).toBe('true')
    expect(mcpSection()).not.toBeNull()

    // Written nowhere: the layout record the drawer's own flags live in holds neither of them.
    expect(localStorage.getItem('sam-ai-layout-preferences') ?? '').not.toContain('settings')
  })

  it('leaves the rail’s settings control exactly as it was, and the rail still leaves settings', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    await userEvent.click(railControl('Settings'))
    expect(providersSection()).not.toBeNull()

    // Not a toggle, exactly as before this phase: the control opens settings, and a second click on it
    // while settings is showing changes nothing at all.
    await userEvent.click(railControl('Settings'))
    expect(providersSection()).not.toBeNull()

    // The way out on the rail is an activity icon, which is the path this screen has always had.
    await userEvent.click(railControl('Chat'))
    expect(providersSection()).toBeNull()
    expect(drawerTitle(container)).toBe('Chat Sessions')
  })
})
