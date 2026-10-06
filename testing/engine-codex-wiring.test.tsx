/**
 * The Codex engine, as the renderer sees it: the picker's row once a probe found the CLI, the transcript a
 * captured turn produces, and the `via Codex` marker on a call the engine ran.
 *
 * The chunks these cases apply are the real ones — the captured fixture, read off disk, through the real
 * mapper and the real transcript mapper — so what is asserted is the whole chain from the CLI's own output to
 * the words on the card, with nothing hand-written in between.
 *
 * What this file does not drive is the transport: the panel's own `engine.turn` call is typed by the schema the
 * module registers and its kill path is the node suite's, and a jsdom suite that faked a stream envelope would
 * be proving its own stub. jsdom proves wiring and words, not pixels — that the picker and the marker read
 * correctly in both themes is Boss's eyes on the running app.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { AgentActionCard } from '@/app/components/workbench/agent-action-card'
import {
  applyAgentChunk,
  startAssistantTurn,
  type AgentTurn,
  type ToolStep,
} from '@/app/components/workbench/agent-session'
import { ChatPanel } from '@/app/components/workbench/chat-panel'
import { ChatSessionsProvider } from '@/app/components/workbench/chat-sessions-context'
import { queryClient } from '@/conveyor/client'
import { mapCodexLine, type CodexUpdate } from '@/conveyor/protocol/codex-jsonl'
import { codexTranscriptChunks } from '@/conveyor/protocol/codex-turn'
import { ENGINE_LABELS, engineRows } from '@/conveyor/protocol/engine'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

const ROOT = 'C:/work/sam-ai'
const CODEX = 'codex'

/** The version the probe on this machine answered, so the assertion is the real string. */
const PROBED_VERSION = '0.154.0-alpha.6.2'

const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]
const DEFAULT_MODELS = { deepseek: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }

/** The captured tool run, mapped through the real mapper into the real transcript chunk dialect. */
function capturedChunks(): unknown[] {
  const lines = readFileSync(
    join(process.cwd(), 'tests', 'engines', 'fixtures', 'codex-exec-tool-capture.jsonl'),
    'utf8'
  )
    .split('\n')
    .filter((line) => line.trim() !== '')

  let threadId: string | null = null
  const updates: CodexUpdate[] = []
  for (const line of lines) {
    const mapped = mapCodexLine(line, threadId)
    threadId = mapped.threadId
    updates.push(...mapped.updates)
  }

  return codexTranscriptChunks(updates, CODEX)
}

/** Fold those chunks into one assistant turn, exactly as the panel's run loop does. */
function transcriptOf(chunks: unknown[]): AgentTurn {
  let turns: AgentTurn[] = [startAssistantTurn()]
  const turnId = turns[0].id
  for (const chunk of chunks) turns = applyAgentChunk(turns, turnId, chunk).turns
  return turns[0]
}

function screenWithCodexDetected(): void {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => DEFAULT_MODELS,
    listConfigured: () => ['deepseek'],
    listFilesFlat: () => [],
    loadTranscript: () => null,
    saveTranscript: () => undefined,
    chatWithTools: () => undefined,
  })
  // The rows a probe would have published on this machine: the app's own loop first, then the engine, with the
  // version the CLI answered. Built by the protocol's own row rule so the label under test is the shipped one.
  stubStore(stub, 'engine-status', { rows: engineRows({ [CODEX]: { installed: true, version: PROBED_VERSION } }) })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, { sessions: [], activeSessionId: null })
  stubStore(stub, 'workspace', { rootPath: ROOT, recentRoots: [] })
  stubStore(stub, 'provider-config', { providers: {}, customProviders: [] })
  stubStore(stub, 'buddies', { custom: [], disabledIds: [] })
  stubStore(stub, 'engine-consent', { pending: null })

  setActiveStub(stub)
  render(
    <QueryClientProvider client={queryClient}>
      <ChatSessionsProvider>
        <ChatPanel />
      </ChatSessionsProvider>
    </QueryClientProvider>
  )
}

describe('the Codex engine in the renderer', () => {
  it('draws the picker row as detected, labelled from the shipped table and offered', async () => {
    screenWithCodexDetected()

    const engine = await screen.findByRole('combobox', { name: 'Engine' })
    // Open the list from the keyboard, the one path Radix routes without consulting the pointer: a row nobody can
    // open is a row nobody can choose.
    engine.focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByRole('listbox')

    const row = screen.getAllByRole('option').find((option) => option.textContent?.startsWith(ENGINE_LABELS[CODEX]))
    expect(row).toBeDefined()
    // Detected, which is what makes it selectable: an engine the probe did not find is offered and refused, and the
    // words for that are the protocol's own note rather than anything this suite writes.
    expect(row?.hasAttribute('disabled') || row?.getAttribute('data-disabled') !== null).toBe(false)

    // Choose it, with the arrow the list is walked with and then Enter: the trigger is what says the choice
    // landed, and its title carries the probed version once the row has answered "installed" and the next
    // question is "which one".
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(engine.getAttribute('title')).toContain(PROBED_VERSION)
  })

  it('turns a captured turn into narration and via-Codex markers, in the order the CLI printed them', () => {
    const turn = transcriptOf(capturedChunks())

    // The prose is the two agent messages, in order, joined as one answer — the tool's outcome does not become
    // prose of its own, because the card below carries it.
    expect(turn.content.indexOf('Running the command.')).toBeGreaterThanOrEqual(0)
    expect(turn.content.indexOf('hello', turn.content.indexOf('Running the command.'))).toBeGreaterThan(0)

    expect(turn.steps).toHaveLength(1)
    const step = turn.steps[0]
    expect(step.tool).toBe('run_command')
    expect(String(step.args.command)).toContain('echo hello')
    expect(step.via).toBe('Codex')
    expect(step.status).toBe('ok')
  })

  it('draws the marker on the card, and only on a call an engine ran', () => {
    const engineStep: ToolStep = {
      callId: 'item_2',
      tool: 'run_command',
      args: { command: "pwsh -Command 'echo hello'" },
      status: 'ok',
      output: 'hello',
      via: 'Codex',
    }
    const samStep: ToolStep = { callId: 'call-1', tool: 'read_file', args: { path: 'src/app.ts' }, status: 'ok' }

    const { unmount } = render(<AgentActionCard step={engineStep} />)
    expect(screen.getByText('via Codex')).toBeDefined()
    unmount()

    render(<AgentActionCard step={samStep} />)
    expect(screen.queryByText('via Codex')).toBeNull()
  })
})
