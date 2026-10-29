import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The session row's always-visible actions menu.
 *
 * jsdom has neither layout nor hit testing, so the two geometry assertions use a small local adapter:
 * `measuredRect` turns a Tailwind size token into the rect jsdom would produce if it laid the element
 * out, and `installHitTest` models the row's right-centre in paint order. The hit-test deliberately
 * includes opacity-0 nodes, because a browser still delivers pointer events to them — that is the
 * defect this suite holds.
 */

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const ROOT = 'C:/work/sam-ai'
const NOTES = 'C:/work/notes'
const TITLE = 'project work'

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [] })
})

afterEach(() => {
  // `installHitTest` installs a jsdom-only method. Removing it keeps the rest of the DOM suite honest:
  // anything else that asks for hit testing should see jsdom's own missing implementation.
  Reflect.deleteProperty(document, 'elementFromPoint')
})

function renderPanel() {
  const onExport = vi.fn()
  const onMove = vi.fn()
  const stub = createBridgeStub({ loadTranscript: () => null })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, {
    sessions: [
      {
        id: SESSION_ID,
        title: TITLE,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_002,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        lastRoot: ROOT,
      },
    ],
    activeSessionId: null,
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [ROOT, NOTES] })
  setActiveStub(stub)

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <SessionListPanel
          onCreate={vi.fn()}
          onOpen={vi.fn()}
          onRename={vi.fn()}
          onExport={onExport}
          onDelete={vi.fn()}
          onMove={onMove}
          error={null}
          notice={null}
        />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )

  return { onExport, onMove }
}

async function ready(): Promise<void> {
  await screen.findByText(TITLE)
}

/**
 * Open the row menu from the keyboard.
 *
 * Radix's dropdown trigger toggles on `pointerdown`; jsdom's synthetic click path is not a reliable
 * substitute, which is the same limitation the repo's select suites already document. Enter invokes the
 * trigger's own keyboard path, so the menu under test is the real one.
 */
async function openActions(): Promise<HTMLElement> {
  const trigger = screen.getByLabelText(`Session actions for ${TITLE}`)
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  return screen.findByRole('menu')
}

/**
 * A measured box for an element whose visual size comes from a Tailwind token.
 *
 * jsdom returns zeroes from `getBoundingClientRect` even when a class says `size-9`. The adapter reads
 * the token the component actually declares and exposes it through the same API, so the assertion still
 * names pixels rather than a class substring.
 */
function measuredRect(element: HTMLElement): DOMRect {
  const tokens = element.className.split(/\s+/).filter(Boolean)
  const size = tokens.find((token) => /^size-\d+$/.test(token))
  const height = tokens.find((token) => /^h-\d+$/.test(token))
  const width = tokens.find((token) => /^w-\d+$/.test(token))
  const px = (token: string | undefined) => (token ? Number(token.split('-')[1]) * 4 : 0)
  const edge = size ? px(size) : Math.max(px(height), px(width))
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: edge,
    bottom: edge,
    width: edge,
    height: edge,
    toJSON: () => ({}),
  } as DOMRect

  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect })
  return element.getBoundingClientRect()
}

function setBox(element: Element, box: { left: number; top: number; width: number; height: number }): DOMRect {
  const rect = {
    x: box.left,
    y: box.top,
    top: box.top,
    left: box.left,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    toJSON: () => ({}),
  } as DOMRect
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect })
  return rect
}

function contains(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/**
 * Model the row as 260px wide and 52px tall, with the action affordance at its right edge.
 *
 * The old cluster is absolutely positioned at right-3 and is included in paint order even while it is
 * opacity-0, exactly as a browser would hit-test it. The new trigger is 36x36 and sits 12px from the
 * right edge with the row's gap and padding.
 */
function installHitTest(li: HTMLElement): { x: number; y: number } {
  const row = li.firstElementChild as HTMLElement
  const titleButton = screen.getByText(TITLE).closest('button') as HTMLElement
  setBox(row, { left: 0, top: 0, width: 260, height: 52 })
  setBox(titleButton, { left: 32, top: 0, width: 160, height: 52 })

  const trigger = screen.queryByLabelText(`Session actions for ${TITLE}`)
  if (trigger) setBox(trigger, { left: 212, top: 8, width: 36, height: 36 })

  const candidates: Element[] = [titleButton]
  const oldCluster = li.querySelector<HTMLElement>('div.absolute.opacity-0')
  if (oldCluster) {
    setBox(oldCluster, { left: 152, top: 10, width: 96, height: 32 })
    const buttons = [...oldCluster.querySelectorAll<HTMLElement>('button')]
    buttons.forEach((button, index) => {
      setBox(button, { left: 152 + index * 24, top: 10, width: 24, height: 32 })
      candidates.push(button)
    })
  }
  if (trigger) candidates.push(trigger)

  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number): Element | null => {
      const hits = candidates.filter((candidate) => contains(candidate.getBoundingClientRect(), x, y))
      // Later nodes paint on top; the row's action surface comes after the title in DOM order.
      return hits.at(-1) ?? null
    },
  })

  return { x: 236, y: 26 }
}

describe('the session row actions are always visible', () => {
  it('T1: renders a visible 36x36 session-actions trigger at idle', async () => {
    renderPanel()
    await ready()

    const trigger = screen.getByLabelText(`Session actions for ${TITLE}`)
    expect(trigger.className).not.toMatch(/(^|\s)opacity-0(\s|$)/)
    expect(trigger.className).not.toMatch(/(^|\s)absolute(\s|$)/)

    const rect = measuredRect(trigger)
    expect(rect.width).toBe(36)
    expect(rect.height).toBe(36)
  })

  it('T2: opens Rename, Move, Export with both formats, and Delete, and exports Markdown', async () => {
    const { onExport } = renderPanel()
    await ready()

    const menu = await openActions()
    expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Move to project' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()

    const exportTrigger = within(menu).getByRole('menuitem', { name: 'Export' })
    fireEvent.click(exportTrigger)
    const exportMenu = await screen.findByRole('menu', { name: 'Export' })
    expect(within(exportMenu).getByRole('menuitem', { name: 'Markdown' })).toBeTruthy()
    expect(within(exportMenu).getByRole('menuitem', { name: 'JSON' })).toBeTruthy()

    await userEvent.click(within(exportMenu).getByRole('menuitem', { name: 'Markdown' }))
    expect(onExport).toHaveBeenCalledWith(SESSION_ID, 'markdown', TITLE)
  })

  it('T3: hit-tests the row right-centre to the title or trigger, never a hidden action', async () => {
    renderPanel()
    await ready()

    const li = screen.getByText(TITLE).closest('li') as HTMLElement
    const point = installHitTest(li)
    const hit = document.elementFromPoint(point.x, point.y)
    const titleButton = screen.getByText(TITLE).closest('button') as HTMLElement
    const trigger = screen.getByLabelText(`Session actions for ${TITLE}`)

    expect([titleButton, trigger]).toContain(hit)
    expect(li.querySelector('div.absolute.opacity-0')).toBeNull()
  })

  it('T4: portals the open menu to document.body, outside the row', async () => {
    renderPanel()
    await ready()

    const li = screen.getByText(TITLE).closest('li') as HTMLElement
    const menu = await openActions()

    expect(document.body.contains(menu)).toBe(true)
    expect(li.contains(menu)).toBe(false)
  })
})
