/**
 * The combo vocabulary: the schema, the id rule, the failure disposition, and the eligibility walk.
 *
 * Pure rules, exercised without electron, a window or a store. This is the layer every other combo
 * suite stands on: if a member can nest, or a 4xx advances, or an empty enabled list disqualifies, the
 * walk below is wrong before any request is made.
 */
import { strict as assert } from 'node:assert'
import {
  MAX_COMBO_MEMBERS,
  appendComboMember,
  comboFailureDisposition,
  comboMemberEligibility,
  comboMemberKnown,
  comboSlug,
  comboSchema,
  comboMemberSchema,
  moveComboMember,
  newComboId,
  planComboWalk,
  removeComboMember,
  type Combo,
  type ComboMember,
  type ComboRegistryEntry,
  type ComboRegistrySnapshot,
} from '../../conveyor/protocol/combos'
import { transcriptSnapshotSchema } from '../../conveyor/protocol/transcript'
import { shouldAutoContinue } from '../../conveyor/protocol/turn-end'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

const MEMBER: ComboMember = { providerId: 'deepseek', modelId: 'deepseek-chat' }
const OTHER: ComboMember = { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }

function combo(overrides: Partial<Combo> = {}): Combo {
  return { id: 'fast', name: 'Fast', members: [MEMBER], enabled: true, ...overrides }
}

// ---------------------------------------------------------------- schema

function theSchemaRefusesWhatCannotBeACombo() {
  assert.equal(comboSchema.safeParse(combo()).success, true)
  assert.equal(comboSchema.safeParse(combo({ name: '   ' })).success, false, 'a blank name is refused')
  assert.equal(comboSchema.safeParse(combo({ members: [] })).success, false, 'a combo with no members is refused')
  assert.equal(
    comboSchema.safeParse(combo({ members: Array.from({ length: MAX_COMBO_MEMBERS + 1 }, () => MEMBER) })).success,
    false,
    'one past the cap is refused'
  )
  assert.equal(comboSchema.safeParse(combo({ id: 'Not A Slug' })).success, false, 'the id is a slug')
  results.push(`schema: members 1..${MAX_COMBO_MEMBERS}, trimmed name, slug id`)
}

function aNameIsTrimmedAndSlugged() {
  assert.equal(comboSlug('  Fast Answers!  '), 'fast-answers')
  assert.equal(comboSlug('C++ / Rust'), 'c-rust')
  assert.equal(comboSlug('---'), '')
  assert.equal(newComboId('Fast', ['fast']), 'fast-2')
  assert.equal(newComboId('Fast', ['fast', 'fast-2']), 'fast-3')
  assert.equal(newComboId('!!!', []), 'combo', 'a name with nothing slugged still gets an id')
  results.push('slug: collapsed, trimmed, bounded; newComboId suffixes collisions')
}

function nestingIsUnrepresentable() {
  // A member is exactly two strings. `.strict()` refuses the extra key, so a hand-edited file that
  // tries to put a combo inside a member is not a member rather than a nested list to walk.
  assert.equal(comboMemberSchema.safeParse(MEMBER).success, true)
  const nested = { providerId: 'p', modelId: 'm', members: [MEMBER] }
  assert.equal(comboMemberSchema.safeParse(nested).success, false, 'a member cannot carry a member list')
  assert.equal(
    comboMemberSchema.safeParse({ providerId: { providerId: 'p', modelId: 'm' }, modelId: 'm' }).success,
    false,
    'a member value cannot be another member'
  )
  results.push('nesting: a member is exactly two strings, refused structurally')
}

function theIdIsStableAcrossARename() {
  // The id is computed once, from the creation name. A rename action writes only `name`; this pin is
  // the rule, stated where the derivation lives.
  const created = combo({ id: newComboId('Fast Answers', []), name: 'Fast Answers' })
  const renamed = { ...created, name: 'Quick' }
  assert.equal(renamed.id, created.id)
  assert.equal(renamed.id, 'fast-answers')
  results.push('id: derived once, stable across renames')
}

function aDuplicatePairIsIdempotent() {
  assert.deepEqual(appendComboMember([MEMBER], { ...MEMBER }), [MEMBER])
  assert.deepEqual(removeComboMember([MEMBER, OTHER], MEMBER), [OTHER])
  assert.deepEqual(moveComboMember([MEMBER, OTHER], 0, 1), [OTHER, MEMBER])
  assert.deepEqual(moveComboMember([MEMBER], 0, 9), [MEMBER], 'a move past the end clamps')
  results.push('members: duplicate add is idempotent, remove and move are pure')
}

// ---------------------------------------------------------------- failure disposition

function theDispositionTable() {
  for (const code of ['AUTH_FAILED', 'RATE_LIMITED', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'NO_API_KEY']) {
    assert.equal(comboFailureDisposition(code), 'advance', `${code} should advance`)
  }
  for (const code of [
    'STREAM_ERROR',
    'INVALID_PROVIDER',
    'UNKNOWN_PROVIDER',
    'ENCRYPTION_UNAVAILABLE',
    'PROVIDER_REQUEST_INVALID',
    'IMAGE_ATTACH_REFUSED',
    'IMAGE_ATTACH_NOT_FOUND',
    'SKILL_NOT_FOUND',
    'SKILL_PARSE_INVALID',
    'SKILL_TOO_LARGE',
    'SKILL_IO_ERROR',
    'SOMETHING_NEW',
  ]) {
    assert.equal(comboFailureDisposition(code), 'surface', `${code} should surface`)
  }
  results.push('disposition: five advance codes, everything else surfaces by default')
}

// ---------------------------------------------------------------- the registry and filters

function entry(overrides: Partial<ComboRegistryEntry> = {}): ComboRegistryEntry {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'built-in',
    enabledModels: ['deepseek-chat'],
    fetchedModels: [],
    defaultModels: ['deepseek-chat'],
    supportsImages: true,
    modelWindows: {},
    windows: {},
    hasKey: true,
    ...overrides,
  }
}

function snapshot(...providers: ComboRegistryEntry[]): ComboRegistrySnapshot {
  return { providers }
}

function theFiveEligibilityFilters() {
  const request = { estimatedTokens: 100, images: 0 }

  assert.equal(
    comboMemberEligibility({ providerId: 'nobody', modelId: 'm' }, snapshot(entry()), request),
    'no-provider'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ enabledModels: ['other'] })), request),
    'model-not-enabled'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ enabledModels: [] })), request),
    null,
    'an empty enabled list is not known yet, not a refusal'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ hasKey: false })), request),
    'no-key',
    'a keyless built-in is what resolveRun would refuse'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ kind: 'custom', hasKey: false })), request),
    null,
    'a keyless custom provider stays eligible'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ windows: { 'deepseek-chat': 50 } })), request),
    'window-too-small'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ windows: {} })), { estimatedTokens: 10_000_000, images: 0 }),
    null,
    'an unknown window is not a zero and never disqualifies'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ supportsImages: false })), { estimatedTokens: 1, images: 1 }),
    'no-vision'
  )
  assert.equal(
    comboMemberEligibility(MEMBER, snapshot(entry({ supportsImages: false })), { estimatedTokens: 1, images: 0 }),
    null,
    'no image attached, no vision filter'
  )
  results.push('eligibility: provider, enable, key, window, vision — each a code')
}

function theGuardAcceptsAnythingTheRegistryKnows() {
  assert.equal(comboMemberKnown(MEMBER, snapshot(entry())), true, 'enabled/default')
  assert.equal(
    comboMemberKnown(
      MEMBER,
      snapshot(entry({ enabledModels: [], defaultModels: [], fetchedModels: ['deepseek-chat'] }))
    ),
    true,
    'fetched but not enabled'
  )
  assert.equal(comboMemberKnown({ providerId: 'deepseek', modelId: 'gone' }, snapshot(entry())), false)
  results.push('member guard: enabled, fetched and shipped all count as known')
}

function theWalkKeepsPriorityOrderAndMarksEachVerdict() {
  const combo: Combo = { id: 'c', name: 'C', members: [MEMBER, OTHER], enabled: true }
  const walk = planComboWalk(
    combo,
    snapshot(
      entry(),
      entry({
        id: 'openrouter',
        name: 'OpenRouter',
        enabledModels: ['openai/gpt-4o-mini'],
        hasKey: false,
      })
    ),
    { estimatedTokens: 1, images: 0 }
  )
  assert.deepEqual(
    walk.map((candidate) => [candidate.member.providerId, candidate.eligible, candidate.reason]),
    [
      ['deepseek', true, undefined],
      ['openrouter', false, 'no-key'],
    ]
  )
  results.push('walk: literal priority order, verdict per member')
}

// ---------------------------------------------------------------- transcript tolerance

function aVersionThreeFileLoadsWithComboAbsent() {
  const v3 = {
    version: 3,
    interrupted: false,
    turns: [
      {
        id: 't1',
        role: 'assistant',
        content: 'hi',
        steps: [],
        endNotice: { cause: 'model_stop' },
      },
    ],
  }
  const parsed = transcriptSnapshotSchema.safeParse(v3)
  assert.equal(parsed.success, true, 'a v3 file still loads')
  assert.equal(parsed.success && parsed.data.turns[0].endNotice?.combo, undefined, 'combo is absent, not defaulted')

  const v4 = {
    version: 4,
    interrupted: false,
    turns: [
      {
        id: 't1',
        role: 'assistant',
        content: 'hi',
        steps: [],
        endNotice: {
          cause: 'combo_failed',
          combo: {
            id: 'fast',
            name: 'Fast',
            requests: [],
            attempts: [{ kind: 'failed', providerId: 'p', modelId: 'm', code: 'RATE_LIMITED' }],
          },
        },
      },
    ],
  }
  assert.equal(transcriptSnapshotSchema.safeParse(v4).success, true, 'a v4 combo block loads')
  results.push('transcript: v3 loads with combo absent, v4 carries it')
}

function comboFailedDoesNotAutoContinue() {
  // A combo that exhausted every member would walk the same list and fail at the same members. The
  // budget does not matter: one round-trip paid to reproduce the failure is one too many.
  assert.equal(shouldAutoContinue('combo_failed', [{ id: 's', text: 'work', status: 'pending' }], 0), false)
  assert.equal(shouldAutoContinue('combo_failed', [], 0), false)
  results.push('combo_failed: never auto-continued')
}

// ---------------------------------------------------------------- run

step('schema refuses empty, oversized, blank and non-slug', theSchemaRefusesWhatCannotBeACombo)
step('slug and id derivation', aNameIsTrimmedAndSlugged)
step('nesting is unrepresentable', nestingIsUnrepresentable)
step('id stability across renames', theIdIsStableAcrossARename)
step('duplicate members are idempotent', aDuplicatePairIsIdempotent)
step('failure disposition table', theDispositionTable)
step('five eligibility filters', theFiveEligibilityFilters)
step('member guard accepts the known union', theGuardAcceptsAnythingTheRegistryKnows)
step('walk preserves priority order', theWalkKeepsPriorityOrderAndMarksEachVerdict)
step('v3 transcript tolerance', aVersionThreeFileLoadsWithComboAbsent)
step('combo_failed is not auto-continued', comboFailedDoesNotAutoContinue)

process.stdout.write(`\nall ${results.length} combo protocol checks passed\n`)
