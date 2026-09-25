/**
 * The Skills section of settings, as wiring rather than as rules.
 *
 * Every rule this exercises — the four tiers, their precedence, the counts, the read-only compatibility
 * rule — is tested directly in the node suite. What is left here is what a rule test cannot see: that
 * the tab opens the section, that a card shows the four things it is supposed to show, that a
 * same-id collision shows the *winner's* badge and path rather than the loser's, and that Expand is what
 * asks main for a body.
 *
 * The transport is the real conveyor client over a stubbed bridge, so what is asserted below is the
 * payload main would receive. The listing is a fixture rather than a scan, deliberately: this file is
 * about the drawing, and a scan is the other suite's subject.
 *
 * The section is rendered through `SettingsView` and reached by clicking the tab, so the claim "the
 * settings tab opens on Skills" is asserted where a user would make it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SettingsView } from '@/app/components/workbench/settings-view'
import { useWorkbenchStore } from '@/app/components/workbench/store'
import type { SkillListing, SkillTierListing } from '@/conveyor/protocol/skills'
import { createBridgeStub, setActiveStub, type BridgeStub } from './bridge-stub'

/** Two tiers with a skill each, a compat tier, and an empty fourth — the shape a real scan returns. */
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

/** The same four tiers, with one malformed file reported beside the skills that did load. */
const LISTING_WITH_ERRORS: SkillListing = {
  ...LISTING,
  errors: [
    {
      id: 'broken',
      scope: 'project',
      tier: 'project-native',
      code: 'SKILL_MANIFEST_INVALID',
      message: 'The manifest is not valid YAML or JSON.',
    },
  ],
  counts: { total: 3, project: 2, user: 1, errors: 1, hidden: 0 },
}

/**
 * A stub that answers the two reads this section makes, and the providers tab's own reads emptily.
 *
 * The body read is recorded rather than answered with a fixed string, so a test can assert both what
 * was asked for and what came back — which is the difference between "Expand does something" and
 * "Expand asks main for the right file and shows what it says".
 */
function stubSettings(options: { listing?: SkillListing; body?: string } = {}): BridgeStub {
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
      body: options.body ?? '# Code Review\n\nLook for the things a test would have caught.',
    }),
  })
  setActiveStub(stub)
  return stub
}

/** Render the settings screen and open the Skills tab, which is the path a user takes. */
async function openSkillsTab(): Promise<HTMLElement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsView />
    </QueryClientProvider>
  )

  await userEvent.click(screen.getByRole('tab', { name: 'Skills' }))
  return await screen.findByRole('heading', { name: 'Skills' })
}

/** One thing the section draws, by the slot it carries. */
function slot(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="${name}"]`)
}

/** All of them, for the assertions that are about a set. */
function slots(name: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`))
}

/** One tier's block, by the tier id it names. */
function tierBlock(tier: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-slot="skills-tier-${tier}"]`)
  if (!node) throw new Error(`no block for tier ${tier}`)
  return node
}

/** The card for one skill id, found by the id the section keys and labels it with. */
function card(id: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(`[data-slot="skill-card"][data-skill-id="${id}"]`)
  if (!node) throw new Error(`no card for ${id}`)
  return node
}

beforeEach(() => {
  useWorkbenchStore.setState({ settingsSection: 'providers', settingsReturnView: null })
})

describe('the Skills settings section', () => {
  it('opens on the Skills tab and states the counts as three numbers', async () => {
    stubSettings()

    const heading = await openSkillsTab()

    expect(heading).toBeTruthy()
    expect(useWorkbenchStore.getState().settingsSection).toBe('skills')
    // The header counts the tiers the section draws, and it counts all four of them.
    expect(slot('skills-counts')?.textContent).toContain('3 skills')
    expect(slot('skills-counts')?.textContent).toContain('2 project')
    expect(slot('skills-counts')?.textContent).toContain('1 user')
    expect(screen.queryByText(/errors?$/)).toBeNull()
  })

  it('draws every tier, with a scope badge, a tier badge, the source path and the summary on each card', async () => {
    stubSettings()

    await openSkillsTab()

    expect(slots('skill-card')).toHaveLength(3)
    // All four tiers are drawn, including the one that holds nothing: a missing section would read as a
    // folder that had been deleted.
    for (const tier of ['project-native', 'project-compat', 'user-native', 'user-compat']) {
      expect(tierBlock(tier)).toBeTruthy()
    }
    expect(within(tierBlock('user-compat')).getByText(/no skills/i)).toBeTruthy()

    const project = card('code-review')
    expect(within(project).getByText('Code Review')).toBeTruthy()
    expect(within(project).getByText('Review a diff before it lands.')).toBeTruthy()
    expect(within(project).getByText('project')).toBeTruthy()
    expect(within(project).getByText('native')).toBeTruthy()
    expect(within(project).getByText('C:/w/.sam/skills/code-review/SKILL.md')).toBeTruthy()

    const user = card('deploy-runbook')
    expect(within(user).getByText('user')).toBeTruthy()
    expect(within(user).getByText('native')).toBeTruthy()

    // The compatibility tier is badged as one, and says it is read-only: no edit and no delete on a
    // card there, whichever file inside it claims otherwise. Phase 43 added those two controls to the
    // writable tiers, so the assertion is now that the compat card is the one without them — the
    // compat-only half of this is asserted in `skills-manage-wiring`.
    const compat = card('shared')
    expect(within(compat).getByText('compat')).toBeTruthy()
    expect(within(tierBlock('project-compat')).getByText(/read-only/i)).toBeTruthy()
    expect(within(compat).queryByRole('button', { name: /delete/i })).toBeNull()
    expect(within(compat).queryByRole('button', { name: /edit/i })).toBeNull()
    expect(within(card('code-review')).getByRole('button', { name: /delete/i })).toBeTruthy()
    expect(within(card('code-review')).getByRole('button', { name: /edit/i })).toBeTruthy()
  })

  it('shows the winning tier’s badge and path when two tiers offer the same id', async () => {
    // `shared` in the project's own folder and in the user's: the node suite proves the scan drops the
    // loser, and this proves the section draws only what it was handed — the winner, with its own path.
    stubSettings({
      listing: {
        ...LISTING,
        tiers: TIER_LISTING.map((tier) =>
          tier.tier === 'project-native'
            ? {
                ...tier,
                skills: [
                  ...tier.skills,
                  {
                    id: 'shared',
                    scope: 'project' as const,
                    tier: 'project-native' as const,
                    title: 'Project Shared',
                    summary: 'The project’s own copy.',
                    tags: [],
                    sourcePath: 'C:/w/.sam/skills/shared/SKILL.md',
                  },
                ],
              }
            : tier.tier === 'project-compat'
              ? { ...tier, skills: [] }
              : tier
        ),
        counts: { total: 3, project: 2, user: 1, errors: 0, hidden: 0 },
      },
    })

    await openSkillsTab()

    const winner = card('shared')
    expect(within(winner).getByText('Project Shared')).toBeTruthy()
    expect(within(winner).getByText('native')).toBeTruthy()
    expect(within(winner).getByText('C:/w/.sam/skills/shared/SKILL.md')).toBeTruthy()
    // And the compatibility folder draws nothing rather than the copy that lost.
    expect(within(tierBlock('project-compat')).queryByText('Compat Shared')).toBeNull()
  })

  it('renders a load error with the code the parser named, and counts it beside the totals', async () => {
    stubSettings({ listing: LISTING_WITH_ERRORS })

    await openSkillsTab()

    const errorRow = slot('skill-error')
    expect(errorRow).toBeTruthy()
    expect(errorRow?.textContent).toContain('broken')
    expect(errorRow?.textContent).toContain('SKILL_MANIFEST_INVALID')
    // Separately, as its own number: an error is not a skill and must not be folded into the total.
    expect(slot('skills-error-count')?.textContent).toContain('1 error')
    expect(slot('skills-counts')?.textContent).toContain('3 skills')
    // Non-destructive: the skills that parsed are still drawn beside it.
    expect(slots('skill-card')).toHaveLength(3)
  })

  it('reads one body when a card is expanded, and renders it through the app’s markdown renderer', async () => {
    const stub = stubSettings({ body: '# Code Review\n\nLook for **the things** a test would have caught.' })

    await openSkillsTab()
    expect(slot('skill-body')).toBeNull()
    expect(stub.methodsOn('skills')).not.toContain('getSkillBody')

    await userEvent.click(within(card('code-review')).getByRole('button', { name: /expand/i }))

    const body = await waitFor(() => {
      const node = slot('skill-body')
      if (!node) throw new Error('no body yet')
      return node
    })
    // The renderer's own slot, which is what makes this "the existing markdown renderer" rather than a
    // second one: the element the chat and the file preview both use.
    expect(within(body).getByText('Code Review', { selector: 'h1' })).toBeTruthy()
    expect(within(body).getByText('the things', { selector: 'strong' })).toBeTruthy()

    // Asked for by the tier and the id the card was showing, so main reads the file the card named.
    const call = stub.callsTo('skills').find((entry) => entry.method === 'getSkillBody')
    expect(call?.args[0]).toEqual({ scope: 'project', tier: 'native', skillId: 'code-review' })

    // Collapsing puts it away again, and the list is still there.
    await userEvent.click(within(card('code-review')).getByRole('button', { name: /collapse/i }))
    await waitFor(() => expect(slot('skill-body')).toBeNull())
  })
})
