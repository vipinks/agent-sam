import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, type BridgeStub } from './bridge-stub'

/**
 * The viewer's expand control, as the workbench actually wires it.
 *
 * The control itself is one button; what only a rendered workbench can show is what it is *for*. Three
 * claims are asserted here, and each of them has a way of being wrong that no rule test would catch:
 *
 * - The chat column is removed from the layout rather than narrowed, hidden or overlapped. The
 *   assertion is on the group's own panel children — the number of columns sharing the width — and on
 *   the absence of the chat's node, not on any measured pixel width, which is jsdom's business only.
 * - The viewer is never remounted by the toggle. Each case captures the node it was showing before the
 *   click and asserts the same node is still in the document afterwards, both expanded and restored:
 *   that is what makes an edited buffer, a chosen sheet and a rendered preview survive the layout.
 * - Every kind the pane draws survives it — plain text, highlighted text, an image, a markdown preview,
 *   a workbook and a diff — because the control sits in the pane's header and is offered whatever the
 *   pane happens to be showing.
 *
 * The state behind it is session-scoped: it is asserted to be in the workbench store and to leave
 * nothing in `localStorage`, which is what "not persisted, resets on restart" means from a test. Escape
 * is asserted *not* to toggle it — the icon is the only control there is.
 *
 * There is no `CHAT_SESSIONS_STORE_ID` seed here either, for the reason `stubWorkbench` states: the chat
 * panel is rendered as part of the workbench, and the session store it reads unseeded is already empty.
 */

const TS_PATH = 'C:/w/app.ts'
const MD_PATH = 'C:/w/notes.md'
const TEXT_PATH = 'C:/w/notes.txt'
const IMAGE_PATH = 'C:/w/logo.png'
const SHEET_PATH = 'C:/w/report.xlsx'
const DISK_MTIME = 1_700_000_000_000

/** A language the viewer highlights, so the highlighted case is provable from the tokens. */
const TS_SOURCE = ['export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n')

/** Text the viewer does not tokenize: the plain, unhighlighted read view. */
const TEXT_SOURCE = ['just words', 'on two lines', ''].join('\n')

/** Markdown, which opens in the preview — the case where the control and the toggle share a header. */
const MD_SOURCE = ['# Release notes', '', '- one', ''].join('\n')

/** The read main would answer a `.ts` path with. */
function textResult(path: string, content: string): unknown {
  return { path, content, baselineMtime: DISK_MTIME }
}

/** A picture result, shaped the way main sends one. */
function imageResult(): unknown {
  return {
    kind: 'image',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    bytes: 128,
    path: IMAGE_PATH,
    baselineMtime: DISK_MTIME,
  }
}

/** A workbook result with three sheets, so "the tabs are intact" counts rather than guesses. */
function workbookResult(): unknown {
  return {
    kind: 'spreadsheet',
    sheets: [
      {
        name: 'First',
        rows: [
          ['h1', 'h2'],
          ['a1', 'a2'],
        ],
        truncatedRows: false,
        truncatedColumns: false,
      },
      { name: 'Second', rows: [['b1']], truncatedRows: false, truncatedColumns: false },
      {
        name: 'Third',
        rows: [
          ['h1', 'h2'],
          ['c1', 'c2'],
        ],
        truncatedRows: false,
        truncatedColumns: false,
      },
    ],
    sheetsOmitted: 0,
    fidelity: {
      hasFormulas: false,
      formulaCount: 0,
      hasCharts: false,
      chartCount: 0,
      hasConditionalFormatting: false,
      encrypted: false,
    },
    bytes: 4096,
    path: SHEET_PATH,
    baselineMtime: DISK_MTIME,
  }
}

/** A diff with one added and one removed line, so the pane has something to keep. */
const DIFF_RESULT = {
  lines: [
    { kind: 'removed' as const, text: 'const a = 1' },
    { kind: 'added' as const, text: 'const a = 2' },
  ],
  added: 1,
  removed: 1,
  truncated: false,
}

/**
 * One viewer kind, and what it must have drawn before the layout is touched.
 *
 * `read` is the answer main gives for the file, or null for a diff — which is a change rather than a
 * file, and reaches the pane through `selectedChange` instead.
 */
interface Kind {
  name: string
  path: string | null
  read: (() => unknown) | null
  change?: { path: string; side: 'staged' | 'unstaged' }
  /** The node this kind is on screen as, or null while it has not drawn yet. */
  marker: (container: HTMLElement) => HTMLElement | null
}

const KINDS: Kind[] = [
  {
    name: 'plain text',
    path: TEXT_PATH,
    read: () => textResult(TEXT_PATH, TEXT_SOURCE),
    marker: (container) => container.querySelector<HTMLElement>('[data-slot="code-gutter"]'),
  },
  {
    name: 'highlighted text',
    path: TS_PATH,
    read: () => textResult(TS_PATH, TS_SOURCE),
    // The `code` element rather than one of the token spans inside it: the spans arrive as a string of
    // markup this pane hands to the DOM, so React is not their owner and does not reconcile them. The
    // element is React's, and the text assertion in the case below is what covers what is inside it.
    marker: (container) => container.querySelector<HTMLElement>('code.hljs'),
  },
  {
    name: 'an image',
    path: IMAGE_PATH,
    read: () => imageResult(),
    marker: (container) => container.querySelector<HTMLElement>('img'),
  },
  {
    name: 'a markdown preview',
    path: MD_PATH,
    read: () => textResult(MD_PATH, MD_SOURCE),
    // The preview's own box, which the pane renders, rather than the heading inside it: the renderer's
    // element overrides are values in an object literal, so their component identity changes on every
    // render of the pane and React remounts those subtrees. That is a property of the shared renderer
    // rather than of this control, and asserting identity through it would be asserting something this
    // pane does not own — so the box is what is held onto, and its text is what is compared.
    marker: (container) => container.querySelector<HTMLElement>('[data-slot="markdown-preview"]'),
  },
  {
    name: 'a workbook',
    path: SHEET_PATH,
    read: () => workbookResult(),
    marker: (container) => container.querySelector<HTMLElement>('[data-slot="spreadsheet"]'),
  },
  {
    name: 'a diff',
    path: null,
    read: null,
    change: { path: 'C:/w/app.ts', side: 'unstaged' },
    marker: (container) => container.querySelector<HTMLElement>('[data-panel]#code pre'),
  },
]

/**
 * The whole workbench, with one file or change open.
 *
 * The workbench rather than the viewer, and deliberately: the column whose absence is asserted is the
 * workbench's, and rendering the viewer alone would leave nothing to remove. The reads the workbench's
 * other panes make are stubbed with empty answers — the composer and the explorer are not this file's
 * subject, and an unstubbed query here would be noise in the middle of a layout claim.
 *
 * Neither cross-window store is seeded, and that is not an oversight: `stubStore` answers a store read
 * *and* broadcasts what it seeded to every subscriber, so seeding two stores in one test would push the
 * second store's state into the first store's mirror. Unseeded, each store read falls back to its own
 * real initial state — no folder open, no conversations — which is a state the app genuinely runs in and
 * enough for a layout that does not depend on either. The open file and change come from
 * `useWorkbenchStore`, which is renderer-local and needs no bridge at all.
 */
function stubWorkbench(kind: Kind): BridgeStub {
  const stub = createBridgeStub({
    // The window state the workbench lays out for. Windowed, which is the window the app opens.
    isMaximized: () => false,
    readFile: kind.read ?? (() => textResult('', '')),
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => DIFF_RESULT,
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
  })
  setActiveStub(stub)
  useWorkbenchStore.setState({ selectedFile: kind.path, selectedChange: kind.change ?? null })
  return stub
}

function renderWorkbench() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Workbench />
    </QueryClientProvider>
  )
}

/**
 * The columns, keyed by the panel ids the group is given.
 *
 * `data-panel` is a marker attribute with no value — it says "this node is a panel" — so the panel is
 * found by its id, which is the same name the group is built with. The chat's absence is asserted on this
 * selector, so a column that is merely narrowed, hidden or scrolled out of view does not pass.
 */
function panel(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-panel]#${id}`)
}

/** The viewer's own column, as the resize group draws it. */
function viewerColumn(container: HTMLElement): HTMLElement | null {
  return panel(container, 'code')
}

/** The chat's column, by the same hook: absent while expanded rather than merely narrow. */
function chatColumn(container: HTMLElement): HTMLElement | null {
  return panel(container, 'chat')
}

/**
 * The columns of the split the viewer sits in.
 *
 * Read from the group's own panel children rather than from a marker of our own: how many columns share
 * the width is the library's grouping, and that grouping is what the claim is about. It is the group's
 * direct children that count, and the group is found by ascending from the viewer to the nearest ancestor
 * that holds panels — which is exactly the split this control reshapes.
 */
function splitColumns(container: HTMLElement): HTMLElement[] {
  const group = splitGroup(container)
  return group === null ? [] : [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')]
}

/** The resize group the viewer's column sits in — the split this control reshapes. */
function splitGroup(container: HTMLElement): HTMLElement | null {
  let node = viewerColumn(container)?.parentElement ?? null
  while (node !== null && node.querySelectorAll('[data-panel]').length === 0) node = node.parentElement
  return node
}

/**
 * The dividers in that split.
 *
 * A second reading of the same claim as `splitColumns`, from the other side: with the chat's column gone
 * there is nothing left to drag between, so the viewer's own group holds no separator. Both are asserted
 * because "the viewer spans both widths" can be false in two different ways — a column still sharing the
 * space, or a divider still cutting it — and neither assertion measures a pixel, which is jsdom's
 * business and not a claim about the layout.
 */
function splitSeparators(container: HTMLElement): HTMLElement[] {
  const group = splitGroup(container)
  return group === null ? [] : [...group.querySelectorAll<HTMLElement>(':scope > [role="separator"]')]
}

/** The control, in whichever direction it is currently offered. */
function expand(): HTMLElement {
  return screen.getByRole('button', { name: 'Expand the viewer' })
}

function restore(): HTMLElement {
  return screen.getByRole('button', { name: 'Restore the chat column' })
}

/** Wait for a kind to have drawn, and hand back the node it drew. */
async function drawn(kind: Kind, container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const node = kind.marker(container)
    if (node === null) throw new Error(`${kind.name} has not rendered yet`)
    return node
  })
}

beforeEach(() => {
  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: null,
    viewerExpanded: false,
    editor: { path: null, dirty: false, externalNonce: 0 },
  })
  queryClient.clear()
})

describe('the expand control', () => {
  it('removes the chat column, and the icon and tooltip flip together', async () => {
    const kind = KINDS[1]
    stubWorkbench(kind)
    const { container } = renderWorkbench()
    const code = await drawn(kind, container)

    // A split to begin with: the chat's column and the viewer's, sharing one group, with the divider
    // between them.
    expect(chatColumn(container)).not.toBeNull()
    expect(splitColumns(container)).toHaveLength(2)
    expect(splitSeparators(container)).toHaveLength(1)
    // The direction on offer is named, and so is its counterpart — the label moves with the state.
    expect(expand().getAttribute('title')).toBe('Expand the viewer over the chat column')
    expect(expand().getAttribute('aria-pressed')).toBe('false')

    // Nothing is written down anywhere: the layout is this session's and a restart opens split.
    const stored = JSON.stringify(localStorage)

    await userEvent.click(expand())

    // Gone from the tree rather than narrowed, and the viewer is the group's only column with nothing
    // left to divide it — which is what "it spans the chat's width too" means as a layout rather than as
    // a pixel count.
    expect(useWorkbenchStore.getState().viewerExpanded).toBe(true)
    expect(chatColumn(container)).toBeNull()
    expect(splitColumns(container)).toHaveLength(1)
    expect(splitColumns(container)[0]).toBe(viewerColumn(container))
    expect(splitSeparators(container)).toHaveLength(0)
    // The same node, not a fresh one: expanding must not remount the pane's contents.
    expect(container.contains(code)).toBe(true)
    expect(code.isConnected).toBe(true)
    expect(JSON.stringify(localStorage)).toBe(stored)

    // The other direction is now the one offered, and it says so.
    expect(restore().getAttribute('title')).toBe('Restore the chat column')
    expect(restore().getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Expand the viewer' })).toBeNull()

    // Escape is not a second control for it. The icon is the only one there is.
    await userEvent.keyboard('{Escape}')
    expect(useWorkbenchStore.getState().viewerExpanded).toBe(true)
    expect(chatColumn(container)).toBeNull()

    await userEvent.click(restore())

    expect(useWorkbenchStore.getState().viewerExpanded).toBe(false)
    expect(chatColumn(container)).not.toBeNull()
    expect(splitColumns(container)).toHaveLength(2)
    expect(splitSeparators(container)).toHaveLength(1)
    // Restored unchanged: the same viewer node is still the one on screen.
    expect(container.contains(code)).toBe(true)
    expect(expand().getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps a workbook’s tabs and grid while expanded, and after restore', async () => {
    const kind = KINDS[4]
    stubWorkbench(kind)
    const { container } = renderWorkbench()
    await drawn(kind, container)

    const tabs = await waitFor(() => {
      const group = screen.queryByRole('group', { name: 'Sheets' })
      if (group === null) throw new Error('the sheet tabs have not rendered yet')
      return group
    })
    const names = (group: HTMLElement) =>
      within(group)
        .getAllByRole('button')
        .map((tab) => tab.textContent)
    const firstTab = within(tabs).getByRole('button', { name: 'First' })
    expect(names(tabs)).toEqual(['First', 'Second', 'Third'])
    expect(firstTab.getAttribute('aria-pressed')).toBe('true')
    // The grid, drawn from the first sheet: a read-only cell carrying the file's own value.
    const gridCell = await waitFor(() => {
      const cell = container.querySelector<HTMLElement>('td[title="a1"]')
      if (cell === null) throw new Error('the grid has not rendered yet')
      return cell
    })
    expect(gridCell.textContent).toBe('a1')

    await userEvent.click(expand())

    // Every part of the workbook is still there — the tab strip, its three tabs, the pressed one, and
    // the cell itself — and the chat's column is what gave way for it.
    expect(chatColumn(container)).toBeNull()
    expect(screen.getByRole('group', { name: 'Sheets' })).toBe(tabs)
    expect(names(screen.getByRole('group', { name: 'Sheets' }))).toEqual(['First', 'Second', 'Third'])
    expect(within(tabs).getByRole('button', { name: 'First' }).getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('td[title="a1"]')).toBe(gridCell)
    expect(gridCell.isConnected).toBe(true)

    await userEvent.click(restore())

    expect(chatColumn(container)).not.toBeNull()
    expect(splitColumns(container)).toHaveLength(2)
    expect(screen.getByRole('group', { name: 'Sheets' })).toBe(tabs)
    expect(container.querySelector('td[title="a1"]')).toBe(gridCell)
  })
})

describe('every kind the viewer draws', () => {
  for (const kind of KINDS) {
    it(`renders ${kind.name} unchanged while expanded and after restore`, async () => {
      stubWorkbench(kind)
      const { container } = renderWorkbench()
      const node = await drawn(kind, container)
      // What the kind is showing, as text: the identity assertions below say the pane was not rebuilt,
      // and this says the same thing about what is *inside* the node — a tokenized file's characters, a
      // rendering's words, a diff's lines — which is where a rebuild would be visible even if the box
      // around it had survived. An image has no text, so it carries its source instead.
      const before = kind.name === 'an image' ? node.getAttribute('src') : node.textContent

      await userEvent.click(expand())

      expect(chatColumn(container)).toBeNull()
      expect(useWorkbenchStore.getState().viewerExpanded).toBe(true)
      // The same node, still in the document, with the same content: the pane rendered through the
      // layout change rather than being rebuilt by it.
      expect(container.contains(node)).toBe(true)
      expect(node.isConnected).toBe(true)
      expect(kind.name === 'an image' ? node.getAttribute('src') : node.textContent).toBe(before)

      await userEvent.click(restore())

      expect(chatColumn(container)).not.toBeNull()
      expect(container.contains(node)).toBe(true)
      expect(kind.name === 'an image' ? node.getAttribute('src') : node.textContent).toBe(before)
    })
  }

  it('keeps a tokenized file’s tokens, which are the one thing React does not reconcile', async () => {
    const kind = KINDS[1]
    stubWorkbench(kind)
    const { container } = renderWorkbench()
    const code = await drawn(kind, container)

    // The tokens themselves, counted rather than assumed: the source is highlighted either way, and a
    // token count of zero would be an uncoloured file wearing the same element.
    const tokens = () => container.querySelectorAll('code.hljs [class*="hljs-"]').length
    expect(tokens()).toBeGreaterThan(0)

    await userEvent.click(expand())

    expect(chatColumn(container)).toBeNull()
    expect(container.querySelector('code.hljs')).toBe(code)
    expect(code.textContent).toContain('export function add')
    expect(tokens()).toBeGreaterThan(0)

    await userEvent.click(restore())

    expect(chatColumn(container)).not.toBeNull()
    expect(container.querySelector('code.hljs')).toBe(code)
    expect(tokens()).toBeGreaterThan(0)
  })
})
