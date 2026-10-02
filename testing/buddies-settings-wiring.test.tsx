/**
 * The Buddies section, as wiring: the rows it draws, what the editor writes, and what a switch lands on.
 *
 * The rules behind the screen — the order of the rows, which id labels as what, and which field refuses a
 * draft — are `tests/buddies/buddies-list-test.ts`'s, and the store's own boundary is
 * `tests/buddies/buddies-store-test.ts`'s. What can only be seen here is the composition: that the section
 * is in the shell's row and lands by deep link, that a built-in row is locked and offers no edit or delete
 * while a custom row offers all three, that every field of the editor reaches one record, and that a
 * switch reaches the set the list reads.
 *
 * Main is simulated, not faked: `fakeMain` below holds the store's state, applies each action through the
 * store's own reducer, and pushes the result down the changed channel — so the row that appears after a
 * save is the row main's answer makes appear, and a test can assert both what was asked for and what the
 * screen does once main has replied.
 *
 * jsdom proves wiring and words, not pixels. Nothing here says the section looks right; that is Boss's eyes
 * on the running app.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_BUDDIES, type BuddyRecord } from '@/conveyor/protocol/buddies'
import { buddiesStore, type BuddiesState } from '@/conveyor/stores/buddies'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import { createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

/** The built-ins' ids, in the order the module declares them: what the list's first three rows must be. */
const BUILTIN_IDS = BUILTIN_BUDDIES.map((buddy) => buddy.id)

/** A custom record that declares every optional field, so an edit round trip has something to lose. */
const CAPTAIN: BuddyRecord = {
  id: 'release-captain',
  name: 'Release Captain',
  glyph: 'R',
  description: 'Ships the thing and says what shipped.',
  rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
  skillIds: ['code-review'],
  mcpIds: ['filesystem'],
  providerId: 'deepseek',
  model: 'deepseek-chat',
  autoApprove: true,
  starters: ['Cut a release'],
  builtin: false,
}

/** An empty store: the built-ins are not in it, which is the point of their being pure data. */
const EMPTY: BuddiesState = { custom: [], disabledIds: [] }

/** One provider that ships, because the editor's provider list is read from settings. */
const PROVIDERS = [{ id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' }]

/** The provider-config state that answers the model list for that provider. */
const PROVIDER_CONFIG = {
  providers: { deepseek: { fetchedModels: [{ id: 'deepseek-chat' }], enabledModels: ['deepseek-chat'] } },
  customProviders: [],
}

/** The skills listing the editor's multi-select reads: one skill, so a row can be ticked. */
const SKILLS = {
  tiers: [
    {
      tier: 'project-native',
      scope: 'project',
      kind: 'project',
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
      ],
    },
  ],
  errors: [],
  disabled: [],
  counts: { total: 1, project: 1, user: 0, errors: 0, hidden: 0 },
}

/** One server as `mcp.listServers` reports it, in the shape the section draws a row from. */
function server(id: string, enabled: boolean, scope: 'user' | 'project' = 'user') {
  return {
    id,
    transport: 'stdio' as const,
    command: 'node',
    args: [],
    cwd: null,
    env: {},
    enabled,
    scope,
    // A user server is trusted by being in the user's own file; a project one is trusted by comparison.
    trust: scope === 'project' ? 'absent' : null,
    secrets: [],
    autoApprove: false,
  }
}

/**
 * Main's half of the Buddies store.
 *
 * A cross-window store is owned by main: the renderer's action call travels to the store channel and the
 * mirror changes only when the result is broadcast. This applies that reducer to its own copy and pushes
 * the result down the changed channel, so a test can assert both what was asked for and what the screen
 * does once main has answered.
 */
function fakeMain(stub: BridgeStub, initial: BuddiesState): { state: () => BuddiesState } {
  let state = structuredClone(initial)
  stubStore(stub, 'buddies', state)
  const invoke = stub.bridge.invoke

  stub.bridge.invoke = async (channel, method, ...args) => {
    if (channel === 'conveyor:store:buddies' && method in buddiesStore.actions) {
      // Recorded here rather than by the transport: this loop answers the action itself instead of
      // forwarding it, so without this the call the screen made would leave no trace to assert on.
      stub.calls.push({ channel, method, args })
      const payload = (args[0] as { payload?: unknown } | undefined)?.payload
      const next = structuredClone(state)
      // The definition's own reducer, cast for the call: each action's payload type comes from its schema,
      // and this loop is deliberately payload-agnostic.
      const reduce = buddiesStore.actions[method as keyof typeof buddiesStore.actions] as unknown as (
        draft: BuddiesState,
        input: unknown
      ) => void
      reduce(next, payload)
      state = next
      queueMicrotask(() => stub.pushToChannel('conveyor:store:buddies:changed', structuredClone(state)))
      return state
    }
    return invoke(channel, method, ...args)
  }

  return { state: () => state }
}

/** Install a bridge whose answers are the ones this suite describes. */
function stubBuddies(state: BuddiesState = EMPTY): { stub: BridgeStub; main: { state: () => BuddiesState } } {
  const stub = createBridgeStub({
    listProviders: () => PROVIDERS,
    defaultModels: () => ({}),
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    listSkills: () => SKILLS,
    // One trusted and enabled user server, one switched off, and one project server nobody has trusted:
    // only the first is offerable, which is the intersection a Buddy may ever narrow.
    listServers: () => ({
      user: [server('filesystem', true), server('notes', false)],
      project: [server('docs', true, 'project')],
      errors: [],
    }),
    listRunningTools: () => [],
  })
  stubStore(stub, 'provider-config', structuredClone(PROVIDER_CONFIG))
  const main = fakeMain(stub, state)
  setActiveStub(stub)
  return { stub, main }
}

/** The settings screen, which is where the section lives. */
function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )
}

/** Every Buddy row on screen, in the order the list draws them. */
function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="buddy-row"]')]
}

/** One row, by the id it carries. */
function row(id: string): HTMLElement {
  const found = rows().find((node) => node.dataset.buddyId === id)
  if (!found) throw new Error(`no row for ${id}`)
  return found
}

/** The Buddies panel, or null while another section is showing. */
function buddiesSection(): HTMLElement | null {
  const node = document.querySelector<HTMLElement>('[data-slot="settings-section-buddies"]')
  if (!node || node.hasAttribute('hidden')) return null
  return node
}

/** The editor's dialog, as Radix states its role. */
function editor(): HTMLElement {
  return screen.getByRole('alertdialog')
}

/** The label of a row's own control, so the control can be reached by the row it belongs to. */
function control(node: HTMLElement, slot: string): HTMLElement | null {
  return node.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
}

/** What a switch states about itself, read the way a screen reader hears it. */
function switchState(name: string): string | null {
  return screen.getByRole('switch', { name }).getAttribute('aria-checked')
}

/** The payload of a store action the screen dispatched, which is what main receives. */
function payloadOf(stub: BridgeStub, method: string): unknown {
  const call = stub.calls.find((entry) => entry.channel === 'conveyor:store:buddies' && entry.method === method)
  if (!call) throw new Error(`no ${method} call reached the store`)
  return (call.args[0] as { payload?: unknown } | undefined)?.payload
}

/** Whether the screen dispatched one action at all. */
function called(stub: BridgeStub, method: string): boolean {
  return stub.calls.some((entry) => entry.channel === 'conveyor:store:buddies' && entry.method === method)
}

/** One of Radix's selects, opened from the keyboard — a click on a trigger is not reliable in jsdom. */
async function openSelect(name: string): Promise<void> {
  const trigger = await screen.findByRole('combobox', { name })
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await screen.findByRole('listbox')
}

/** Open the create form. */
async function openNewBuddy(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'New Buddy' }))
  await screen.findByRole('alertdialog')
}

beforeEach(() => {
  localStorage.clear()
  // The store is module-level: a test that left the screen on Buddies would otherwise decide the next
  // one's first render.
  useWorkbenchStore.setState({ activeActivity: 'settings', settingsSection: 'providers' })
})

describe('the Buddies section', () => {
  it('is in the shell’s section row, and openSettingsAt lands on it', async () => {
    stubBuddies()
    renderSettings()

    // A launch opens the first section, and Buddies is the last of them: the row states the order.
    expect(buddiesSection()).toBeNull()
    const row = document.querySelector<HTMLElement>('[data-slot="settings-sections"]') as HTMLElement
    expect(
      within(row)
        .getAllByRole('tab')
        .map((tab) => tab.textContent)
    ).toEqual(['Providers', 'MCP Servers', 'Skills', 'Terminal', 'Context', 'Buddies'])

    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))

    expect(buddiesSection()).not.toBeNull()
    expect(screen.getByRole('tab', { name: 'Buddies' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Buddies' })).toBeTruthy()
  })

  it('lists the three built-ins locked with a switch, and a custom record with all three controls', async () => {
    stubBuddies({ custom: [CAPTAIN], disabledIds: [] })
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))

    await waitFor(() => expect(rows().length).toBe(4))
    expect(rows().map((node) => node.dataset.buddyId)).toEqual([...BUILTIN_IDS, CAPTAIN.id])

    for (const id of BUILTIN_IDS) {
      const builtin = row(id)
      expect(builtin.dataset.buddyKind).toBe('builtin')
      // A built-in is the app's own data: it can be switched off and nothing else. No edit and no delete
      // control exists in the row at all, rather than existing disabled.
      expect(within(builtin).getByText('Locked')).toBeTruthy()
      expect(control(builtin, 'buddy-enabled')).not.toBeNull()
      expect(control(builtin, 'buddy-edit')).toBeNull()
      expect(control(builtin, 'buddy-delete')).toBeNull()
    }

    const mine = row(CAPTAIN.id)
    expect(mine.dataset.buddyKind).toBe('custom')
    expect(within(mine).queryByText('Locked')).toBeNull()
    for (const slot of ['buddy-enabled', 'buddy-edit', 'buddy-delete']) {
      expect(control(mine, slot)).not.toBeNull()
    }

    // The Agent Sam default is absent by design: it is what a conversation that named nobody runs as, so it is
    // not one row among these.
    expect(rows().some((node) => node.dataset.buddyId === 'samai')).toBe(false)
    expect(screen.queryByText('Agent Sam')).toBeNull()
  })

  // The one test in this file that fills ten fields and opens two selects, so it is the one that pays the
  // per-keystroke cost of a real typing simulation. It passed standalone in about 11 seconds and was
  // observed past the global 20s in a full-suite run beside five other gates — machine contention, not a
  // defect in what it asserts. Given its own budget rather than the whole suite's, and the typing is set up
  // with `delay: null` so the cost is the interaction rather than jsdom waiting on a timer.
  it('creates a custom Buddy, writing every field of the record', { timeout: 45000 }, async () => {
    const { stub } = stubBuddies()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))

    const user = userEvent.setup({ delay: null })
    await openNewBuddy()

    await user.type(within(editor()).getByLabelText('Name'), 'Release Captain')
    // The glyph is picked from the app's own lucide marks rather than typed: one click, one mark.
    await user.click(within(editor()).getByRole('button', { name: 'Glyph B' }))
    await user.type(within(editor()).getByLabelText('Description'), 'Ships the thing and says what shipped.')
    await user.type(
      within(editor()).getByLabelText('Role prompt'),
      'You are the release captain. Cut the smallest release that is honest.'
    )

    await user.click(within(editor()).getByRole('checkbox', { name: 'Code Review' }))
    // The server nobody has trusted, and the one switched off, are not offered: a Buddy narrows what the
    // app may already use and cannot claim anything else.
    expect(within(editor()).queryByRole('checkbox', { name: 'docs' })).toBeNull()
    expect(within(editor()).queryByRole('checkbox', { name: 'notes' })).toBeNull()
    await user.click(within(editor()).getByRole('checkbox', { name: 'filesystem' }))

    await openSelect('Provider')
    await user.click(screen.getByRole('option', { name: 'DeepSeek' }))
    await openSelect('Model')
    await user.click(screen.getByRole('option', { name: 'deepseek-chat' }))

    await user.click(within(editor()).getByRole('switch', { name: 'Auto-approve' }))

    await user.type(within(editor()).getByLabelText('Starter 1'), 'Cut a release')
    await user.click(within(editor()).getByRole('button', { name: 'Add starter' }))
    await user.type(within(editor()).getByLabelText('Starter 2'), 'What changed since the last tag?')

    await user.click(within(editor()).getByRole('button', { name: 'Save Buddy' }))

    await waitFor(() => expect(called(stub, 'addBuddy')).toBe(true))
    expect(payloadOf(stub, 'addBuddy')).toEqual({
      id: 'release-captain',
      name: 'Release Captain',
      glyph: 'B',
      description: 'Ships the thing and says what shipped.',
      rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
      skillIds: ['code-review'],
      mcpIds: ['filesystem'],
      providerId: 'deepseek',
      model: 'deepseek-chat',
      autoApprove: true,
      starters: ['Cut a release', 'What changed since the last tag?'],
      builtin: false,
    })

    // And the row the answer makes appear is the record just written.
    await waitFor(() => expect(rows().length).toBe(4))
    expect(within(row('release-captain')).getByText('Release Captain')).toBeTruthy()
    expect(within(row('release-captain')).getByText('B')).toBeTruthy()
  })

  it('refuses a draft on its own field, in the rule’s own words, and stays open', async () => {
    const { stub } = stubBuddies()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))

    await openNewBuddy()
    await userEvent.type(within(editor()).getByLabelText('Description'), 'A Buddy with no name.')
    await userEvent.type(within(editor()).getByLabelText('Role prompt'), 'You are helpful.')
    await userEvent.click(within(editor()).getByRole('button', { name: 'Save Buddy' }))

    // The refusal is the rule's, said beside the field it names, and nothing was written.
    const refusal = await within(editor()).findByRole('alert')
    expect(refusal.textContent?.trim().length).toBeGreaterThan(0)
    expect(called(stub, 'addBuddy')).toBe(false)
    expect(within(editor()).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alertdialog')).toBeTruthy()
  })

  it('edits a custom record whole, and the row follows', async () => {
    const { stub } = stubBuddies({ custom: [CAPTAIN], disabledIds: [] })
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))
    await waitFor(() => expect(rows().length).toBe(4))

    await userEvent.click(within(row(CAPTAIN.id)).getByRole('button', { name: `Edit ${CAPTAIN.name}` }))
    await screen.findByRole('alertdialog')

    // The form opens on the record, so an edit that touches one field hands the other nine back unchanged.
    expect((within(editor()).getByLabelText('Name') as HTMLInputElement).value).toBe(CAPTAIN.name)
    expect((within(editor()).getByLabelText('Role prompt') as HTMLTextAreaElement).value).toBe(CAPTAIN.rolePrompt)

    await userEvent.clear(within(editor()).getByLabelText('Name'))
    await userEvent.type(within(editor()).getByLabelText('Name'), 'Release Captain II')
    await userEvent.click(within(editor()).getByRole('button', { name: 'Save Buddy' }))

    await waitFor(() => expect(called(stub, 'updateBuddy')).toBe(true))
    expect(payloadOf(stub, 'updateBuddy')).toEqual({ ...CAPTAIN, name: 'Release Captain II' })
    await waitFor(() => expect(within(row(CAPTAIN.id)).getByText('Release Captain II')).toBeTruthy())
  })

  it('deletes a custom record after confirmation, and the store refuses a built-in id', async () => {
    const { stub, main } = stubBuddies({ custom: [CAPTAIN], disabledIds: [] })
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))
    await waitFor(() => expect(rows().length).toBe(4))

    await userEvent.click(within(row(CAPTAIN.id)).getByRole('button', { name: `Delete ${CAPTAIN.name}` }))
    // Nothing is removed until the confirmation is answered.
    expect(called(stub, 'removeBuddy')).toBe(false)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Buddy' }))

    await waitFor(() => expect(called(stub, 'removeBuddy')).toBe(true))
    expect(payloadOf(stub, 'removeBuddy')).toEqual({ id: CAPTAIN.id })
    await waitFor(() => expect(rows().length).toBe(3))
    expect(main.state().custom).toEqual([])

    // And the boundary answers for itself, which is what makes the missing control on a built-in row a
    // second answer rather than the only one: a write may not name the app's own ids, and a record may not
    // claim to be one. The payload schema is the boundary the renderer actually crosses, and it is read
    // through the same cast the store's own suite uses — the definition's schemas are typed generically.
    const payload = (
      buddiesStore.schemas as unknown as Record<string, { safeParse: (value: unknown) => { success: boolean } }>
    ).addBuddy
    expect(payload.safeParse({ ...CAPTAIN, id: BUILTIN_IDS[1] }).success).toBe(false)
    expect(payload.safeParse({ ...CAPTAIN, id: 'samai' }).success).toBe(false)
    expect(payload.safeParse({ ...CAPTAIN, builtin: true }).success).toBe(false)

    // Removal has no refusal to state, because it has nothing to refuse: a built-in is not in this store, so
    // the reducer leaves the records it was not given exactly as they were.
    const untouched: BuddiesState = { custom: [CAPTAIN], disabledIds: [] }
    buddiesStore.actions.removeBuddy(untouched, { id: BUILTIN_IDS[0] })
    expect(untouched.custom).toEqual([CAPTAIN])
  })

  it('lands a switch on the disabled set, for a built-in and for a custom record', async () => {
    const { stub, main } = stubBuddies({ custom: [CAPTAIN], disabledIds: [] })
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))
    await waitFor(() => expect(rows().length).toBe(4))

    const builtinName = BUILTIN_BUDDIES[0].name
    await userEvent.click(screen.getByRole('switch', { name: `Enable ${builtinName}` }))
    await waitFor(() => expect(called(stub, 'setBuddyEnabled')).toBe(true))
    expect(payloadOf(stub, 'setBuddyEnabled')).toEqual({ id: BUILTIN_IDS[0], enabled: false })
    await waitFor(() => expect(main.state().disabledIds).toEqual([BUILTIN_IDS[0]]))
    // The row stays in the list — that is how it gets switched back on — and states itself as off.
    await waitFor(() => expect(switchState(`Enable ${builtinName}`)).toBe('false'))
    expect(rows().length).toBe(4)

    await userEvent.click(screen.getByRole('switch', { name: `Enable ${CAPTAIN.name}` }))
    await waitFor(() => expect(main.state().disabledIds).toEqual([BUILTIN_IDS[0], CAPTAIN.id]))
    await waitFor(() => expect(switchState(`Enable ${CAPTAIN.name}`)).toBe('false'))

    // And back on: the set is the state the switch is, not a count of presses.
    await userEvent.click(screen.getByRole('switch', { name: `Enable ${builtinName}` }))
    await waitFor(() => expect(main.state().disabledIds).toEqual([CAPTAIN.id]))
    await waitFor(() => expect(switchState(`Enable ${builtinName}`)).toBe('true'))
  })
})

/**
 * The editor's bounds and its containment.
 *
 * Two defects are pinned here, and both were reported against a role the app would not hold. The first is
 * the cap: a role prompt written out in full is a page of prose, and the 4,000-character bound refused the
 * Boss's own 13,770-character role before any field could be saved. The second is the surface: the editor
 * grew with its contents, so the dialog asked for more height than the window it was drawn in.
 *
 * The honest ceiling of these assertions is the same as the picker containment suite's. jsdom lays nothing
 * out: every box reports zero height, no element here can be observed to scroll, and "the role scrolls
 * inside the field" is a claim about pixels that only the running app can settle. What is asserted instead
 * is the *structure* that states each policy — which element carries the viewport cap, which region scrolls,
 * which classes carry the field's own bar and resize handle, the numbers the helper lines name — plus the
 * record a save actually writes. Pixel acceptance is Boss's eyes: paste the full role and watch it scroll.
 */
describe('the Buddy editor’s bounds and containment', () => {
  it('states the new caps and draws the role prompt as its own scrolling field', async () => {
    stubBuddies()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))
    await openNewBuddy()

    // A textarea with a height of its own, a vertical bar and a resize handle: the three classes that make
    // a written-out role scroll inside the box rather than grow the box.
    const role = within(editor()).getByLabelText('Role prompt')
    expect(role.tagName).toBe('TEXTAREA')
    const classes = role.className.split(/\s+/)
    expect(classes).toContain('h-40')
    expect(classes).toContain('resize-y')
    expect(classes).toContain('overflow-y-auto')

    // The words under both fields state the raised numbers, and the numbers they used to state are gone
    // rather than sitting beside them.
    expect(within(editor()).getByText(/Over 32,000 characters is refused rather than cut/)).toBeTruthy()
    expect(within(editor()).getByText(/Up to 400 characters/)).toBeTruthy()
    expect(within(editor()).queryByText(/Over 4,?000 characters/)).toBeNull()
    expect(within(editor()).queryByText(/Up to 160 characters/)).toBeNull()

    // And the live count survives the rewording, because it is the thing that says how far along the role is.
    expect(within(editor()).getByText(/0 so far/)).toBeTruthy()
  })

  it('caps the editor at the viewport, scrolls its body, and leaves the two lists their own bars', async () => {
    stubBuddies()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))
    await openNewBuddy()

    const dialog = editor()
    expect(dialog.className).toContain('max-h-[85vh]')

    // The scrolling region is the body and not the dialog: the fields scroll inside a capped surface, and
    // the actions stay outside that region so Save and Cancel cannot be scrolled away from.
    const body = dialog.querySelector<HTMLElement>('[data-slot="buddy-editor-body"]')
    expect(body).not.toBeNull()
    expect(body?.className).toContain('overflow-y-auto')
    expect(body?.className).toContain('min-h-0')
    expect(body?.contains(within(dialog).getByLabelText('Role prompt'))).toBe(true)
    expect(body?.contains(within(dialog).getByRole('button', { name: 'Save Buddy' }))).toBe(false)

    // The skills and MCP lists keep the scrollbars they already had, which is what stops a hundred skills
    // from being a page rather than a list.
    for (const slot of ['buddy-skill-list', 'buddy-mcp-list']) {
      const list = dialog.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
      expect(list).not.toBeNull()
      expect(list?.className).toContain('overflow-auto')
    }
  })

  it('saves a Buddy whose role is the Boss’s own 13,770 characters', async () => {
    const { stub } = stubBuddies()
    renderSettings()
    act(() => useWorkbenchStore.getState().openSettingsAt('buddies'))
    await openNewBuddy()

    const sentence =
      'Read every claim as a claim about a process, name the relations that produce it, and say what would refute it. '
    const role = sentence.repeat(Math.ceil(13_770 / sentence.length)).slice(0, 13_770)

    await userEvent.type(within(editor()).getByLabelText('Name'), 'Dialectical Materialist')
    await userEvent.type(
      within(editor()).getByLabelText('Description'),
      'Reads every claim as a claim about a process.'
    )
    // Pasted rather than typed: 13,770 keystrokes would measure the typing simulation rather than the field.
    fireEvent.change(within(editor()).getByLabelText('Role prompt'), { target: { value: role } })
    expect((within(editor()).getByLabelText('Role prompt') as HTMLTextAreaElement).value.length).toBe(13_770)

    await userEvent.click(within(editor()).getByRole('button', { name: 'Save Buddy' }))

    await waitFor(() => expect(called(stub, 'addBuddy')).toBe(true))
    const payload = payloadOf(stub, 'addBuddy') as { rolePrompt?: string }
    expect(payload.rolePrompt?.length).toBe(13_770)
    expect(payload.rolePrompt).toBe(role)

    // And the row main's answer makes appear is the record just written, whole.
    await waitFor(() => expect(rows().some((node) => node.dataset.buddyId === 'dialectical-materialist')).toBe(true))
    expect(within(row('dialectical-materialist')).getByText('Dialectical Materialist')).toBeTruthy()
  })
})
