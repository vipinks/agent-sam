/**
 * The combos module: the file, the boot-order guarantee, the CRUD rules and their codes.
 *
 * The first pin is the boot ordering: a query before `loadCombosSync` must not answer "empty", because
 * the router runs that load synchronously before any window exists and a first query that returned an
 * empty list would let a save write it over a file that has combos in it. Every later pin runs against
 * the same module instance, so the load is done once, exactly as it is in the app.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConveyorError } from 'electron-conveyor/main'
import {
  addComboMember,
  buildComboRegistrySnapshot,
  combosFilePath,
  createComboWithMember,
  deleteCombo,
  listCombos,
  loadCombosSync,
  removeComboMemberById,
  renameCombo,
  reorderCombo,
  setComboRegistrySource,
  setCombosSink,
  setComboEnabled,
} from '../../conveyor/modules/combos'
import { MAX_COMBO_MEMBERS, type Combo } from '../../conveyor/protocol/combos'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const DEEPSEEK = {
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'http://localhost:1234/v1',
  apiKey: '',
  dialect: 'openai' as const,
  models: ['deepseek-chat', 'deepseek-reasoner'],
}
const OPENROUTER = {
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'http://localhost:2345/v1',
  apiKey: '',
  dialect: 'openai' as const,
  models: ['openai/gpt-4o-mini'],
}

function installRegistry(): void {
  setComboRegistrySource(() =>
    buildComboRegistrySnapshot({
      providers: [],
      custom: [DEEPSEEK, OPENROUTER],
      defaults: {},
      configs: {},
      configured: [],
    })
  )
}

const FILE = combosFilePath()

function writeFile(combos: unknown): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify({ combos }), 'utf8')
}

function readCombos(): Combo[] {
  return (JSON.parse(readFileSync(FILE, 'utf8')) as { combos: Combo[] }).combos
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ConveyorError) return error.code
    return `not-a-conveyor-error: ${String(error)}`
  }
  return 'resolved'
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'resolved'
  } catch (error) {
    return error instanceof ConveyorError ? error.code : `not-a-conveyor-error: ${String(error)}`
  }
}

// The boot-order pin, first, before anything has loaded.
async function aQueryBeforeLoadCannotAnswerEmpty(): Promise<void> {
  assert.equal(
    codeOf(() => listCombos()),
    'COMBO_IO_ERROR'
  )
  results.push('boot: a query before the load refuses rather than answering an empty list')
}

async function theInitialLoadIsSynchronousAndMirrorsTheFile(): Promise<void> {
  writeFile([
    { id: 'fast', name: 'Fast', members: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }], enabled: true },
    {
      id: 'slow',
      name: 'Slow',
      members: [{ providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' }],
      enabled: false,
    },
  ])
  installRegistry()
  const published: Combo[][] = []
  setCombosSink((combos) => published.push(combos))

  loadCombosSync()

  assert.equal(published.length, 1, 'the load dispatches replace once')
  assert.deepEqual(
    published[0].map((combo) => combo.id),
    ['fast', 'slow']
  )
  assert.equal(listCombos().length, 2, 'the query answers what the file says')
  results.push('boot: load is synchronous, publishes replace, list agrees with the file')
}

async function createRenameAndReorder(): Promise<void> {
  const created = await createComboWithMember({
    name: '  Work  ',
    providerId: 'deepseek',
    modelId: 'deepseek-reasoner',
  })
  assert.equal(created.id, 'work')
  assert.equal(created.name, 'Work')
  assert.equal(created.enabled, true)
  assert.equal(
    readCombos().some((combo) => combo.id === 'work'),
    true
  )

  const renamed = await renameCombo('work', 'Work + Play')
  assert.equal(renamed.id, 'work', 'the id does not move')
  assert.equal(renamed.name, 'Work + Play')

  const added = await addComboMember('work', { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' })
  assert.deepEqual(
    added.members.map((member) => member.providerId),
    ['deepseek', 'openrouter']
  )
  const again = await addComboMember('work', { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' })
  assert.equal(again.members.length, 2, 'a duplicate pair writes nothing new')

  const reordered = await reorderCombo('work', 0, 1)
  assert.deepEqual(
    reordered.members.map((member) => member.providerId),
    ['openrouter', 'deepseek']
  )
  results.push('create, rename, add (idempotent) and reorder')
}

async function removeTheLastMemberRefuses(): Promise<void> {
  assert.equal(
    await rejection(removeComboMemberById('work', { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' })),
    'resolved'
  )
  assert.equal(
    await rejection(removeComboMemberById('work', { providerId: 'deepseek', modelId: 'deepseek-reasoner' })),
    'COMBO_EMPTY',
    'the last member cannot go'
  )
  results.push('remove: one member ok, the last refuses COMBO_EMPTY')
}

async function theLimitAndTheGuard(): Promise<void> {
  const created = await createComboWithMember({ name: 'Big', providerId: 'deepseek', modelId: 'deepseek-chat' })
  // An unknown pair is refused while there is room; the limit below is checked before the guard, so
  // this is the pin that the guard is reachable at all.
  assert.equal(
    await rejection(addComboMember(created.id, { providerId: 'nobody', modelId: 'nope' })),
    'COMBO_MEMBER_UNKNOWN'
  )
  // Make the provider know eight models, then fill the combo to its cap.
  const many = { ...DEEPSEEK, models: ['deepseek-chat', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'] }
  setComboRegistrySource(() =>
    buildComboRegistrySnapshot({ providers: [], custom: [many], defaults: {}, configs: {}, configured: [] })
  )
  for (const model of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']) {
    await addComboMember(created.id, { providerId: 'deepseek', modelId: model })
  }
  assert.equal(listCombos().find((combo) => combo.id === created.id)?.members.length, MAX_COMBO_MEMBERS)
  assert.equal(await rejection(addComboMember(created.id, { providerId: 'deepseek', modelId: 'a8' })), 'COMBO_LIMIT')
  results.push(`limit: ${MAX_COMBO_MEMBERS} is the cap; unknown members refuse`)
}

async function togglingAndDeleting(): Promise<void> {
  const disabled = await setComboEnabled('work', false)
  assert.equal(disabled.enabled, false)
  await deleteCombo('work')
  assert.equal(
    listCombos().some((combo) => combo.id === 'work'),
    false
  )
  assert.equal(await rejection(deleteCombo('work')), 'COMBO_NOT_FOUND')
  assert.equal(await rejection(renameCombo('work', 'X')), 'COMBO_NOT_FOUND')
  assert.equal(await rejection(setComboEnabled('work', true)), 'COMBO_NOT_FOUND')
  results.push('toggle, delete, and the not-found code')
}

async function aCorruptFileIsReportedAndNotOverwritten(): Promise<void> {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, '{ this is not json', 'utf8')
  const before = readFileSync(FILE, 'utf8')

  loadCombosSync()
  assert.equal(
    codeOf(() => listCombos()),
    'COMBO_IO_ERROR'
  )
  const failed = await rejection(addComboMember('whatever', { providerId: 'deepseek', modelId: 'deepseek-chat' }))
  assert.equal(failed, 'COMBO_IO_ERROR')
  assert.equal(readFileSync(FILE, 'utf8'), before, 'a failed command does not overwrite the corrupt file')
  results.push('corrupt: reported as COMBO_IO_ERROR and left untouched')
}

async function aRepairedFileLoadsAgain(): Promise<void> {
  writeFile([
    { id: 'fixed', name: 'Fixed', members: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }], enabled: true },
  ])
  loadCombosSync()
  assert.deepEqual(
    listCombos().map((combo) => combo.id),
    ['fixed']
  )
  results.push('corrupt: a later successful read clears the refusal')
}

async function cleanUp(): Promise<void> {
  // The harness's own userData is private, but a rerun inside one process should start clean.
  rmSync(FILE, { force: true })
}

async function main(): Promise<void> {
  await step('a query before load cannot answer empty', aQueryBeforeLoadCannotAnswerEmpty)
  await step('the initial load is synchronous and mirrors the file', theInitialLoadIsSynchronousAndMirrorsTheFile)
  await step('create, rename, add and reorder', createRenameAndReorder)
  await step('the last member refuses', removeTheLastMemberRefuses)
  await step('the cap and the member guard', theLimitAndTheGuard)
  await step('toggle and delete', togglingAndDeleting)
  await step('a corrupt file is reported, not overwritten', aCorruptFileIsReportedAndNotOverwritten)
  await step('a repaired file loads again', aRepairedFileLoadsAgain)
  await step('cleanup', cleanUp)

  console.log(`combos module: ${results.length} passed`)
  for (const result of results) console.log(`  pass: ${result}`)
}

void main().catch((err) => {
  console.error('COMBOS MODULE TEST FAILED:', err)
  process.exit(1)
})
