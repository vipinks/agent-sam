import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { SessionListPanel } from '@/app/components/workbench/session-list-panel'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { queryClient } from '@/conveyor/client'
import { ENGINE_LABELS } from '@/conveyor/protocol/engine'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The conversation list row's meta line, for a conversation an engine ran.
 *
 * `session-row-test.ts` owns the rule that decides the label; what only a rendered row can show is that the
 * label reaches the line, beside the age and ahead of nothing, and that the pair it replaces is nowhere in
 * the row — not in the text, and not in the tooltip that explains the text. A list that kept drawing
 * `deepseek/deepseek-chat` under a conversation Codex answered is the defect this file records.
 *
 * A Sam conversation is asserted beside it, because the two are one rule: the pair has to come back exactly
 * as it was for every conversation that names no engine, and a fix that quietly relabelled those rows would
 * be the same defect pointing the other way.
 *
 * jsdom proves wiring and words, not pixels. What this file cannot show is that the line reads well at 11px
 * with a long engine name in a narrow drawer; that is Boss's eyes on the session list with an engine
 * session present.
 */

const ENGINE = 'codex'
const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222'

/** The folder both conversations belong to, so the list draws one group with two rows. */
const ROOT = 'C:/work/sam-ai'

/** The pair a Sam conversation shows, and the one an engine conversation must stop showing. */
const SAM_PAIR = 'deepseek/deepseek-chat'

interface SessionRow {
  id: string
  title: string
  engineId?: string
}

/**
 * The app's transport, with the two stores this panel reads.
 *
 * The seed is written the way main holds it: `engineId` present only on the conversation that names one,
 * because absence is the Sam loop and a default written here would be a value the record never carries.
 */
function stubList(sessions: SessionRow[]): void {
  const workspace = { rootPath: ROOT, recentRoots: [ROOT] }

  const state = {
    sessions: sessions.map((session, index) => ({
      id: session.id,
      title: session.title,
      createdAt: 1_700_000_000_000 + index,
      updatedAt: 1_700_000_000_000 + index,
      providerId: 'deepseek',
      model: 'deepseek-chat',
      lastRoot: ROOT,
      ...(session.engineId === undefined ? {} : { engineId: session.engineId }),
    })),
    activeSessionId: null,
  }

  const stub = createBridgeStub({
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    searchSessions: () => [],
    listDirectory: () => [],
    pickFolder: () => null,
    openRoot: (input) => ({ path: (input as { path: string }).path }),
  })

  stubStore(stub, CHAT_SESSIONS_STORE_ID, state)
  stubStore(stub, 'workspace', workspace)
  setActiveStub(stub)
}

/** The panel as the workbench wires it, over the app's own query client. */
function renderList() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionListPanel
        onCreate={() => {}}
        onOpen={() => {}}
        onRename={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        error={null}
        notice={null}
      />
    </QueryClientProvider>
  )
}

/** One row's clickable body: the button that carries the title and the meta line. */
function rowFor(title: HTMLElement): HTMLElement {
  return title.closest('button') as HTMLElement
}

/** The meta line itself, which is the paragraph the time and the label share. */
function metaLine(row: HTMLElement): HTMLElement {
  const label = row.querySelector('span.font-mono')
  if (!label) throw new Error('no meta label span on the row')
  return label.closest('p') as HTMLElement
}

beforeEach(() => {
  queryClient.clear()
  useWorkbenchStore.setState({ collapsedSessionGroups: [] })
})

describe("the conversation list row's meta line", () => {
  it('names the engine for a conversation it ran, and shows the stored pair nowhere', async () => {
    stubList([
      { id: FIRST, title: 'codex work', engineId: ENGINE },
      { id: SECOND, title: 'parser work' },
    ])
    renderList()

    // The state arrives on the store mirror's own read, so a cold mirror's first paint is the empty list:
    // the row is awaited rather than queried, or the assertion would be about that first paint instead.
    const row = rowFor(await screen.findByText('codex work'))

    // The engine's own label, in the row, after the age: the label text and the tooltip that explains it.
    expect(within(row).getByText(ENGINE_LABELS[ENGINE])).toBeTruthy()
    expect(within(row).getByTitle(ENGINE_LABELS[ENGINE])).toBeTruthy()

    // And the pair is gone from the row entirely — the text a user reads and the tooltip they hover.
    expect(row.textContent).not.toContain(SAM_PAIR)
    expect(row.innerHTML).not.toContain('deepseek')

    // The age still leads the line, and the separator between the two is the row's own.
    expect(metaLine(row).textContent).toMatch(/\S·ChatGPT \(Codex\)$/)
  })

  it('keeps the provider and model pair for a conversation that names no engine', async () => {
    stubList([
      { id: FIRST, title: 'codex work', engineId: ENGINE },
      { id: SECOND, title: 'parser work' },
    ])
    renderList()

    const row = rowFor(await screen.findByText('parser work'))

    // Exactly today's reading: the pair with the row's slash, and the middot spelling in the tooltip.
    expect(within(row).getByText(SAM_PAIR)).toBeTruthy()
    expect(within(row).getByTitle('deepseek · deepseek-chat')).toBeTruthy()
    expect(metaLine(row).textContent).toMatch(/\S·deepseek\/deepseek-chat$/)
    expect(row.textContent).not.toContain(ENGINE_LABELS[ENGINE])
  })
})
