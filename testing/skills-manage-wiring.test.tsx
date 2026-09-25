/**
 * Skill management in the Skills settings tab, as wiring rather than as rules.
 *
 * Every rule these cases lean on — that a compat tier is read-only, that a duplicate id is refused by
 * code, that disabling prunes the conversations — is asserted directly in the node suite against the
 * real module and a seeded tree. What is left here is what only a render can show: that the section
 * offers the four actions on exactly the tiers that may have them, that each confirm names the paths
 * and the cost it is about to incur, that a refusal lands on the field it is about, and that a whole
 * -listing failure is said in this section's words rather than a generic one.
 *
 * The transport is the real conveyor client over a stubbed bridge, so the payloads asserted below are
 * the ones main would receive. The listing is a fixture deliberately: a scan is the other suite's
 * subject.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConveyorError } from 'electron-conveyor/react'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { SkillListing, SkillTierListing } from '@/conveyor/protocol/skills'
import { CHAT_SESSIONS_STORE_ID, createBridgeStub, setActiveStub, stubStore, type BridgeStub } from './bridge-stub'

const FIRST_SESSION = 'aaaaaaaa-1111-4111-8111-111111111111'
const SECOND_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222'

/** The four tiers a scan returns: one project skill, one compat skill, one user skill, one empty. */
const TIER_LISTING: SkillTierListing[] = [
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
    ],
  },
  {
    tier: 'project-compat',
    scope: 'project',
    kind: 'compat',
    sourceDir: 'C:/w/.agents/skills',
    skills: [
      {
        id: 'shared',
        scope: 'project',
        tier: 'project-compat',
        title: 'Compat Shared',
        summary: 'Written by another tool.',
        tags: [],
        sourcePath: 'C:/w/.agents/skills/shared/SKILL.md',
      },
    ],
  },
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
  { tier: 'user-compat', scope: 'user', kind: 'compat', sourceDir: 'C:/Users/me/.agents/skills', skills: [] },
]

const LISTING: SkillListing = {
  tiers: TIER_LISTING,
  errors: [],
  disabled: [],
  counts: { total: 3, project: 2, user: 1, errors: 0, hidden: 0 },
}

/** The same scan with no folder open: the project tiers have no directory, so no copy is offered. */
const LISTING_NO_ROOT: SkillListing = {
  ...LISTING,
  tiers: TIER_LISTING.map((tier) => (tier.scope === 'project' ? { ...tier, sourceDir: null, skills: [] } : tier)),
  counts: { total: 1, project: 0, user: 1, errors: 0, hidden: 0 },
}

/** Two conversations, both holding one skill — what the disable confirm counts. */
function sessions(activeSkillIds: string[] | null = null) {
  return {
    sessions: [
      {
        id: FIRST_SESSION,
        title: 'first',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        ...(activeSkillIds ? { activeSkillIds } : {}),
      },
      {
        id: SECOND_SESSION,
        title: 'second',
        createdAt: 1_700_000_000_001,
        updatedAt: 1_700_000_000_001,
        providerId: 'deepseek',
        model: 'deepseek-chat',
        ...(activeSkillIds ? { activeSkillIds } : {}),
      },
    ],
    activeSessionId: FIRST_SESSION,
  }
}

/** A stub answering this section's reads and every write a card offers. */
function stubSkills(
  options: {
    listing?: SkillListing
    chat?: unknown
    handlers?: Record<string, (input: unknown) => unknown>
  } = {}
): BridgeStub {
  const stub = createBridgeStub({
    listProviders: () => [],
    listConfigured: () => [],
    isEncryptionAvailable: () => true,
    listSkills: () => options.listing ?? LISTING,
    getSkillBody: () => ({
      id: 'code-review',
      scope: 'project',
      tier: 'project-native',
      title: 'Code Review',
      summary: 'Review a diff before it lands.',
      tags: [],
      sourcePath: 'C:/w/.sam/skills/code-review/SKILL.md',
      body: '# Code Review\n\nLook for the things a test would have caught.',
    }),
    createSkill: () => ({ tier: 'project-native', skillId: 'brand-new', path: 'C:/w/.sam/skills/brand-new/SKILL.md' }),
    copySkillIntoProject: () => ({
      tier: 'project-native',
      skillId: 'deploy-runbook',
      path: 'C:/w/.sam/skills/deploy-runbook/SKILL.md',
    }),
    deleteSkill: () => ({ tier: 'project-native', skillId: 'code-review', path: 'C:/w/.sam/skills/code-review' }),
    setSkillAvailability: () => ({ disabled: [] }),
    ...(options.handlers ?? {}),
  })
  stubStore(stub, CHAT_SESSIONS_STORE_ID, options.chat ?? sessions(['code-review']))
  setActiveStub(stub)
  return stub
}

/** The payload one write was dispatched with. */
function payloadOf(stub: BridgeStub, method: string): unknown {
  const call = stub.callsTo('skills').find((entry) => entry.method === method)
  if (!call) throw new Error(`no ${method} call`)
  return call.args[0]
}

/** Render the settings screen and open the Skills tab, which is the path a user takes. */
async function openSkills(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )
  await userEvent.click(screen.getByRole('tab', { name: 'Skills' }))
  await screen.findByRole('heading', { name: 'Skills' })
}

/** One thing the section draws, by the slot it carries. */
function slot(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="${name}"]`)
}

/** The card for one skill id. */
function card(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-slot="skill-card"][data-skill-id="${id}"]`)
  if (!node) throw new Error(`no card for ${id}`)
  return node
}

/** The availability switch on one card. */
function availabilitySwitch(id: string): HTMLButtonElement {
  return within(card(id)).getByRole('switch') as HTMLButtonElement
}

beforeEach(() => {
  useWorkbenchStore.setState({ settingsSection: 'providers', settingsReturnView: null, selectedFile: null })
})

describe('creating a skill', () => {
  it('offers only the two writable tiers, and refuses an id that cannot be a folder name', async () => {
    const stub = stubSkills()
    await openSkills()

    await userEvent.click(screen.getByRole('button', { name: 'New skill' }))
    const dialog = await screen.findByRole('alertdialog')
    // Two tiers, both native: a compatibility folder is not a place this app writes.
    expect(within(dialog).getAllByRole('button', { name: /native/ })).toHaveLength(2)

    await userEvent.type(within(dialog).getByLabelText('Id'), '../escape')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }))

    const error = await within(dialog).findByRole('alert')
    expect(error.textContent).toMatch(/id/i)
    expect(stub.methodsOn('skills')).not.toContain('createSkill')
  })

  it('puts a duplicate id on the id field, in the dialog’s own words', async () => {
    const stub = stubSkills({
      handlers: {
        createSkill: () => {
          throw new ConveyorError('SKILL_ID_TAKEN', 'A skill called "code-review" is already there.')
        },
      },
    })
    await openSkills()

    await userEvent.click(screen.getByRole('button', { name: 'New skill' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.type(within(dialog).getByLabelText('Id'), 'code-review')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }))

    // On the field it is about, and branched on the code rather than on main's sentence.
    const error = await within(dialog).findByRole('alert')
    expect(error.getAttribute('data-slot')).toBe('skill-create-id-error')
    expect(error.textContent).toMatch(/already exists/i)
    expect(stub.methodsOn('skills')).toContain('createSkill')
  })

  it('dispatches the whole draft and re-reads the listing when it lands', async () => {
    const stub = stubSkills()
    await openSkills()

    await userEvent.click(screen.getByRole('button', { name: 'New skill' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.type(within(dialog).getByLabelText('Id'), 'brand-new')
    await userEvent.type(within(dialog).getByLabelText('Title'), 'Brand New')
    await userEvent.type(within(dialog).getByLabelText('Summary'), 'One line about it.')
    await userEvent.type(within(dialog).getByLabelText('Body'), '# Brand New\n\nHow it goes.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }))

    await waitFor(() => expect(stub.methodsOn('skills')).toContain('createSkill'))
    expect(payloadOf(stub, 'createSkill')).toEqual({
      scope: 'project',
      tier: 'native',
      skillId: 'brand-new',
      title: 'Brand New',
      summary: 'One line about it.',
      body: '# Brand New\n\nHow it goes.',
    })
    // The list is the disk's answer, so it is asked for again rather than patched in the renderer.
    await waitFor(() => expect(stub.methodsOn('skills').filter((method) => method === 'listSkills').length).toBe(2))
  })
})

describe('copying a skill into the project', () => {
  it('names the source and the destination, and dispatches the copy', async () => {
    const stub = stubSkills()
    await openSkills()

    await userEvent.click(within(card('deploy-runbook')).getByRole('button', { name: /copy/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('C:/u/era/skills/deploy-runbook')
    expect(dialog.textContent).toContain('C:/w/.sam/skills/deploy-runbook')

    await userEvent.click(within(dialog).getByRole('button', { name: /copy/i }))
    await waitFor(() => expect(stub.methodsOn('skills')).toContain('copySkillIntoProject'))
    expect(payloadOf(stub, 'copySkillIntoProject')).toEqual({
      scope: 'user',
      tier: 'native',
      skillId: 'deploy-runbook',
    })
  })

  it('offers no copy at all when no folder is open, rather than a disabled control', async () => {
    stubSkills({ listing: LISTING_NO_ROOT })
    await openSkills()

    expect(within(card('deploy-runbook')).queryByRole('button', { name: /copy/i })).toBeNull()
    // And the compatibility source has none either, for the same reason: nowhere to copy it into.
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })
})

describe('deleting a skill', () => {
  it('names the folder and the cost, and dispatches the delete', async () => {
    const stub = stubSkills()
    await openSkills()

    await userEvent.click(within(card('code-review')).getByRole('button', { name: /delete/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('C:/w/.sam/skills/code-review')
    expect(dialog.textContent).not.toContain('SKILL.md')
    expect(dialog.textContent).toMatch(/will drop it/i)
    // Two conversations hold it in this fixture, and the confirm says how many.
    expect(dialog.textContent).toContain('2 conversations')

    await userEvent.click(within(dialog).getByRole('button', { name: /delete/i }))
    await waitFor(() => expect(stub.methodsOn('skills')).toContain('deleteSkill'))
    expect(payloadOf(stub, 'deleteSkill')).toEqual({ scope: 'project', tier: 'native', skillId: 'code-review' })
  })

  it('renders no delete and no edit on a compatibility tier, but still offers the copy', async () => {
    stubSkills()
    await openSkills()

    const compat = card('shared')
    expect(within(compat).queryByRole('button', { name: /delete/i })).toBeNull()
    expect(within(compat).queryByRole('button', { name: /edit/i })).toBeNull()
    expect(within(compat).getByRole('button', { name: /copy/i })).toBeTruthy()
  })
})

describe('editing a skill', () => {
  it('opens the SKILL.md in the explorer’s editor', async () => {
    stubSkills()
    await openSkills()

    await userEvent.click(within(card('code-review')).getByRole('button', { name: /edit/i }))

    // The same selection the explorer's file tree makes, so the same guarded editor opens on it.
    await waitFor(() => expect(useWorkbenchStore.getState().selectedFile).toBe('C:/w/.sam/skills/code-review/SKILL.md'))
  })
})

describe('the availability toggle', () => {
  it('names how many conversations lose the skill, and switches it off by code', async () => {
    const stub = stubSkills({ chat: sessions(['code-review', 'other']) })
    await openSkills()

    await userEvent.click(availabilitySwitch('code-review'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('2 conversations')

    await userEvent.click(within(dialog).getByRole('button', { name: /turn it off/i }))
    await waitFor(() => expect(stub.methodsOn('skills')).toContain('setSkillAvailability'))
    expect(payloadOf(stub, 'setSkillAvailability')).toEqual({
      scope: 'project',
      tier: 'native',
      skillId: 'code-review',
      disabled: true,
    })
  })

  it('switches one back on without naming any conversation, because enabling re-activates nothing', async () => {
    const stub = stubSkills({
      listing: {
        ...LISTING,
        disabled: [{ tier: 'project-native', rootPath: 'C:/w', skillId: 'code-review' }],
        counts: { total: 3, project: 2, user: 1, errors: 0, hidden: 1 },
      },
    })
    await openSkills()

    expect(availabilitySwitch('code-review').getAttribute('aria-checked')).toBe('false')
    // The hidden count is its own number, beside the totals and separate from the error count.
    expect(slot('skills-hidden-count')?.textContent).toContain('1 hidden')

    await userEvent.click(availabilitySwitch('code-review'))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).not.toMatch(/conversations/)

    await userEvent.click(within(dialog).getByRole('button', { name: /turn it on/i }))
    await waitFor(() => expect(stub.methodsOn('skills')).toContain('setSkillAvailability'))
    expect(payloadOf(stub, 'setSkillAvailability')).toEqual({
      scope: 'project',
      tier: 'native',
      skillId: 'code-review',
      disabled: false,
    })
  })
})

describe('a whole-listing failure', () => {
  it('is said in this section’s words, branched on the code', async () => {
    stubSkills({
      handlers: {
        listSkills: () => {
          throw new ConveyorError('SKILL_IO_ERROR', 'The skill folders could not be reached (EPERM).')
        },
      },
    })
    await openSkills()

    const notice = await waitFor(() => {
      const node = slot('skills-read-error')
      if (!node) throw new Error('no failure notice yet')
      return node
    })
    expect(notice.textContent).toContain('could not be opened')
    expect(notice.textContent).not.toContain('The skill folders could not be read.')
  })

  it('falls back to a sentence about nothing known, for anything that is not one of ours', async () => {
    stubSkills({
      handlers: {
        listSkills: () => {
          throw new Error('socket closed')
        },
      },
    })
    await openSkills()

    const notice = await waitFor(() => {
      const node = slot('skills-read-error')
      if (!node) throw new Error('no failure notice yet')
      return node
    })
    expect(notice.textContent).toContain('The skill folders could not be read.')
  })
})
