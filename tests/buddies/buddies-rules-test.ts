/**
 * Verifies the pure Buddy rules: what a record may say, which one an id resolves to, what a Buddy
 * hands a conversation at creation, and how a Buddy limits the MCP tools a turn is offered.
 *
 * Pure data in, pure data out — no electron, no disk, no window. The rules are the whole subject here,
 * which is why this suite imports them rather than exercising a screen: a settings section and a picker
 * arrive in a later turn, and what they will branch on has to be right before either exists.
 *
 * The two laws this suite exists to hold are the ones a later turn could quietly break: a Buddy's
 * `mcpIds` may only ever *narrow* the servers a turn may use, and a conversation that named no Buddy
 * must carry no trace of one.
 */
import { strict as assert } from 'node:assert'
import {
  BUILTIN_BUDDIES,
  buddyRecordSchema,
  buddySessionSeed,
  checkBuddy,
  MAX_BUDDY_MCP_IDS,
  MAX_BUDDY_NAME_CHARS,
  MAX_BUDDY_ROLE_PROMPT_CHARS,
  mcpSubsetFor,
  readBuddySession,
  resolveBuddy,
  SAMAI_BUDDY_ID,
  type BuddyRecord,
} from '../../conveyor/protocol/buddies'

const results: string[] = []

// ---------------------------------------------------------------- records

/** A custom record that declares everything a record may declare. */
function fullCustom(overrides: Partial<BuddyRecord> = {}): BuddyRecord {
  return {
    id: 'release-captain',
    name: 'Release Captain',
    glyph: 'R',
    description: 'Ships the thing and says what shipped.',
    rolePrompt: 'You are the release captain. Cut the smallest release that is honest.',
    skillIds: ['release-notes'],
    mcpIds: ['github'],
    providerId: 'deepseek',
    model: 'deepseek-chat',
    autoApprove: true,
    starters: ['Cut a release', 'What changed since the last tag?'],
    builtin: false,
    ...overrides,
  }
}

function theSchemaAcceptsAFullRecord() {
  const record = fullCustom()
  assert.equal(buddyRecordSchema.safeParse(record).success, true, 'every declared field is accepted')

  // The optional half is genuinely optional: the three built-ins declare no provider, no model and no
  // auto-approve, so a record without them has to be a record.
  const { providerId, model, autoApprove, ...bare } = record
  void providerId
  void model
  void autoApprove
  assert.equal(buddyRecordSchema.safeParse(bare).success, true, 'the three optional fields may be absent')
  results.push('the Buddy schema accepts a full custom record, and one without the optional half')
}

function aDraftIsRefusedByField() {
  // Two refusals, one per field, and both are refusals a *field* answers for: an empty name is the one
  // the user can fix in the box they typed it in, and a role prompt over the cap is the one that has to
  // be shortened rather than truncated. No code is minted for either — the field is what a caller
  // branches on, and the message stays free to change.
  const noName = checkBuddy(fullCustom({ name: '' }))
  assert.equal(noName.ok, false, 'an empty name is refused')
  assert.equal(noName.ok === false && noName.field, 'name', 'and the refusal names the name field')

  const blankName = checkBuddy(fullCustom({ name: '   ' }))
  assert.equal(blankName.ok === false && blankName.field, 'name', 'and so is a name that is only space')

  const tooLong = checkBuddy(fullCustom({ rolePrompt: 'x'.repeat(MAX_BUDDY_ROLE_PROMPT_CHARS + 1) }))
  assert.equal(tooLong.ok, false, 'a role prompt past the cap is refused rather than truncated')
  assert.equal(tooLong.ok === false && tooLong.field, 'rolePrompt', 'and the refusal names the role field')

  const overLongName = checkBuddy(fullCustom({ name: 'n'.repeat(MAX_BUDDY_NAME_CHARS + 1) }))
  assert.equal(overLongName.ok === false && overLongName.field, 'name', 'a name past its own cap is refused too')

  const tooManyServers = checkBuddy(
    fullCustom({ mcpIds: Array.from({ length: MAX_BUDDY_MCP_IDS + 1 }, (_v, i) => `server-${i}`) })
  )
  assert.equal(
    tooManyServers.ok === false && tooManyServers.field,
    'mcpIds',
    'and so is a Buddy listing too many servers'
  )

  // A good record comes back as itself, so a caller has one shape to store either way.
  const good = checkBuddy(fullCustom())
  assert.equal(good.ok, true, 'a record that passes is handed back')
  assert.deepEqual(good.ok === true && good.buddy, fullCustom(), 'unchanged')
  results.push('a draft is refused by field: empty name, over-long name, over-long role prompt')
}

// ---------------------------------------------------------------- resolution

function theDefaultAndAbsentIdsResolveToNothing() {
  // SamAi is what a conversation runs as when it named nobody, and it is not a record: resolving it to
  // one would make the default a Buddy to be edited, disabled and listed beside the others.
  assert.equal(resolveBuddy(SAMAI_BUDDY_ID), null, 'the SamAi default is not a Buddy record')
  assert.equal(resolveBuddy(''), null, 'an empty id is an absent one')
  assert.equal(resolveBuddy(null), null, 'and so is no id at all')
  assert.equal(resolveBuddy(undefined), null, 'in every spelling')
  assert.equal(resolveBuddy('nobody-by-this-name'), null, 'an id that names nothing resolves to nothing')
  assert.equal(resolveBuddy('release-captain'), null, 'and a custom id with no store behind it resolves to nothing')
  results.push('resolveBuddy returns null for absent ids and for the SamAi default')
}

function builtInsResolveToTheirOwnRecords() {
  assert.equal(BUILTIN_BUDDIES.length, 3, 'three built-ins ship with the app')

  for (const builtin of BUILTIN_BUDDIES) {
    assert.equal(builtin.builtin, true, `${builtin.id} is marked built-in`)
    const found = resolveBuddy(builtin.id)
    assert.deepEqual(found, builtin, `${builtin.id} resolves to its own record`)
  }

  // The three the design names, by id, so a rename cannot pass unnoticed: the ids are keys a session
  // record holds, and a session written today has to resolve next launch.
  assert.deepEqual(
    BUILTIN_BUDDIES.map((buddy) => buddy.id),
    ['writer-editor', 'study-tutor', 'analyst'],
    'the Writer/Editor, the Study Tutor and the Analyst'
  )

  // The store's records are resolvable beside the built-ins, and a built-in's id is never shadowed by a
  // custom record claiming it: the built-in is the app's own data and wins.
  const custom = fullCustom()
  assert.deepEqual(resolveBuddy('release-captain', [custom]), custom, 'a custom record resolves through the store list')
  assert.deepEqual(
    resolveBuddy('analyst', [{ ...custom, id: 'analyst' }]),
    BUILTIN_BUDDIES.find((buddy) => buddy.id === 'analyst'),
    'and cannot shadow a built-in'
  )
  results.push('the built-ins resolve to their own records, and custom ids beside them')
}

// ---------------------------------------------------------------- what a Buddy hands a session

function theSeedRuleReturnsWhatTheBuddyDeclares() {
  // Which fields a Buddy declares and which it leaves alone is the whole meaning of the seed: a Buddy
  // that names no model must not pin the conversation to one, and a Buddy that names no skills must not
  // claim it activated none.
  const analyst = resolveBuddy('analyst')
  assert.ok(analyst, 'the Analyst is a built-in')

  const bare = buddySessionSeed(analyst)
  assert.deepEqual(
    bare,
    { buddyId: 'analyst', rolePrompt: analyst.rolePrompt },
    'a Buddy that declares nothing beyond its role hands the session exactly its id and its role'
  )
  assert.equal('activeSkillIds' in bare, false, 'nothing chose skills for it')
  assert.equal('providerId' in bare, false, 'and it pins no provider')
  assert.equal('model' in bare, false, 'no model either')
  assert.equal('autoApprove' in bare, false, 'and it says nothing about consent')

  const full = buddySessionSeed(fullCustom())
  assert.deepEqual(
    full,
    {
      buddyId: 'release-captain',
      rolePrompt: fullCustom().rolePrompt,
      mcpSubset: ['github'],
      activeSkillIds: ['release-notes'],
      providerId: 'deepseek',
      model: 'deepseek-chat',
      autoApprove: true,
    },
    'a Buddy that declares everything hands the session exactly those fields'
  )

  // A model without its provider is half a choice, and the worse half: a model id belongs to the
  // provider that serves it, so seeding `deepseek-chat` onto whichever provider the window happens to
  // be on would pin the conversation to a pair that cannot run. Both or neither.
  const modelOnly = buddySessionSeed(fullCustom({ providerId: undefined }))
  assert.equal('providerId' in modelOnly, false, 'a provider the Buddy does not name is not seeded')
  assert.equal('model' in modelOnly, false, 'and its model does not travel without it')

  // An empty declaration is no declaration: an empty skill list says "no skills chosen", which is what
  // the absent key says, and an empty server list says "no limit", which is what the absent key says.
  const emptyLists = buddySessionSeed(fullCustom({ skillIds: [], mcpIds: [] }))
  assert.equal('activeSkillIds' in emptyLists, false, 'an empty skill list adds no key')
  assert.equal('mcpSubset' in emptyLists, false, 'and an empty server list adds none either')
  results.push('the seed rule returns exactly the declared fields and omits undeclared ones')
}

// ---------------------------------------------------------------- the MCP subset

function theSubsetRuleOnlyEverNarrows() {
  const trusted = ['github', 'postgres', 'filesystem']

  // The one direction that matters: a Buddy's list is read against what is already trusted and enabled,
  // never added to it. A server the Buddy names that this app has not been given is simply not there.
  assert.deepEqual(mcpSubsetFor(['github'], trusted), ['github'], 'a declared server is kept')
  assert.deepEqual(mcpSubsetFor(['github', 'ghost'], trusted), ['github'], 'a server nobody trusted is not')
  assert.deepEqual(
    mcpSubsetFor(['postgres', 'github'], trusted),
    ['github', 'postgres'],
    'and the order is the trusted set own order, so the same subset is the same list'
  )
  assert.deepEqual(mcpSubsetFor(['ghost'], trusted), [], 'a Buddy naming only untrusted servers gets none of them')

  // Declaring nothing is not declaring nothing may run: it is declining to narrow, which is what the
  // SamAi default means, and it is why a Buddy with no `mcpIds` behaves exactly like no Buddy at all.
  assert.deepEqual(mcpSubsetFor([], trusted), trusted, 'declaring nothing leaves the whole trusted set')
  assert.deepEqual(mcpSubsetFor(undefined, trusted), trusted, 'an absent declaration does the same')
  assert.deepEqual(mcpSubsetFor(null, trusted), trusted, 'in every spelling of absent')
  assert.deepEqual(mcpSubsetFor(undefined, []), [], 'and with nothing trusted, nothing is offered')

  // Nothing is shared with the caller: the list this returns is the list a request is built from, and a
  // caller that mutated it would be editing the trusted set rather than reading it.
  const returned = mcpSubsetFor(undefined, trusted)
  returned.push('injected')
  assert.deepEqual(trusted, ['github', 'postgres', 'filesystem'], 'the trusted set handed in is left alone')
  results.push(
    'the mcp subset rule intersects with trusted-and-enabled, and returns the full set when nothing is declared'
  )
}

// ---------------------------------------------------------------- the session keys

function theSessionKeysAreAdditiveAndOptional() {
  const written = {
    buddyId: 'analyst',
    rolePrompt: 'You are the analyst.',
    mcpSubset: ['github'],
  }

  const read = readBuddySession(written)
  assert.deepEqual(
    read,
    { buddyId: 'analyst', rolePrompt: 'You are the analyst.', mcpSubset: ['github'] },
    'the keys read back as written'
  )

  // An old record: written before the keys existed, and still a conversation. It reads as the SamAi
  // default — every key absent, which is exactly what a conversation that named no Buddy means — and
  // nothing writes a key onto it on the way out.
  const old = {
    id: '11111111-2222-4333-8444-000000000001',
    title: 'Written before Buddies',
    createdAt: 1,
    updatedAt: 2,
    providerId: 'deepseek',
    model: 'deepseek-chat',
    activeSkillIds: ['release-notes'],
  }
  assert.deepEqual(
    readBuddySession(old),
    { buddyId: null, rolePrompt: null, mcpSubset: null },
    'an old record reads back as the default rather than gaining a Buddy'
  )
  const serialized = JSON.parse(JSON.stringify(old)) as Record<string, unknown>
  assert.equal('buddyId' in serialized, false, 'and nothing writes a buddyId on the way out')
  assert.equal('rolePrompt' in serialized, false, 'no role either')
  assert.equal('mcpSubset' in serialized, false, 'and no subset')

  // Each key stands on its own: a record that carries only some of them is read for the ones it
  // carries. That is what makes the three keys additive rather than one shape written three ways.
  assert.deepEqual(
    readBuddySession({ rolePrompt: 'You are the tutor.' }),
    { buddyId: null, rolePrompt: 'You are the tutor.', mcpSubset: null },
    'a role without an id is still a role'
  )

  // A key of the wrong shape is stripped rather than guessed at, for the reason every other key in this
  // record is: a value that cannot be what it claims would otherwise be sent as standing context.
  assert.deepEqual(
    readBuddySession({ buddyId: 42 }),
    { buddyId: null, rolePrompt: null, mcpSubset: null },
    'a non-string id is stripped'
  )
  assert.deepEqual(
    readBuddySession(null),
    { buddyId: null, rolePrompt: null, mcpSubset: null },
    'and no record at all is no keys'
  )
  assert.deepEqual(
    readBuddySession({ mcpSubset: ['github', 7] }),
    { buddyId: null, rolePrompt: null, mcpSubset: null },
    'a subset that is not a list of ids is stripped whole rather than half-read'
  )
  assert.deepEqual(
    readBuddySession({ rolePrompt: 'x'.repeat(MAX_BUDDY_ROLE_PROMPT_CHARS + 1) }),
    { buddyId: null, rolePrompt: null, mcpSubset: null },
    'and a role past the cap is not injected as standing context'
  )

  const roundTripped = JSON.parse(JSON.stringify(written)) as unknown
  assert.deepEqual(
    readBuddySession(roundTripped),
    readBuddySession(written),
    'the keys round trip through the file they are written to'
  )
  results.push('buddyId, rolePrompt and mcpSubset serialize through the additive-optional pattern')
}

// ---------------------------------------------------------------- main

async function main() {
  theSchemaAcceptsAFullRecord()
  aDraftIsRefusedByField()
  theDefaultAndAbsentIdsResolveToNothing()
  builtInsResolveToTheirOwnRecords()
  theSeedRuleReturnsWhatTheBuddyDeclares()
  theSubsetRuleOnlyEverNarrows()
  theSessionKeysAreAdditiveAndOptional()

  console.log(`buddy rules: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

void main().catch((err) => {
  console.error('BUDDY RULES TEST FAILED:', err)
  process.exit(1)
})
