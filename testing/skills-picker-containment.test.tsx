/**
 * The composer picker's containment, as wiring.
 *
 * The defect this pins: the popover's content had no height bound of its own, so its height was the sum
 * of its children — two group headings and one row per skill — and a library of a hundred-odd skills
 * drew a popover several screens tall. Radix's collision avoidance is on and stays on, but the only
 * thing it can do with content taller than the viewport is move it: the popover flipped to the top side
 * and hung off the top of the window, taking the filter box and the cap line with it. What the design
 * asks for is the bound instead: the rows scroll inside a viewport-relative region, the filter box stays
 * above it and the cap line below it, and the arrow keys keep the row they are on in view.
 *
 * The honest ceiling of these assertions. jsdom lays nothing out: every element reports a zero-height
 * box, nothing here can observe that a region is scrollable, and "the filter box is never scrolled away"
 * is a claim about pixels that only the live app can settle. So this suite asserts the *structure* that
 * states each policy — which element is the bounded region, what classes carry the bound, and which
 * elements are outside it — plus the calls the picker makes when the arrow keys move the active row.
 * Those are real assertions: they are the mechanism, and the containment is what regressed. Pixel
 * acceptance is the running app against the full library.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import type { SkillListing, SkillSummary, SkillTierListing } from '@/conveyor/protocol/skills'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * The same three-lines-of-jsdom as the other composer suites: `@tanstack/react-virtual` sizes its window
 * from the scroll element's own measured size, both of which read as 0 in jsdom, and a zero-height
 * window renders no rows. Nothing here asserts on pixels.
 */
const VIEWPORT = { width: 900, height: 800 }
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => VIEWPORT.width })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => VIEWPORT.height })

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** A library of the size the defect was reported against: one hundred and twenty skills plus two. */
const LIBRARY = 120

/** One user skill, numbered so a query can name exactly one of them. */
function userSkill(index: number): SkillSummary {
  const id = `skill-${String(index).padStart(3, '0')}`
  return {
    id,
    scope: 'user',
    tier: 'user-native',
    title: `Skill ${index}`,
    summary: `Number ${index} in the user library.`,
    tags: [],
    sourcePath: `C:/u/era/skills/${id}/SKILL.md`,
  }
}

const TIERS: SkillTierListing[] = [
  {
    tier: 'project-native',
    scope: 'project',
    kind: 'native',
    sourceDir: 'C:/w/.sam/skills',
    skills: [
      {
        id: 'code-review',
        scope: 'project',
        tier: 'project-native',
        title: 'Code Review',
        summary: 'Review a diff before it lands.',
        tags: [],
        sourcePath: 'C:/w/.sam/skills/code-review/SKILL.md',
      },
      {
        id: 'release-notes',
        scope: 'project',
        tier: 'project-native',
        title: 'Release Notes',
        summary: 'Turn a diff into a changelog entry.',
        tags: [],
        sourcePath: 'C:/w/.sam/skills/release-notes/SKILL.md',
      },
    ],
  },
  { tier: 'project-compat', scope: 'project', kind: 'compat', sourceDir: 'C:/w/.agents/skills', skills: [] },
  {
    tier: 'user-native',
    scope: 'user',
    kind: 'native',
    sourceDir: 'C:/u/era/skills',
    skills: Array.from({ length: LIBRARY }, (_, index) => userSkill(index)),
  },
  { tier: 'user-compat', scope: 'user', kind: 'compat', sourceDir: 'C:/u/.agents/skills', skills: [] },
]

const LISTING: SkillListing = {
  tiers: TIERS,
  errors: [],
  disabled: [],
  counts: { total: LIBRARY + 2, project: 2, user: LIBRARY, errors: 0, hidden: 0 },
}

/**
 * The scroll requests the picker has made, in order.
 *
 * jsdom does not scroll — `setup-bridge` fills in a no-op so nothing throws — so the call itself is the
 * observable: what is under test is that the picker asks for the newly active row to be brought into
 * view, and the options it asks with. Replaced for this file only, and put back afterwards.
 */
const scrolls: Array<{ node: Element; options?: ScrollIntoViewOptions }> = []
let plainScrollIntoView: typeof HTMLElement.prototype.scrollIntoView

beforeAll(() => {
  plainScrollIntoView = HTMLElement.prototype.scrollIntoView
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    // A plain function rather than a spy: the node the call lands on is the assertion, so `this` is read.
    value: function (this: Element, options?: ScrollIntoViewOptions) {
      scrolls.push({ node: this, options })
    },
  })
})

afterAll(() => {
  HTMLElement.prototype.scrollIntoView = plainScrollIntoView
  scrolls.length = 0
})

beforeEach(() => {
  scrolls.length = 0
})

async function renderChat(): Promise<void> {
  const stub = createBridgeStub({
    listSkills: () => LISTING,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    chatWithTools: () => undefined,
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: SESSION_ID,
        title: 'an existing conversation',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
      },
    ],
    activeSessionId: SESSION_ID,
  })
  await Promise.resolve()

  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  await userEvent.click(screen.getByRole('button', { name: /^Skills/ }))
  await waitFor(() => expect(rows().length).toBe(LIBRARY + 2))
}

/** The skill rows the picker is currently offering. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="skill-picker-row"]'))
}

/** The bounded region the rows scroll inside, or a readable failure when the picker has none. */
function scrollRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[data-slot="skill-picker-scroll"]')
  if (!region) throw new Error('the picker renders no scroll region')
  return region
}

/** The popover's own content element, which is what the region is bounded inside of. */
function popoverContent(): HTMLElement {
  const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
  if (!content) throw new Error('the picker is not open')
  return content
}

/** The filter box, by its own label. */
function filterBox(): HTMLInputElement {
  return screen.getByLabelText('Filter skills') as HTMLInputElement
}

/** The cap copy, found by the sentence it starts with. */
function capLine(): HTMLElement {
  return screen.getByText(/guidance, not code/)
}

/** The last row the picker asked to be scrolled to, whichever stage of the walk that was. */
function lastScroll(): { node: Element; options?: ScrollIntoViewOptions } | undefined {
  return scrolls.at(-1)
}

/** Whether `earlier` comes before `later` in the document the user is looking at. */
function precedes(earlier: Element, later: Element): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
}

// ---------------------------------------------------------------- the cases

describe('the composer picker’s containment', () => {
  it('keeps the filter box and the cap line outside the row region, one above it and one below it', async () => {
    await renderChat()

    expect(document.querySelector('[data-slot="skill-picker-scroll"]')).toBeTruthy()
    const region = scrollRegion()
    const input = filterBox()
    const cap = capLine()

    // Outside and pinned, not merely elsewhere: a scroll inside the region cannot carry either of them
    // away, which is the whole of what "always visible" means here.
    expect(region.contains(input)).toBe(false)
    expect(region.contains(cap)).toBe(false)
    expect(precedes(input, region)).toBe(true)
    expect(precedes(region, cap)).toBe(true)

    // And the rows are inside it, so the region is the list rather than something beside it.
    expect(region.contains(rows()[0])).toBe(true)
    expect(region.contains(rows()[rows().length - 1])).toBe(true)
  })

  it('bounds the row region by a viewport height and scrolls it — and only it', async () => {
    await renderChat()

    const region = scrollRegion()
    const classes = region.classList

    expect(classes.contains('overflow-y-auto')).toBe(true)
    // Viewport-relative rather than a fixed pixel count, which is what lets the bound hold on a short
    // window as well as a tall one.
    expect(Array.from(classes).some((name) => /^max-h-\[[\d.]+vh\]$/.test(name))).toBe(true)

    // The popover itself is not the scroll region: bounding its content here would have bounded the
    // filter box and the cap line with the rows.
    const content = popoverContent()
    expect(content.classList.contains('overflow-y-auto')).toBe(false)
    expect(Array.from(content.classList).some((name) => name.startsWith('max-h-'))).toBe(false)
  })

  it('scrolls the newly active row into view as the arrow keys walk the list', async () => {
    await renderChat()

    const all = rows()
    expect(all.length).toBeGreaterThan(100)
    filterBox().focus()

    await userEvent.keyboard('{ArrowDown}')
    const first = lastScroll()
    expect(first?.node).toBe(all[0])
    expect(first?.node.getAttribute('data-active')).toBe('true')
    expect(first?.options).toEqual({ block: 'nearest' })

    // Up off the first row lands on the last one, which is as far from where the region opens as the
    // list goes: this is the scroll that only an explicit request can make happen.
    await userEvent.keyboard('{ArrowUp}')
    const last = lastScroll()
    expect(last?.node).toBe(all[all.length - 1])
    expect(last?.node.getAttribute('data-active')).toBe('true')
    expect(last?.options).toEqual({ block: 'nearest' })

    // And back down off the last row, so both ends of a list longer than the region shows are covered.
    await userEvent.keyboard('{ArrowDown}')
    const wrapped = lastScroll()
    expect(wrapped?.node).toBe(all[0])
    expect(wrapped?.node.getAttribute('data-active')).toBe('true')
  })

  it('still narrows the rows by the filter, and still says so when nothing matches', async () => {
    await renderChat()

    const region = scrollRegion()

    await userEvent.type(filterBox(), 'skill-119')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]?.textContent).toContain('Skill 119')
    // The surviving row is the region's, so the narrowed list is still the list that scrolls.
    expect(region.contains(rows()[0])).toBe(true)
    expect(capLine()).toBeTruthy()

    await userEvent.clear(filterBox())
    await waitFor(() => expect(rows()).toHaveLength(LIBRARY + 2))

    await userEvent.type(filterBox(), 'nothing-matches-this')
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(screen.getByText(/no skills match/i)).toBeTruthy()
    // Nothing to scroll and nothing scrolled away: the two pinned lines are still the ones on screen.
    expect(filterBox()).toBeTruthy()
    expect(capLine()).toBeTruthy()
  })
})
