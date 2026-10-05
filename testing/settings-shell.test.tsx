import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/**
 * The settings shell: the way out, and the sections down the left of the panel.
 *
 * Settings is a screen that takes the whole main area, so "how do I leave it" is a question the screen
 * itself has to answer — and until now it did not. The shell that lands here is three memories and one
 * control, and each of the three is asserted where it is visible rather than in the store: the prior
 * drawer view is asserted by the drawer that comes back, the section rail by the panel that is showing
 * beside it, and the activity rail by the controls it offers before and after.
 *
 * The activity rail's own control is pinned as it was, deliberately. It opens settings and does not
 * toggle them — that has been the shape of `icon-rail.tsx:193` since the control was added — and this
 * phase lands the way back in the header rather than quietly turning a stable control into a different
 * one. The way out on the activity rail is an activity icon, exactly as before.
 *
 * What only a rendered workbench can show is the composition: that the back glyph is in the *settings*
 * header rather than in the drawer's, that the section rail is a column beside the pane rather than a
 * strip across its top, and that leaving settings by either route puts the drawer's columns back. The
 * workbench is rendered whole, over a folder with one file in it, so nothing here is a stand-in for the
 * app's own layout.
 *
 * jsdom computes no layout, so what these tests read is the shell's own statement of its shape — the
 * column marker the primitive branches on, the slots, the order of the entries and the state each one
 * is in — and never pixels. Whether the rail *looks* right in either theme, and at a narrow window, is
 * the reviewer's eyes rather than this file's business.
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
 * The section rail, by the marker the shell carries: the column the entries stand in.
 *
 * Found by slot rather than by role, and as the column rather than as the list of entries inside it:
 * the shell's own element is what the relocation is about, and what the list is made of — Radix tabs
 * today, a stack of pressed buttons tomorrow — is not what this asserts.
 */
function sectionRail(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="settings-rail"]')
}

/** The entries' own list, inside the rail. */
function sectionList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="settings-sections"]')
}

/** The pane the showing section lands in — the area the rail stands at the left of. */
function sectionPane(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="settings-pane"]')
}

/**
 * The sections that exist, in the order the rail lists them.
 *
 * One pin, read by both order claims below: a new section has to be added here deliberately, which is
 * what keeps "a launch opens Providers" and "the rail lists them in this order" assertions about the
 * whole set rather than about whichever entry happens to be first.
 */
const SECTIONS = ['Providers', 'MCP Servers', 'Skills', 'Terminal', 'Context', 'Appearance', 'Buddies']

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

/** One of the rail's entries, by its label. Radix renders each as the tab it is by role. */
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
  it('opens on the Providers section, with the sections listed down the rail', async () => {
    stubWorkbench()
    renderWorkbench()

    await userEvent.click(railControl('Settings'))

    const rail = sectionRail()
    expect(rail).not.toBeNull()
    // The rail's entries, pinned as the sections that exist rather than as a count, so that a launch
    // opening Providers is an assertion about the whole set. Buddies joined in the phase that built it,
    // last of all: it is the advanced surface behind the header's own Buddy Select, and Appearance was
    // added ahead of it in the phase that built the two display preferences.
    expect(
      within(sectionList() as HTMLElement)
        .getAllByRole('tab')
        .map((entry) => entry.textContent)
    ).toEqual(SECTIONS)
    // The first section is the one a launch opens, and it is the one showing.
    expect(tab('Providers').getAttribute('aria-selected')).toBe('true')
    expect(tab('MCP Servers').getAttribute('aria-selected')).toBe('false')

    // The rail comes before the panel, and what it precedes is the section itself: the entries are
    // never inside the content, and the section a visit opens lands after the choice of it.
    const section = providersSection()
    expect(section).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Model providers' })).toBeTruthy()
    expect(screen.getByText('DeepSeek')).toBeTruthy()
    expect(mcpSection()).toBeNull()
    expect(
      (rail as HTMLElement).compareDocumentPosition(section as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING
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
    // The panel is the screen still: the header the rail sits under does not travel with an entry.
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

  it('draws the sections as a rail down the left, not as a strip across the top', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(railControl('Settings'))

    const rail = sectionRail()
    expect(rail).not.toBeNull()
    // The rail is the column the entries stand in. The shell states the shape where the primitive reads
    // it: the tabs the entries are built from declare vertical orientation, which is what lays the list
    // out as a column and puts the pane beside it rather than under a strip. jsdom computes no layout,
    // so this marker is the closest a DOM test gets to "down the left rather than across the top".
    const tabs = (rail as HTMLElement).closest('[data-slot="tabs"]')
    expect(tabs?.getAttribute('data-orientation')).toBe('vertical')
    expect((rail as HTMLElement).classList.contains('flex-col')).toBe(true)
    expect(sectionList()).not.toBeNull()

    // The edge the rail draws is its right one, where the strip this replaced drew a bottom border
    // across the panel's top; and the column is fixed, so the pane is what takes the rest of the width.
    expect((rail as HTMLElement).classList.contains('border-r')).toBe(true)
    expect((rail as HTMLElement).classList.contains('border-b')).toBe(false)
    expect((rail as HTMLElement).classList.contains('shrink-0')).toBe(true)

    // The rail stands beside the pane rather than around it, and the section lands in the pane: what a
    // reader is offered is the choice down the side and the chosen section's content to the right.
    const pane = sectionPane()
    expect(pane).not.toBeNull()
    const section = providersSection()
    expect(section).not.toBeNull()
    expect((pane as HTMLElement).contains(section as HTMLElement)).toBe(true)
    expect((rail as HTMLElement).contains(section as HTMLElement)).toBe(false)
    expect((rail as HTMLElement).contains(pane)).toBe(false)
    expect(
      (rail as HTMLElement).compareDocumentPosition(pane as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('lists the sections down the rail in order, with the showing one marked', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(railControl('Settings'))

    const entries = within(sectionRail() as HTMLElement).getAllByRole('tab')
    expect(entries.map((entry) => entry.textContent)).toEqual(SECTIONS)

    // Exactly one entry is the showing one, and it is the launch's first section. That is a runtime
    // fact — which entry the store's section resolves for — rather than a reading of the classes.
    expect(entries.filter((entry) => entry.getAttribute('data-state') === 'active')).toHaveLength(1)
    expect(tab('Providers').getAttribute('aria-selected')).toBe('true')
    expect(tab('Providers').getAttribute('data-state')).toBe('active')
    for (const name of SECTIONS.slice(1)) {
      expect(tab(name).getAttribute('aria-selected')).toBe('false')
      expect(tab(name).getAttribute('data-state')).toBe('inactive')
    }

    // The showing entry is marked the way this app marks a vertical navigation's active item: the same
    // `bg-brand-soft`/`text-brand` pair `icon-rail.tsx` and `right-rail.tsx` paint theirs with, on the
    // accent hover the rest carry — and without the raised shadow the horizontal pill shipped. Which of
    // the two states those classes paint on screen is the runtime's business above, and the reviewer's
    // to look at.
    expect(tab('Providers').className).toContain('data-[state=active]:bg-brand-soft')
    expect(tab('Providers').className).toContain('data-[state=active]:text-brand')
    expect(tab('Providers').className).toContain('hover:bg-accent')
    expect(tab('Providers').className).toContain(
      'group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none'
    )
  })

  it('renders the section a rail entry selects, in the pane beside the rail', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(railControl('Settings'))

    const rail = sectionRail()
    const pane = sectionPane()

    // Every entry, walked in the order the rail states: a click selects the section through the store
    // the entries always wrote to, and the section the shell shows is the one whose content lands in the
    // pane — not in the rail, and never instead of the rail.
    const walk = [
      { label: 'Providers', value: 'providers', slot: 'settings-section-providers', heading: 'Model providers' },
      { label: 'MCP Servers', value: 'mcp-servers', slot: 'settings-section-mcp', heading: 'MCP servers' },
      { label: 'Skills', value: 'skills', slot: 'settings-section-skills', heading: 'Skills' },
      { label: 'Terminal', value: 'terminal', slot: 'settings-section-terminal', heading: 'Terminal' },
      { label: 'Context', value: 'context', slot: 'settings-section-context', heading: 'Context' },
      { label: 'Appearance', value: 'appearance', slot: 'settings-section-appearance', heading: 'Appearance' },
      { label: 'Buddies', value: 'buddies', slot: 'settings-section-buddies', heading: 'Buddies' },
    ] as const

    for (const entry of walk) {
      await userEvent.click(tab(entry.label))

      const panel = section(entry.slot)
      if (!panel) throw new Error(`the ${entry.label} section is not showing after its rail entry was clicked`)
      expect(tab(entry.label).getAttribute('aria-selected')).toBe('true')
      expect(useWorkbenchStore.getState().settingsSection).toBe(entry.value)

      // The section's own first words, read out of its own panel: a panel that is merely unhidden would
      // say nothing about which section rendered into it.
      expect(panel.querySelector('h1')?.textContent).toBe(entry.heading)
      expect((pane as HTMLElement).contains(panel)).toBe(true)
      expect((rail as HTMLElement).contains(panel)).toBe(false)
    }
  })

  it('keeps the back control and the title above the rail, and the way out still works', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(railControl('Settings'))

    const back = backGlyph()
    const header = back.closest('header')
    expect(header).not.toBeNull()
    expect((header as HTMLElement).textContent).toContain('Settings')

    // The screen's own header, above the rail rather than inside it: the way back out belongs to the
    // visit, not to the section that happens to be showing.
    expect((sectionRail() as HTMLElement).contains(back)).toBe(false)
    expect(
      (header as HTMLElement).compareDocumentPosition(sectionRail() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(back)
    expect(sectionRail()).toBeNull()
    expect(useWorkbenchStore.getState().activeActivity).toBe('chat')
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
