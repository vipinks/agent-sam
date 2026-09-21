import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { CodeViewer } from '@/app/components/workbench/code-viewer'
import { AgentActionCard } from '@/app/components/workbench/agent-action-card'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { ToolStep } from '@/app/components/workbench/agent-session'
import { queryClient } from '@/conveyor/client'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * DiffView's height policy, asserted through both of its real hosts.
 *
 * The defect this pins: `DiffView` was extracted from the agent's approval card carrying that card's
 * capped height (`max-h-64` plus `overflow-auto` on its scroll region). The card wants a cap — it sits
 * inside a transcript that already limits its own `pre`s to `max-h-40`/`max-h-52`, and a long diff
 * there must not push the rest of the conversation off the screen. The diff *pane* wants the opposite:
 * it is the whole point of the pane, so its scroll region has to fill the pane, or the container
 * collapses to content-or-cap height and leaves dead space below it with the scrollbar thumb parked at
 * the last line.
 *
 * The honest ceiling of these assertions. jsdom does not lay out: every element reports a zero-height
 * box, `getComputedStyle` resolves no widths or heights against a real container, and nothing here can
 * observe that a region visually fills a pane. So this suite asserts the *classes* that express each
 * policy — which is a real assertion, because those classes are the entire mechanism and the wiring
 * that chooses between them is what regressed — and the fill itself is verified visually in the live
 * app. A class-level test would not catch a cascade override; it does catch the policy being wrong or
 * not passed down, which is the failure that actually happened.
 *
 * The real hosts are rendered rather than `DiffView` in isolation, deliberately: the bug lived in the
 * host's choice, not in DiffView's own markup, so a test that mounted DiffView directly would have
 * passed against the broken code.
 */

const ROOT = 'C:/w'
const PATH = 'src/app.ts'

/** The two lines every case renders, so the scroll region is findable by its content. */
const DIFF = {
  lines: [
    { kind: 'removed' as const, text: 'const a = 1' },
    { kind: 'added' as const, text: 'const a = 2' },
  ],
  added: 1,
  removed: 1,
  truncated: false,
}

/**
 * The scroll region and the DiffView root that holds it, found through the diff's own text.
 *
 * Located by content rather than by a selector, because the point is to assert on whatever element
 * actually ends up scrolling the lines — a test that hardcoded a wrapper's position in the tree would
 * pass while the lines scrolled somewhere else.
 */
function diffParts(root: HTMLElement): { scrollRegion: HTMLElement; diffRoot: HTMLElement } {
  const scrollRegion = [...root.querySelectorAll<HTMLElement>('pre')].find((pre) =>
    pre.textContent?.includes('const a = 2')
  )
  if (!scrollRegion) throw new Error('no diff scroll region rendered')

  const diffRoot = scrollRegion.parentElement
  if (!diffRoot) throw new Error('the diff scroll region has no host element')

  return { scrollRegion, diffRoot }
}

/** The pane host: the Code Viewer with one change selected, which is what its diff branch shows. */
function renderPane(): HTMLElement {
  const stub = createBridgeStub({
    diff: () => DIFF,
    listDirectory: () => [],
    status: () => [],
    branch: () => ({ name: 'main', detached: false, upstream: null, ahead: 0, behind: 0 }),
    log: () => [],
    localBranches: () => ['main'],
  })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  setActiveStub(stub)

  useWorkbenchStore.setState({
    activeActivity: 'files',
    selectedFile: null,
    selectedChange: { path: PATH, side: 'unstaged' },
    editor: { path: null, dirty: false, externalNonce: 0 },
  })

  const view = render(
    <QueryClientProvider client={queryClient}>
      <CodeViewer />
    </QueryClientProvider>
  )
  return view.container
}

/** The card host: an approval card, forced open by the state that forces it — a pending decision. */
function renderCard(): HTMLElement {
  // `awaiting` is one of the two states the card forces open, which is why the diff is on screen here
  // without a click: a gated write is approved after being read.
  //
  // The args deliberately do not contain the diff's own text. The card renders the arguments in a `pre`
  // of its own, above the diff, so echoing the marker here would make the content-based lookup below
  // find the arguments block instead of the scroll region — and it would then assert the card's height
  // policy against the wrong element, passing for the wrong reason.
  const step: ToolStep = {
    callId: 'call-1',
    tool: 'write_file',
    args: { path: PATH, content: 'the body being written\n' },
    status: 'awaiting',
    diff: DIFF,
  }

  const view = render(<AgentActionCard step={step} onApprove={() => {}} onDeny={() => {}} />)
  return view.container
}

describe('the diff pane’s DiffView', () => {
  it('fills the pane: the scroll region grows and has no cap', async () => {
    const container = renderPane()

    // The diff arriving is what puts the region on screen; the assertion is about its height.
    expect(await screen.findByText(/const a = 2/)).toBeTruthy()

    const { scrollRegion, diffRoot } = diffParts(container)

    // The chain the pane needs: a flex column that takes the full height of its wrapper, and a scroll
    // region that absorbs the remainder rather than stopping at a cap. `min-h-0` at both levels is what
    // lets a child shrink below its content, without which a long diff would overflow the pane instead
    // of scrolling inside it.
    expect(diffRoot.className).toMatch(/\bh-full\b/)
    expect(diffRoot.className).toMatch(/\bflex-col\b/)
    expect(scrollRegion.className).toMatch(/\bflex-1\b/)
    expect(scrollRegion.className).toMatch(/\bmin-h-0\b/)
    expect(scrollRegion.className).toMatch(/\boverflow-auto\b/)

    // The regression itself: the card's cap must not reach the pane, or the region collapses to
    // content-or-cap height and the pane below it is dead space.
    expect(scrollRegion.className).not.toMatch(/max-h-64/)
    expect(diffRoot.className).not.toMatch(/max-h-64/)
  })

  it('keeps the diff readable and unchanged in the pane', async () => {
    const container = renderPane()
    await screen.findByText(/const a = 2/)

    // The fix is a height policy, so nothing about the content moved: the counts, the markers and the
    // per-line colouring are all still what the card renders.
    expect(screen.getByText('1 added, 1 removed')).toBeTruthy()
    const { scrollRegion } = diffParts(container)
    expect(scrollRegion.textContent).toBe('- const a = 1+ const a = 2')
  })
})

describe('the approval card’s DiffView', () => {
  it('keeps today’s cap exactly: the scroll region stops at max-h-64', () => {
    const container = renderCard()
    const { scrollRegion, diffRoot } = diffParts(container)

    expect(scrollRegion.className).toMatch(/max-h-64/)
    expect(scrollRegion.className).toMatch(/overflow-auto/)

    // And nothing from the pane's policy leaked the other way: the card's region neither grows to fill
    // nor takes the pane's flex chain, so a long diff still cannot push the conversation off screen.
    expect(scrollRegion.className).not.toMatch(/\bflex-1\b/)
    expect(diffRoot.className).not.toMatch(/\bh-full\b/)
    expect(diffRoot.className).not.toMatch(/\bflex-col\b/)

    // The card's own top margin is unchanged too — it passes no className, so the default stands.
    expect(diffRoot.className).toMatch(/mt-1\.5/)
  })
})
