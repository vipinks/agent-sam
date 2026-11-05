import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { Combo } from '@/conveyor/protocol/combos'
import { createBridgeStub, setActiveStub, stubStore } from './bridge-stub'

/**
 * The model side of a combo member, as wiring: the trigger, the filter box that narrows the list, and
 * the row that carries the id into the payload.
 *
 * The list is long enough to need narrowing — that is the whole D1 change — so the registry below has
 * two providers with several models each. What a DOM test can say that a rule cannot: the filter
 * narrows the rows the user can pick (not only the rows drawn), the trigger says what a provider
 * change did to the choice, and a term that matches nothing says so instead of offering an empty box.
 *
 * The provider picker itself is deliberately not under test here: it stays the bare Select it was,
 * and this file would not notice if it did not.
 */

const COMBOS: Combo[] = [
  {
    id: 'fast',
    name: 'Fast answers',
    members: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
    enabled: true,
  },
]

/** Two providers, because the model list belongs to one of them and must follow a switch. */
const TARGETS = [
  {
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
  },
  { providerId: 'openai', providerName: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini'] },
]

interface Call {
  member: string
  input: unknown
}

function stubSettings(calls: Call[]): void {
  const stub = createBridgeStub({
    listProviders: () => [
      { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
      { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o' },
    ],
    defaultModels: () => ({ deepseek: [{ id: 'deepseek-chat' }], openai: [{ id: 'gpt-4o' }] }),
    listConfigured: () => ['deepseek', 'openai'],
    isEncryptionAvailable: () => true,
    knownTargets: () => TARGETS,
    list: () => COMBOS,
    create: (input) => {
      calls.push({ member: 'create', input })
      return {}
    },
    addMember: (input) => {
      calls.push({ member: 'addMember', input })
      return {}
    },
  })
  stubStore(stub, 'combos', { combos: COMBOS })
  setActiveStub(stub)
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

/** Open one Radix select by its accessible name and pick the option whose text matches. */
async function choose(triggerName: string, optionText: string, index = 0): Promise<void> {
  const trigger = screen.getAllByLabelText(triggerName)[index]
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  const listbox = await screen.findByRole('listbox')
  const option = Array.from(listbox.querySelectorAll('[role="option"]')).find(
    (candidate) => (candidate.textContent ?? '').trim() === optionText
  )
  if (!option) throw new Error(`no option named ${optionText}`)
  await userEvent.click(option)
}

/**
 * The model trigger, by its accessible name. Two exist — the create form's and the one combo's
 * add-member row — in the order they are drawn.
 *
 * The name is the field and the current selection together, in the form the feature states:
 * `Model: <value>` or `Model: none selected`. The visible Label above the field stays the field's
 * own words; the trigger's name is what tells a screen reader what is in it.
 */
function modelTrigger(index = 0): HTMLButtonElement {
  return screen.getAllByLabelText(/^Model(?:$|:)/)[index] as HTMLButtonElement
}

/** The rows the picker is offering, read off the popover's own slot. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="model-picker-row"]'))
}

describe('the combo member model picker', () => {
  it('opens a labelled filter box and narrows the list to the matching models only', async () => {
    stubSettings([])
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    // Before a provider is chosen the trigger is disabled and says why.
    expect(modelTrigger().disabled).toBe(true)
    expect(modelTrigger().textContent).toContain('Choose a provider first')

    await choose('Provider', 'DeepSeek')
    expect(modelTrigger().disabled).toBe(false)
    expect(modelTrigger().textContent).toContain('Choose a model')

    await userEvent.click(modelTrigger())
    const box = await screen.findByLabelText('Filter models')
    expect(rows()).toHaveLength(3)

    // The casing is different from every id in the list: the match is a substring, not a prefix.
    await userEvent.type(box, 'REASON')
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0].textContent).toContain('deepseek-reasoner')
    expect(rows()[0].textContent).not.toContain('deepseek-chat')
  })

  it('sets the member payload from the row the filter kept', async () => {
    const calls: Call[] = []
    stubSettings(calls)
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    // The add-member row, not the create form: the payload under test is the member one.
    await choose('Provider', 'DeepSeek', 1)
    await userEvent.click(modelTrigger(1))
    await userEvent.type(await screen.findByLabelText('Filter models'), 'reasoner')
    await waitFor(() => expect(rows()).toHaveLength(1))

    await userEvent.click(rows()[0])
    // Choosing closes the popover and the trigger now carries the chosen id.
    await waitFor(() => expect(screen.queryByLabelText('Filter models')).toBeNull())
    expect(modelTrigger(1).textContent).toContain('deepseek-reasoner')

    await userEvent.click(screen.getByRole('button', { name: 'Add member to Fast answers' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        member: 'addMember',
        input: { id: 'fast', providerId: 'deepseek', modelId: 'deepseek-reasoner' },
      })
    )
  })

  it('says so when the term matches nothing, and offers nothing to select', async () => {
    stubSettings([])
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await choose('Provider', 'DeepSeek')
    await userEvent.click(modelTrigger())
    await userEvent.type(await screen.findByLabelText('Filter models'), 'nothing-matches-this')

    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(screen.getByText("No models match 'nothing-matches-this'")).toBeTruthy()
    // Nothing is selectable behind the term either: the list is empty, not merely invisible.
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('closes on Escape, and a provider switch resets the term and the chosen model', async () => {
    stubSettings([])
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    await choose('Provider', 'DeepSeek')
    await userEvent.click(modelTrigger())
    await userEvent.type(await screen.findByLabelText('Filter models'), 'chat')
    await waitFor(() => expect(rows()).toHaveLength(1))
    await userEvent.click(rows()[0])
    await waitFor(() => expect(modelTrigger().textContent).toContain('deepseek-chat'))

    // Escape closes without choosing: the term goes with the popover.
    await userEvent.click(modelTrigger())
    const box = await screen.findByLabelText('Filter models')
    await userEvent.type(box, 'reason')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByLabelText('Filter models')).toBeNull())

    // A new provider owns a new list, and the model chosen for the old one is no longer a member.
    await choose('Provider', 'OpenAI')
    expect(modelTrigger().textContent).toContain('Choose a model')
    await userEvent.click(modelTrigger())
    const reopened = (await screen.findByLabelText('Filter models')) as HTMLInputElement
    expect(reopened.value).toBe('')
    expect(rows().map((row) => row.textContent)).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })

  it('names the field and the chosen value, chosen or not, while the visible Label stays the field', async () => {
    stubSettings([])
    renderSettings()
    await screen.findByRole('heading', { name: 'Combos' })

    // Named by the field and its value, and the name survives the disabled state: nothing is chosen yet,
    // so the value half says exactly that rather than borrowing the field label as the whole name.
    expect(screen.getAllByRole('button', { name: 'Model: none selected' })).toHaveLength(2)
    // The visible label is still its own element, beside the field rather than inside its name.
    expect(screen.getAllByText('Model')).toHaveLength(2)

    await choose('Provider', 'DeepSeek')
    await userEvent.click(modelTrigger())
    await userEvent.type(await screen.findByLabelText('Filter models'), 'coder')
    await waitFor(() => expect(rows()).toHaveLength(1))
    await userEvent.click(rows()[0])

    // The chosen id is in the name now, and the other picker still says nothing is chosen.
    expect(screen.getByRole('button', { name: 'Model: deepseek-coder' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Model: none selected' })).toHaveLength(1)
    expect(modelTrigger().textContent).toContain('deepseek-coder')
  })
})
