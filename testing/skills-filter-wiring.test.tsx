/**
 * The composer picker's filter, as wiring.
 *
 * `filterSkillSummaries` is tested directly in the node suite — it is a pure function over id, title and
 * summary, and the cases there are the ones a filter has to get right. What is left for a DOM test is
 * the part a rule cannot see: that the box exists, that typing into it narrows the rows the picker is
 * drawing, that it narrows by all three fields, and that it narrows the *pickable* list rather than only
 * the visible one.
 *
 * The listing is a fixture, deliberately: this file is about the control, and the scan is the tiers
 * suite's subject. The transport is the real conveyor client over a stubbed bridge.
 */
import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import type { SkillListing, SkillTierListing } from '@/conveyor/protocol/skills'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * A viewport for the virtualized transcript, which jsdom does not have.
 *
 * The same three-lines-of-jsdom as the other composer suite: `@tanstack/react-virtual` sizes its window
 * from the scroll element's own measured size, both of which read as 0 in jsdom, and a zero-height
 * window renders no rows. Nothing here asserts on pixels.
 */
const VIEWPORT = { width: 900, height: 800 }
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => VIEWPORT.width })
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => VIEWPORT.height })

const SESSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111'

/** Four skills whose three matchable fields are deliberately different words. */
const SKILLS: SkillTierListing[] = [
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
    skills: [
      {
        id: 'deploy-runbook',
        scope: 'user',
        tier: 'user-native',
        title: 'Deploy Runbook',
        summary: 'Ship it, then watch the logs.',
        tags: [],
        sourcePath: 'C:/u/era/skills/deploy-runbook/SKILL.md',
      },
    ],
  },
  { tier: 'user-compat', scope: 'user', kind: 'compat', sourceDir: 'C:/u/.agents/skills', skills: [] },
]

const LISTING: SkillListing = {
  tiers: SKILLS,
  errors: [],
  disabled: [],
  counts: { total: 3, project: 2, user: 1, errors: 0, hidden: 0 },
}

const STORE_CHANNEL = `conveyor:store:${CHAT_SESSIONS_STORE_ID}`

async function renderChat(options: { listing?: SkillListing } = {}) {
  const stub = createBridgeStub({
    listSkills: () => options.listing ?? LISTING,
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

  // The store's own channel is answered by the seed, so a dispatch on it never reaches the stub's call
  // record. The forwarder below sees the same `{ payload }` envelope conveyor sends in production, so
  // what it reports is the payload main would have received rather than a reconstruction of it — the
  // same capture the skills-wiring suite makes, for the same reason.
  const dispatches: Array<{ method: string; payload: unknown }> = []
  const invoke = stub.bridge.invoke
  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === STORE_CHANNEL) {
      dispatches.push({ method, payload: (args[0] as { payload?: unknown } | undefined)?.payload })
    }
    return invoke(channel, method, ...args)
  }

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
  await screen.findByRole('button', { name: /Code Review/ })

  return {
    stub,
    /** What the pane asked the session store to do, by action name. */
    storePayloads: (method: string) => dispatches.filter((d) => d.method === method).map((d) => d.payload),
  }
}

/** The filter box, by its own label. */
function filterBox(): HTMLInputElement {
  return screen.getByLabelText('Filter skills') as HTMLInputElement
}

/** The skill rows the picker is currently offering, read off the popover's own slot. */
function rowTitles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="skill-picker-row"]')).map(
    (node) => node.textContent ?? ''
  )
}

describe('the composer picker’s filter', () => {
  it('offers every skill before anything is typed, and narrows as the query is typed', async () => {
    await renderChat()

    expect(filterBox()).toBeTruthy()
    expect(rowTitles()).toHaveLength(3)

    await userEvent.type(filterBox(), 'review')

    await waitFor(() => expect(rowTitles()).toHaveLength(1))
    expect(rowTitles()[0]).toContain('Code Review')
    // The scope headings stay put while the rows narrow, so the list does not appear to change shape.
    expect(screen.getByText('Project')).toBeTruthy()
  })

  it('narrows by the id, by the title and by the summary', async () => {
    await renderChat()

    // The id is the folder name, and it is what a user who knows the skill types.
    await userEvent.type(filterBox(), 'deploy-runbook')
    await waitFor(() => expect(rowTitles()).toHaveLength(1))
    expect(rowTitles()[0]).toContain('Deploy Runbook')

    await userEvent.clear(filterBox())
    // The title, with a different case than the row states.
    await userEvent.type(filterBox(), 'RELEASE')
    await waitFor(() => expect(rowTitles()).toHaveLength(1))
    expect(rowTitles()[0]).toContain('Release Notes')

    await userEvent.clear(filterBox())
    // And the summary: `changelog` appears in no title and in no id.
    await userEvent.type(filterBox(), 'changelog')
    await waitFor(() => expect(rowTitles()).toHaveLength(1))
    expect(rowTitles()[0]).toContain('Release Notes')
  })

  it('says so when a query matches nothing, and offers the whole list again when it is cleared', async () => {
    await renderChat()

    await userEvent.type(filterBox(), 'nothing-matches-this')

    await waitFor(() => expect(rowTitles()).toHaveLength(0))
    expect(screen.getByText(/no skills match/i)).toBeTruthy()

    await userEvent.clear(filterBox())
    await waitFor(() => expect(rowTitles()).toHaveLength(3))
  })

  it('leaves a filtered-out skill out of what can be picked, not only out of what is drawn', async () => {
    const { storePayloads } = await renderChat()

    await userEvent.type(filterBox(), 'deploy')

    await waitFor(() => expect(rowTitles()).toHaveLength(1))
    // The row the filter kept is the one that is still pickable, and clicking it activates that skill.
    await userEvent.click(await screen.findByRole('button', { name: /Deploy Runbook/ }))

    await waitFor(() => expect(storePayloads('touchSession').length).toBe(1))
    expect(storePayloads('touchSession')[0]).toEqual({ id: SESSION_ID, activeSkillIds: ['deploy-runbook'] })
    // And the row the filter hid is out of the picker rather than merely hidden in it: a filtered-out
    // skill cannot be turned on from behind a query.
    expect(screen.queryByRole('button', { name: /Code Review/ })).toBeNull()
  })
})
