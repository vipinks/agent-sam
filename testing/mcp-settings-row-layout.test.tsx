import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { McpServersSection } from '@/app/components/workbench/mcp-settings'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The MCP server row's shape, as structure rather than as pixels.
 *
 * Turn 2 widened the row's fixed content — a badge beside the id, and a seventh icon in the trailing
 * cluster — and the row's one non-wrapping flex line answered by squeezing the only shrinkable child to
 * nothing and letting everything after it render past the card's border. The facts that regression is
 * made of are checkable without a layout engine: which elements sit on the line and in what order,
 * which of them may shrink, and whether the trailing cluster is something the row can move or something
 * it has to fit.
 *
 * jsdom lays nothing out: no box model, no flex resolution, no line breaking. So no test here can see a
 * glyph crossing a border or an ellipsis appear, and this file claims nothing of the kind. What it pins
 * is the structure each of those depends on. The pixel-level acceptance for this fix is the live
 * screenshot, not this suite.
 *
 * The section is rendered over a stubbed bridge rather than over a fake of its own store, so the row
 * asserted here is the row main's answer produces.
 */

/** The folder the section reads its project scope from. */
const ROOT = 'C:/w'

/** The one server this suite draws: user scope, flagged, with a command long enough to have to give. */
const SERVER = {
  id: 'filesystem',
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/w'],
  cwd: null,
  env: {},
  enabled: true,
  scope: 'user' as const,
  trust: null,
  secrets: [],
  autoApprove: true,
}

/** The cluster's controls, in the order the row has always drawn them. */
const CONTROLS = ['mcp-enabled', 'mcp-auto-approve', 'mcp-start', 'mcp-stop', 'mcp-secrets', 'mcp-logs', 'mcp-delete']

/** Main's answers for this suite, and the section over them once the first refresh has landed. */
async function openSection(): Promise<void> {
  const stub = createBridgeStub()
  stub.on('listServers', () => ({ user: [SERVER], project: [], errors: [] }))
  stub.on('listRunningTools', () => [])
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <McpServersSection />
    </QueryClientProvider>
  )

  // A row is main's answer arriving: nothing is drawn until the refresh resolves.
  await waitFor(() => expect(document.querySelector('[data-slot="mcp-server-row"]')).not.toBeNull())
}

/** The one row card, by the marker every part of this section is reached through. */
function row(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="mcp-server-row"]')
  if (!found) throw new Error('no server row was rendered')
  return found
}

/** The row's flex line: the first thing inside the card, which is where the row lays itself out. */
function line(): HTMLElement {
  const found = row().firstElementChild
  if (!(found instanceof HTMLElement)) throw new Error('the row has no flex line')
  return found
}

/** The command summary: the row's own code element, found by what it is rather than by a marker. */
function summary(): HTMLElement {
  const found = line().querySelector('code')
  if (!(found instanceof HTMLElement)) throw new Error('the row draws no command summary')
  return found
}

/** The trailing action cluster, found from the last control it holds. */
function actions(): HTMLElement {
  const del = row().querySelector<HTMLElement>('[data-slot="mcp-delete"]')
  const group = del?.parentElement
  if (!group) throw new Error('the row draws no action cluster')
  return group
}

/** Every child of the line, by the marker it carries — the fixed elements have one each. */
function childrenOf(node: HTMLElement): Record<string, HTMLElement> {
  const found: Record<string, HTMLElement> = {}
  for (const child of Array.from(node.children)) {
    const slot = child.getAttribute('data-slot')
    if (slot) found[slot] = child as HTMLElement
  }
  return found
}

/** Whether one element is drawn before another, as the document orders them. */
function precedes(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

describe('the MCP server row at every width', () => {
  it('draws the command summary as the row’s flexible middle, truncating instead of disappearing', async () => {
    await openSection()

    const code = summary()

    // The three classes are the whole of "the middle": it grows into the space the fixed elements leave,
    // it ellipsizes when that space is too small for the command, and `min-w-0` is what lets it reach
    // zero rather than holding the line open at its own content width.
    expect(code.className).toContain('min-w-0')
    expect(code.className).toContain('truncate')
    expect(code.className).toContain('flex-1')
    // Reachable by a suite the way every other part of the row is, rather than by its tag.
    expect(code.getAttribute('data-slot')).toBe('mcp-command-summary')
    // It is the command line, and the badge Turn 2 added is on the same line: those two together are
    // what made the row's fixed content too wide to hold everything at once.
    expect(code.textContent).toBe('npx -y @modelcontextprotocol/server-filesystem C:/w')
    expect(row().querySelector('[data-slot="mcp-auto-approve-badge"]')).not.toBeNull()
  })

  it('keeps the trailing action cluster inside the row, unshrinkable and able to wrap itself', async () => {
    await openSection()

    const group = actions()

    // Unshrinkable: the switch and every glyph keep their size whatever the width is. That is the whole
    // of why the cluster has to be movable rather than fittable.
    expect(group.className).toContain('flex-none')
    expect(group.getAttribute('data-slot')).toBe('mcp-row-actions')
    // Inside the row's own line, so the controls are children of the row and never siblings of it.
    expect(line().contains(group)).toBe(true)
    expect(row().contains(group)).toBe(true)
    // Movable: it wraps onto another line inside the card, and `max-w-full` is what stops the cluster
    // itself — seven controls at their natural size — from being wider than the card it lives in.
    expect(group.className).toContain('flex-wrap')
    expect(group.className).toContain('max-w-full')

    // The row's own controls travel with it, the enable switch among them and the delete glyph last.
    for (const slot of CONTROLS) {
      const control = row().querySelector(`[data-slot="${slot}"]`)
      expect(control, `${slot} is drawn`).not.toBeNull()
      expect(group.contains(control as Node), `${slot} is in the cluster`).toBe(true)
    }
  })

  it('orders the row: id, scope badge, auto-approve badge, command summary, running state, actions', async () => {
    await openSection()

    // The line's own children, in the approved order. The running state is a row-level element between
    // the summary and the actions rather than a member of the cluster, which is what gives it a place in
    // the shrink order behind the summary: a group that cannot shrink cannot hold the second thing that
    // shrinks.
    const children = Array.from(line().children).map(childLabel)

    expect(children).toEqual(['id', 'scope-badge', 'auto-approve-badge', 'command-summary', 'running', 'actions'])

    // And the controls keep the order they have always had inside the cluster.
    const ordered = CONTROLS.map((slot) => row().querySelector(`[data-slot="${slot}"]`))
    ordered.forEach((control, index) => expect(control, `${CONTROLS[index]} is drawn`).not.toBeNull())

    for (let index = 1; index < ordered.length; index += 1) {
      expect(
        precedes(ordered[index - 1] as Element, ordered[index] as Element),
        `${CONTROLS[index - 1]} is drawn before ${CONTROLS[index]}`
      ).toBe(true)
    }
  })

  it('wraps the line rather than letting anything render past the card’s border', async () => {
    await openSection()

    // The fix's first half: the line has somewhere to put the cluster when the fixed part of the row
    // cannot sit beside it. Before this the line was `flex` and nothing else, so the actions had nowhere
    // to go and rendered past the border — the delete glyph in the report's screenshot.
    expect(line().className).toContain('flex-wrap')
    expect(line().className).toContain('min-w-0')
  })

  it('gives width in one order: the summary first, the running state second, the fixed elements never', async () => {
    await openSection()

    const state = row().querySelector<HTMLElement>('[data-slot="mcp-running"]')
    expect(state).not.toBeNull()
    // Second in the shrink order, and only ever after the summary has reached zero: it may ellipsize,
    // but the summary is the element that gives first.
    expect(state?.className).toContain('min-w-0')
    expect(state?.className).toContain('truncate')
    expect(line().contains(state as Node)).toBe(true)
    expect(actions().contains(state as Node)).toBe(false)

    // The fixed elements never truncate: the id and both badges hold their width, and the cluster —
    // asserted `flex-none` above — holds the switch and every glyph.
    const id = Array.from(line().children).find((child) => child.textContent === SERVER.id)
    expect(id, 'the row names the server').toBeTruthy()
    expect((id as Element).className).toContain('shrink-0')

    const badges = ['badge', 'mcp-auto-approve-badge'].map((slot) => childrenOf(line())[slot])
    badges.forEach((badge) => {
      expect(badge, 'both badges are on the line').toBeTruthy()
      expect(badge.className).toContain('shrink-0')
    })
  })
})

/** What one child of the row's line is, named the way the approved order names it. */
function childLabel(node: Element): string {
  const slot = node.getAttribute('data-slot')
  if (slot === 'mcp-command-summary') return 'command-summary'
  if (slot === 'mcp-running') return 'running'
  if (slot === 'mcp-row-actions') return 'actions'
  if (slot === 'mcp-auto-approve-badge') return 'auto-approve-badge'
  if (slot === 'badge') return 'scope-badge'
  if (node.textContent === SERVER.id) return 'id'
  return `unlabelled:${node.tagName.toLowerCase()}`
}
