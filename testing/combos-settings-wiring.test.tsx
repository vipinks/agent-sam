import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { Combo } from '@/conveyor/protocol/combos'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The Combos section, as wiring: every control it offers reaches the command it names, with the
 * payload main's schema expects, and a refusal is worded from its code.
 *
 * The rules themselves are the node suites' — this is the renderer's half: a control wired to the
 * wrong member, or a payload carrying a display name where an id belongs, would typecheck and then
 * quietly change nothing. The refusal case is here because branching on the code rather than on
 * main's sentence is a claim only the screen can make.
 */

const COMBOS: Combo[] = [
  {
    id: 'fast',
    name: 'Fast answers',
    members: [
      { providerId: 'deepseek', modelId: 'deepseek-chat' },
      { providerId: 'deepseek', modelId: 'deepseek-reasoner' },
    ],
    enabled: true,
  },
]

const TARGETS = [{ providerId: 'deepseek', providerName: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] }]

interface Call {
  member: string
  input: unknown
}

function stubSettings(
  calls: Call[],
  overrides: Record<string, (input: unknown) => unknown> = {}
): ReturnType<typeof createBridgeStub> {
  const stub = createBridgeStub({
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }],
    defaultModels: () => ({ deepseek: [{ id: 'deepseek-chat' }] }),
    listConfigured: () => ['deepseek'],
    isEncryptionAvailable: () => true,
    knownTargets: () => TARGETS,
    list: () => COMBOS,
    create: (input) => {
      calls.push({ member: 'create', input })
      return {}
    },
    rename: (input) => {
      calls.push({ member: 'rename', input })
      return {}
    },
    reorder: (input) => {
      calls.push({ member: 'reorder', input })
      return {}
    },
    addMember: (input) => {
      calls.push({ member: 'addMember', input })
      return {}
    },
    removeMember: (input) => {
      calls.push({ member: 'removeMember', input })
      return {}
    },
    setEnabled: (input) => {
      calls.push({ member: 'setEnabled', input })
      return {}
    },
    delete: (input) => {
      calls.push({ member: 'delete', input })
      return {}
    },
    ...overrides,
  })
  stubStore(stub, 'combos', { combos: COMBOS })
  setActiveStub(stub)
  return stub
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  useWorkbenchStore.setState({ settingsSection: 'combos', activeActivity: 'settings' })
})

/** Open one picker by its accessible name and pick the option whose text matches. */
async function choose(triggerName: string | RegExp, optionText: string, index = 0): Promise<void> {
  const triggers = screen.getAllByLabelText(triggerName)
  const trigger = triggers[index]
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const listbox = await screen.findByRole('listbox')
  const option = Array.from(listbox.querySelectorAll('[role="option"]')).find(
    (candidate) => (candidate.textContent ?? '').trim() === optionText
  )
  if (!option) throw new Error(`no option named ${optionText}`)
  await userEvent.click(option)
}

describe('the Combos settings section', () => {
  it('renders the section and its list', async () => {
    stubSettings([])
    renderSettings()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Combos' })).toBeTruthy())
    expect(screen.getByText('Fast answers')).toBeTruthy()
    expect(screen.getByText('2 of 8')).toBeTruthy()
  })

  it('creates a combo with its first member', async () => {
    const calls: Call[] = []
    stubSettings(calls)
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await userEvent.type(screen.getByLabelText('Name'), 'Work')
    await choose('Provider', 'DeepSeek')
    await choose(/^Model:/, 'deepseek-chat')
    await userEvent.click(screen.getByRole('button', { name: /Add combo/ }))

    await waitFor(() =>
      expect(calls).toContainEqual({
        member: 'create',
        input: { name: 'Work', providerId: 'deepseek', modelId: 'deepseek-chat' },
      })
    )
  })

  it('renames inline', async () => {
    const calls: Call[] = []
    stubSettings(calls)
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await userEvent.click(screen.getByRole('button', { name: 'Rename Fast answers' }))
    const field = screen.getByLabelText('Rename Fast answers')
    await userEvent.clear(field)
    await userEvent.type(field, 'Speedy')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(calls).toContainEqual({ member: 'rename', input: { id: 'fast', name: 'Speedy' } }))
  })

  it('reorders a member, toggles the switch, adds and removes members', async () => {
    const calls: Call[] = []
    stubSettings(calls)
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await userEvent.click(screen.getByRole('button', { name: 'Move deepseek-chat down' }))
    await waitFor(() => expect(calls).toContainEqual({ member: 'reorder', input: { id: 'fast', from: 0, to: 1 } }))

    await userEvent.click(screen.getByRole('switch', { name: 'Offer Fast answers in the picker' }))
    await waitFor(() => expect(calls).toContainEqual({ member: 'setEnabled', input: { id: 'fast', enabled: false } }))

    await choose('Provider', 'DeepSeek', 1)
    await choose(/^Model:/, 'deepseek-reasoner', 1)
    await userEvent.click(screen.getByRole('button', { name: 'Add member to Fast answers' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        member: 'addMember',
        input: { id: 'fast', providerId: 'deepseek', modelId: 'deepseek-reasoner' },
      })
    )

    await userEvent.click(screen.getByRole('button', { name: 'Remove deepseek-reasoner' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        member: 'removeMember',
        input: { id: 'fast', providerId: 'deepseek', modelId: 'deepseek-reasoner' },
      })
    )
  })

  it('deletes through the confirmation', async () => {
    const calls: Call[] = []
    stubSettings(calls)
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await userEvent.click(screen.getByRole('button', { name: 'Delete Fast answers' }))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(calls).toContainEqual({ member: 'delete', input: { id: 'fast' } }))
  })

  it('words a refusal from its COMBO_* code', async () => {
    stubSettings([], {
      addMember: () => {
        throw new ConveyorError('COMBO_LIMIT', 'main wrote this sentence')
      },
    })
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await choose('Provider', 'DeepSeek', 1)
    await choose(/^Model:/, 'deepseek-reasoner', 1)
    await userEvent.click(screen.getByRole('button', { name: 'Add member to Fast answers' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('at most 8 members')
    // Branched on the code, not the sentence: main's wording is deliberately absent.
    expect(alert.textContent).not.toContain('main wrote this sentence')
  })
})
