import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { Workbench } from '@/app/components/workbench/workbench'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The explorer's file-type glyphs, as a rendered workbench draws them.
 *
 * The rules behind the choice — which name asks for which key, and the fills each asset ships — are
 * proved without a DOM in `tests/ui/file-icons-rules-test.ts`. What only a rendered tree can show is
 * that the row reaches those rules: a known file gets its Material image in the box the Lucide glyph
 * occupied, an unknown file keeps the Lucide fallback, a named folder keeps one glyph in every state,
 * and a default folder's two states still tell collapsed from open.
 *
 * Rendered whole, over the same stand-in the explorer's double-click suite uses: the tree is a
 * resident of the workbench, and the drawer view is what puts it on screen.
 */

const standIn = vi.hoisted(() => ({ groups: new Map<string, { defaultLayout?: Record<string, number> }>() }))

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
  ResizablePanel: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <div data-panel id={id}>
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-separator />,
}))

const ROOT = 'C:/w'
const SRC = 'C:/w/src'
const VENDOR = 'C:/w/vendor'
const NOTES = 'C:/w/notes.ts'
const WEIRD = 'C:/w/weird.zzz'

/** The pending vendor listing's release, so the loading state is held deliberately rather than raced. */
let finishVendor: (() => void) | null = null

/**
 * The whole workbench, over a folder holding a known file, an unknown one, a named folder and a
 * folder with no icon of its own.
 *
 * The vendor listing is a promise this suite resolves by hand: that is what makes "expanded while
 * the listing is still in flight" a state the test can hold and assert, rather than a race it hopes
 * to observe.
 */
function stubWorkbench() {
  const stub = createBridgeStub({
    isMaximized: () => false,
    listDirectory: (input) => {
      const path = (input as { path: string }).path
      if (path === ROOT) {
        return [
          { name: 'src', path: SRC, isDirectory: true },
          { name: 'vendor', path: VENDOR, isDirectory: true },
          { name: 'notes.ts', path: NOTES, isDirectory: false },
          { name: 'weird.zzz', path: WEIRD, isDirectory: false },
        ]
      }
      if (path === VENDOR) {
        return new Promise<unknown[]>((resolve) => {
          finishVendor = () => resolve([])
        })
      }
      return []
    },
    readFile: (input) => {
      const path = (input as { path: string }).path
      return { path, content: '', baselineMtime: 0 }
    },
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
    diff: () => ({ lines: [], added: 0, removed: 0, truncated: false }),
    listProviders: () => [],
    defaultModels: () => ({}),
    listConfigured: () => [],
    listFilesFlat: () => [],
    openRoot: () => ROOT,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
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

/** One row of the tree, by the name it shows. Found rather than got: the listing arrives async. */
function row(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name })
}

function iconIn(element: HTMLElement): HTMLImageElement | null {
  return element.querySelector<HTMLImageElement>('img[data-slot="file-icon"]')
}

function namedIcon(element: HTMLElement, asset: string): boolean {
  const src = iconIn(element)?.getAttribute('src') ?? ''
  return new RegExp(`/${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.svg(?:\\?.*)?$`).test(src)
}

beforeEach(() => {
  standIn.groups.clear()
  finishVendor = null
  localStorage.clear()
  useWorkbenchStore.setState({
    activeActivity: 'files',
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

describe('a known file row', () => {
  it('draws its Material glyph in the row, and the row keeps its name', async () => {
    stubWorkbench()
    renderWorkbench()

    const notes = await row('notes.ts')

    expect(namedIcon(notes, 'typescript')).toBe(true)
    expect(notes.querySelector('svg.lucide-file-text')).toBeNull()
    // The box the Lucide glyph occupied, and no second source for the row's name.
    const icon = iconIn(notes)
    expect(icon?.getAttribute('class')).toContain('size-3.5')
    expect(icon?.getAttribute('alt')).toBe('')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.getAttribute('draggable')).toBe('false')
    expect(screen.getByRole('button', { name: 'notes.ts' })).toBe(notes)
  })
})

describe('an unknown file row', () => {
  it('keeps the Lucide fallback rather than inventing an icon', async () => {
    stubWorkbench()
    renderWorkbench()

    const weird = await row('weird.zzz')

    expect(iconIn(weird)).toBeNull()
    expect(weird.querySelector('svg.lucide-file-text')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'weird.zzz' })).toBe(weird)
  })
})

describe('a named folder row', () => {
  it('draws one Material glyph in every state', async () => {
    stubWorkbench()
    renderWorkbench()

    const src = await row('src')
    expect(namedIcon(src, 'folder-src')).toBe(true)
    expect(src.querySelector('svg.lucide-folder')).toBeNull()
    expect(src.querySelector('svg.lucide-folder-open')).toBeNull()

    await userEvent.click(src)
    await waitFor(() => expect(src.getAttribute('aria-expanded')).toBe('true'))

    // State-invariant: opened, it is still the same folder glyph rather than a second asset.
    expect(namedIcon(src, 'folder-src')).toBe(true)
    expect(src.querySelector('svg.lucide-folder-open')).toBeNull()
  })
})

describe('a folder with no icon of its own', () => {
  it('keeps the Lucide pair, and the pair follows the settled open state', async () => {
    stubWorkbench()
    renderWorkbench()

    const vendor = await row('vendor')
    expect(iconIn(vendor)).toBeNull()
    expect(vendor.querySelector('svg.lucide-folder')).not.toBeNull()
    expect(vendor.querySelector('svg.lucide-folder-open')).toBeNull()

    // Expanded while the listing is still in flight: open is not settled, so the collapsed glyph stays.
    await userEvent.click(vendor)
    expect(vendor.getAttribute('aria-expanded')).toBe('false')
    expect(vendor.querySelector('svg.lucide-folder')).not.toBeNull()
    expect(vendor.querySelector('svg.lucide-folder-open')).toBeNull()

    // Settled: the row is open, and the glyph says so.
    await act(async () => finishVendor?.())
    await waitFor(() => expect(vendor.getAttribute('aria-expanded')).toBe('true'))
    expect(vendor.querySelector('svg.lucide-folder-open')).not.toBeNull()
    expect(vendor.querySelector('svg.lucide-folder')).toBeNull()
  })
})

describe('every file-type icon', () => {
  it('is hidden from assistive technology', async () => {
    stubWorkbench()
    renderWorkbench()

    await row('notes.ts')
    const icons = [...document.querySelectorAll<HTMLImageElement>('img[data-slot="file-icon"]')]
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon.getAttribute('aria-hidden')).toBe('true')
      expect(icon.getAttribute('alt')).toBe('')
    }
  })
})
