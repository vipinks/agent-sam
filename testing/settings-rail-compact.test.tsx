/**
 * The settings rail as a *stack*, and the way back out of the header above it.
 *
 * Two defects were reported against the shell this file pins. The first: the rail's seven entries filled
 * the column's height instead of reading as a compact stack from the top. The second: the back control in
 * the header did not navigate back. They are one defect, and the second is a consequence of the first —
 * the entries were each as tall as the list that held them, and the list centred its children, so the
 * stack spilled out of both ends of its own box: three entries painted above the list's top edge, over
 * the header, and the rest below the window. An entry carries no surface of its own while it is not the
 * active one, so the back glyph stayed *visible* and stopped being *clickable* — the pointer was landing
 * on the transparent entry lying over it. What this file can hold of that is the cause: the classes the
 * entries and the list are built from, asserted by inspection.
 *
 * jsdom computes no layout and implements no hit testing, so nothing here can prove that a click lands on
 * the button rather than on the box above it. What is asserted is structure and wiring: the entries as the
 * rail's own stacked children in order, no stretch class on an entry and neither centring nor spreading on
 * the list, a rail column that scrolls rather than resizes, a header that is a sibling of the two-column
 * body rather than a child of the rail, a back control that is a real button in normal flow, and a
 * section selected by every entry. The stray-box half of the defect was measured in a real browser
 * instead, where an entry 234px tall over a 241px list put a tab, not the button, at the button's centre.
 *
 * The pixel acceptance stays Boss's: seven compact rows at the top of the rail, every one of them
 * reachable, and one click on the back arrow returning to the app, in both themes.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore, type SettingsSection } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const ROOT = 'C:/w'
const TEXT_PATH = 'C:/w/notes.txt'

/** One provider that ships, so the section a launch opens has a row in it. */
const DEEPSEEK = { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }

/**
 * The whole workbench over a folder with one provider in it.
 *
 * Every other read is answered emptily: the composer, the session list and the changes panel are not this
 * file's subject, and an unstubbed query would be noise in the middle of a rail claim.
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

/** The activity rail, by the name it states to everything that is not a pointer. */
function activityRail(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Workbench' })
}

/** One of the activity rail's own controls, by the view it names. */
function activityControl(label: string): HTMLElement {
  return within(activityRail()).getByRole('button', { name: label })
}

/** The title the drawer's header is showing, or null while there is no drawer. */
function drawerTitle(container: HTMLElement): string | null {
  const title = container.querySelector<HTMLElement>('[data-panel]#secondary header span[title]')
  return title?.textContent ?? null
}

/** The section rail, by the marker the shell carries: the column the entries stand in. */
function sectionRail(): HTMLElement {
  const rail = document.querySelector<HTMLElement>('[data-slot="settings-rail"]')
  if (!rail) throw new Error('the settings rail is not drawn')
  return rail
}

/** The entries' own list, inside the rail. */
function sectionList(): HTMLElement {
  const list = document.querySelector<HTMLElement>('[data-slot="settings-sections"]')
  if (!list) throw new Error('the section list is not drawn')
  return list
}

/** The body the rail and the pane are the two columns of. */
function settingsBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>('[data-slot="tabs"]')
  if (!body) throw new Error('the settings body is not drawn')
  return body
}

/** The pane the showing section lands in — the area the rail stands at the left of. */
function sectionPane(): HTMLElement {
  const pane = document.querySelector<HTMLElement>('[data-slot="settings-pane"]')
  if (!pane) throw new Error('the settings pane is not drawn')
  return pane
}

/** The header's way back, by the label it states. */
function backControl(): HTMLElement {
  return screen.getByRole('button', { name: 'Back' })
}

/** One of the rail's entries, by its label. Radix renders each as the tab it is by role. */
function entry(name: string): HTMLElement {
  return screen.getByRole('tab', { name })
}

/**
 * The sections that exist, in the order the rail lists them.
 *
 * One pin, read by the order claim: a new section has to be added here deliberately, which is what keeps
 * "the rail lists them in this order" an assertion about the whole set rather than about whichever entry
 * happens to be first.
 */
const SECTIONS = [
  { label: 'Providers', value: 'providers' },
  { label: 'MCP Servers', value: 'mcp-servers' },
  { label: 'Skills', value: 'skills' },
  { label: 'Terminal', value: 'terminal' },
  { label: 'Context', value: 'context' },
  { label: 'Appearance', value: 'appearance' },
  { label: 'Buddies', value: 'buddies' },
] as const satisfies ReadonlyArray<{ label: string; value: SettingsSection }>

beforeEach(() => {
  localStorage.clear()
  // The shell's memories are the store's, and the store is module-level: a case that leaves the panel on
  // another section would otherwise decide the next one's first render.
  useWorkbenchStore.setState({
    activeActivity: 'chat',
    settingsReturnView: null,
    settingsSection: 'providers',
    drawerCollapsed: false,
  })
})

describe('the settings rail', () => {
  it('renders its entries as compact fixed-height rows stacked from the top of the column', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(activityControl('Settings'))

    const rail = sectionRail()
    const list = sectionList()
    const entries = within(list).getAllByRole('tab')

    // The seven, in the rail's own order, and the list is the column's first child: the stack starts at
    // the rail's top rather than at a share of its height.
    expect(rail.firstElementChild).toBe(list)
    expect(list.children).toHaveLength(SECTIONS.length)
    expect(entries.map((node) => node.textContent)).toEqual(SECTIONS.map((section) => section.label))

    for (const node of entries) {
      const classes = node.className
      // No entry stretches to its own or its parent's height. The first two are absent because the
      // primitive's own pair is overridden below them; the third is the primitive's height read as a
      // percentage of the list, which is what made an entry as tall as the box holding all seven.
      expect(classes).not.toContain('flex-1')
      expect(classes).not.toContain('h-full')
      expect(classes).not.toContain('h-[calc(100%-1px)]')
      // And the row's own size is stated: a fixed, compact one, even growth replaced by none.
      expect(classes).toContain('h-8')
      expect(classes).toContain('flex-none')
    }

    // The list stacks its children from its top. `justify-center` is the primitive's default for this
    // axis and the one class that mattered: a column of rows taller than the box that holds them, centred
    // in it, spills out of *both* ends — and the end that spilled over the header is where the back
    // control went under an invisible row. Neither centring nor spreading is this list's business.
    const listClasses = list.className
    expect(listClasses).toContain('flex-col')
    expect(listClasses).toContain('justify-start')
    expect(listClasses).not.toContain('justify-center')
    expect(listClasses).not.toContain('justify-between')
    // The rows are the column's subject, so the column takes the overflow rather than squashing the list.
    expect(listClasses).toContain('shrink-0')
  })

  it('scrolls the rail column rather than resizing the entries to fit it', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(activityControl('Settings'))

    // The rail is the scroll container: seven rows that ever exceed its height are reached by scrolling
    // the column, never by growing the rows until the last one is off the window.
    const classes = sectionRail().className
    expect(classes).toContain('overflow-y-auto')
    expect(classes).toContain('flex-col')
    expect(classes).toContain('shrink-0')
  })

  it('keeps the header and its back control as a sibling of the two-column body, outside the rail', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(activityControl('Settings'))

    const back = backControl()
    const header = back.closest('header')
    expect(header).not.toBeNull()
    expect((header as HTMLElement).textContent).toContain('Settings')

    const body = settingsBody()
    const rail = sectionRail()

    // The rail and the pane are the body's two columns, in that order...
    expect(Array.from(body.children)).toEqual([rail, sectionPane()])

    // ...and the header is not inside either of them, nor inside the body: it is the body's sibling, the
    // row above it, which is what makes it the width of the screen's own area rather than of a column.
    expect(body.contains(header as HTMLElement)).toBe(false)
    expect(rail.contains(header as HTMLElement)).toBe(false)
    expect(sectionPane().contains(header as HTMLElement)).toBe(false)
    expect((header as HTMLElement).parentElement).toBe(body.parentElement)
    expect((header as HTMLElement).nextElementSibling).toBe(body)
    // The back control is in the header's own flow, beside the title, and not a child of the rail.
    expect(back.parentElement).toBe(header)
    expect(rail.contains(back)).toBe(false)
  })

  it('returns from the header to the view Settings took over, by one click on a real button', async () => {
    stubWorkbench()
    const { container } = renderWorkbench()

    // Two visits, from two different views: what the header's way back restores is the view that was
    // open when the visit began, and it is not a fixed answer.
    for (const [origin, title] of [
      ['Explorer', 'Explorer'],
      ['Git', 'Git Changes'],
    ] as const) {
      await userEvent.click(activityControl(origin))
      expect(drawerTitle(container)).toBe(title)

      await userEvent.click(activityControl('Settings'))
      // The whole main area is the settings screen while it is open, so there is no drawer to read.
      expect(drawerTitle(container)).toBeNull()

      const back = backControl()
      // A real button, in the header's own flow: not a decoration, and not inside the rail whose rows lie
      // beside it.
      expect(back.tagName).toBe('BUTTON')
      expect(sectionRail().contains(back)).toBe(false)

      await userEvent.click(back)
      expect(drawerTitle(container)).toBe(title)
      expect(document.querySelector('[data-slot="settings-rail"]')).toBeNull()
      expect(useWorkbenchStore.getState().settingsReturnView).toBeNull()
    }
  })

  it('still selects every section through the rail, one entry at a time', async () => {
    stubWorkbench()
    renderWorkbench()
    await userEvent.click(activityControl('Settings'))

    // The rows changed shape, not meaning: every entry is still the control for its section, and each
    // click still lands in the store the sections are read from.
    for (const section of SECTIONS) {
      await userEvent.click(entry(section.label))
      expect(useWorkbenchStore.getState().settingsSection).toBe(section.value)
      expect(entry(section.label).getAttribute('aria-selected')).toBe('true')
    }
  })
})
