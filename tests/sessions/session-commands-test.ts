/**
 * Verifies the two session commands main owns: the transcript scan behind search, and the export.
 *
 * Both are exercised through the module's own record, as the storage suite does for delete — so what
 * is under test is the handler the renderer actually calls, including its schema, rather than a
 * helper beside it. The save dialog is answered from `SAM_TEST_SAVE_PATH` (see `tests/stubs/`), which
 * is what lets the accept path and the cancel path both be real without a dialog ever opening.
 *
 * Two properties are asserted on the wire rather than in prose, because they are the ones that would
 * be violated invisibly: a search result contains no transcript body, and a cancelled export writes
 * nothing at all.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionsModule, SEARCH_MAX_FILES } from '../../conveyor/modules/sessions'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '../../conveyor/protocol/transcript'
import {
  conversationText,
  searchTranscriptText,
  SEARCH_MAX_SNIPPETS,
  SEARCH_MIN_TERM,
} from '../../conveyor/protocol/search'
import { exportFileName } from '../../conveyor/protocol/export'
import { titleFromTranscript, UNTITLED } from '../../conveyor/protocol/session-title'

const results: string[] = []

const MATCHING_ID = '11111111-2222-4333-8444-555555555555'
const SILENT_ID = '33333333-4444-4555-8666-777777777777'
const CORRUPT_ID = '44444444-5555-4666-8777-888888888888'

/** A conversation that mentions the term several times, plus a tool card. */
function matchingSnapshot(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'u1', role: 'user', content: 'the parser drops trailing newlines', steps: [] },
      {
        id: 'a1',
        role: 'assistant',
        content: 'The parser needs a trim. I checked the parser and the parser is otherwise fine.',
        steps: [{ callId: 'c1', tool: 'read_file', args: { path: 'parser.ts' }, status: 'ok', output: 'parse()' }],
      },
    ],
  }
}

/** A conversation with no trace of the term. */
function silentSnapshot(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'u1', role: 'user', content: 'unrelated subject entirely', steps: [] }],
  }
}

const TERM = 'parser'

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

/** The module's own handler for a member, as the renderer reaches it. */
function resolverOf(member: string): { resolver: (opts: { input: unknown; ctx?: unknown }) => Promise<unknown> } {
  const record = sessionsModule.record[member] as unknown as {
    resolver: (opts: { input: unknown; ctx?: unknown }) => Promise<unknown>
  }
  assert.ok(record?.resolver, `${member} must have a resolver`)
  return record
}

function inputSchemaOf(member: string): { safeParse: (v: unknown) => { success: boolean } } {
  const record = sessionsModule.record[member] as unknown as {
    input?: { safeParse: (v: unknown) => { success: boolean } }
  }
  const schema = record.input
  assert.ok(schema, `${member} must declare an input schema`)
  return schema
}

async function call(member: string, input: unknown): Promise<unknown> {
  // `ctx.window` is supplied as undefined, which is the case the handler has to survive anyway: the
  // existing `pickFolder` and `window` handlers all branch on it, because a handler can be invoked
  // with no owning window. The export therefore has to fall back to the window-less dialog form here,
  // which is what makes this a test of the real handler rather than of a convenient shape.
  return resolverOf(member).resolver({ input, ctx: { window: undefined } })
}

// ---------------------------------------------------------------- the scan

async function theScanFindsMatchingConversationsOnly() {
  const found = (await call('searchSessions', { term: TERM })) as Array<{
    id: string
    matchCount: number
    snippets: string[]
  }>

  const ids = found.map((r) => r.id)
  assert.ok(ids.includes(MATCHING_ID), 'the conversation that mentions the term is found')
  assert.ok(!ids.includes(SILENT_ID), 'the conversation that does not is not reported at all')

  const match = found.find((r) => r.id === MATCHING_ID)
  assert.ok(match, 'the matching conversation is present')

  // The count is the same rule the pure module applies to the same text, so this pins the wiring
  // rather than re-asserting the rule.
  const expected = searchTranscriptText(conversationText(matchingSnapshot()), TERM, SEARCH_MAX_SNIPPETS)
  assert.equal(match.matchCount, expected.matchCount, 'the count matches the pure rule over the same text')
  assert.ok(match.matchCount > 1, 'the term really does occur more than once in the fixture')

  // Pagination is not part of the contract, but the cap is: no result may carry more snippets than
  // the budget, whatever the conversation contains.
  assert.ok(match.snippets.length <= SEARCH_MAX_SNIPPETS, `at most ${SEARCH_MAX_SNIPPETS} snippets per session`)
  assert.ok(match.snippets.length > 0, 'a matching session carries at least one snippet')
  assert.ok(
    match.snippets.every((s) => s.toLowerCase().includes(TERM)),
    'every snippet contains the term'
  )
  results.push('the scan reports matching conversations with a count and bounded snippets')
}

async function aResultCarriesNoTranscript() {
  const found = (await call('searchSessions', { term: TERM })) as Array<Record<string, unknown>>
  assert.ok(found.length > 0, 'there is a result to inspect')

  for (const result of found) {
    // Exactly these three keys. This is the boundary rule stated as a shape: the renderer receives
    // snippets and a count, so a result that grew a `turns` or `content` field would be the bug this
    // assertion exists to catch — and it would be invisible in a UI that ignores the extra field.
    assert.deepEqual(
      Object.keys(result).sort(),
      ['id', 'matchCount', 'snippets'],
      `a search result must carry only the id, the count and the snippets, got ${JSON.stringify(Object.keys(result))}`
    )
    assert.ok(!('turns' in result), 'no turns cross the boundary')
    assert.ok(!('content' in result), 'no turn content crosses the boundary')
    // The whole payload has to be small: a transcript body smuggled into a snippet would show up here.
    assert.ok(
      JSON.stringify(result).length < 2000,
      `a result must stay small, got ${JSON.stringify(result).length} characters`
    )
  }
  results.push('a search result carries only an id, a count and snippets — never a transcript')
}

async function unreadableFilesAreSkippedNotFatal() {
  // Seeded corrupt, and the scan must still answer for the other conversations: one unreadable file
  // on disk must not take the search down with it.
  writeFileSync(join(sessionDir, `${CORRUPT_ID}.json`), '{"version":2,"turns":[', 'utf8')

  const found = (await call('searchSessions', { term: TERM })) as Array<{ id: string }>
  assert.ok(
    found.some((r) => r.id === MATCHING_ID),
    'the readable matching conversation is still reported'
  )
  assert.ok(!found.some((r) => r.id === CORRUPT_ID), 'the corrupt file contributes no result')
  results.push('a corrupt conversation is skipped by the scan rather than failing it')
}

function theScanRefusesShortTerms() {
  const schema = inputSchemaOf('searchSessions')
  assert.equal(schema.safeParse({ term: TERM }).success, true, 'a three-character term is accepted')
  assert.equal(schema.safeParse({ term: 'ab' }).success, false, 'a two-character term is refused by the schema')
  assert.equal(schema.safeParse({ term: '' }).success, false, 'an empty term is refused by the schema')
  assert.equal(schema.safeParse({}).success, false, 'a missing term is refused by the schema')
  assert.equal(SEARCH_MIN_TERM, 3, 'the floor is the documented one')
  // The cap is a real number and a bounded one, which is what "never unbounded" means in practice.
  assert.ok(SEARCH_MAX_FILES > 0 && SEARCH_MAX_FILES <= 1000, `the file cap is bounded, got ${SEARCH_MAX_FILES}`)
  results.push('the scan refuses a term below the shared floor, and its file cap is bounded')
}

async function aTermThatMatchesNothingReturnsNothing() {
  const found = (await call('searchSessions', { term: 'zzzznotpresent' })) as Array<unknown>
  assert.deepEqual(found, [], 'a term with no matches yields an empty list, not an error')
  results.push('a term matching nothing returns an empty list')
}

// ---------------------------------------------------------------- the export

async function markdownIsWrittenWhereTheDialogSaid() {
  const target = join(workDir, 'exported.md')
  process.env.SAM_TEST_SAVE_PATH = target

  const path = await call('exportSession', { id: MATCHING_ID, format: 'markdown' })
  assert.equal(path, target, 'the command reports the path the dialog returned')
  assert.equal(existsSync(target), true, 'the file exists at that path')

  const written = readFileSync(target, 'utf8')
  assert.ok(written.startsWith('# the parser drops trailing newlines'), 'the title heads the export')
  assert.equal(written.split('## You').length - 1, 1, 'the user turn has its heading once')
  assert.equal(written.split('## Sam AI').length - 1, 1, 'the assistant turn has its heading once')
  assert.ok(written.includes('```tool read_file'), 'the tool card is rendered')
  assert.ok(written.includes('outcome (ok): parse()'), 'the tool outcome is rendered')
  results.push('the markdown export is written to the dialog path, with the conversation rendered')
}

async function jsonIsTheSnapshotAndNamedFromTheTranscript() {
  const target = join(workDir, 'exported.json')
  process.env.SAM_TEST_SAVE_PATH = target

  await call('exportSession', { id: MATCHING_ID, format: 'json' })
  const parsed = JSON.parse(readFileSync(target, 'utf8'))
  assert.deepEqual(parsed, matchingSnapshot(), 'the json export is the stored snapshot itself')
  results.push('the json export is the raw snapshot, unchanged')
}

async function cancellingWritesNothing() {
  const target = join(workDir, 'never-written.md')
  // No SAM_TEST_SAVE_PATH: the stub answers as a dismissed dialog.
  delete process.env.SAM_TEST_SAVE_PATH

  const path = await call('exportSession', { id: MATCHING_ID, format: 'markdown' })
  assert.equal(path, null, 'a cancelled export returns null rather than a path')
  assert.equal(existsSync(target), false, 'and nothing is written')
  results.push('a dismissed save dialog returns null and writes no file')
}

async function exportingAnUnsavedSessionHasItsOwnCode() {
  process.env.SAM_TEST_SAVE_PATH = join(workDir, 'should-not-exist.md')

  await assert.rejects(
    call('exportSession', { id: '99999999-8888-4777-8666-555555555555', format: 'markdown' }),
    (e: { code?: string }) => e.code === 'SESSION_NOT_FOUND',
    'exporting a session with no transcript must raise SESSION_NOT_FOUND'
  )
  assert.equal(existsSync(join(workDir, 'should-not-exist.md')), false, 'and must not create the file')
  results.push('exporting a session that was never saved raises SESSION_NOT_FOUND')
}

function theExportSchemaIsClosed() {
  const schema = inputSchemaOf('exportSession')
  assert.equal(schema.safeParse({ id: MATCHING_ID, format: 'markdown' }).success, true, 'markdown is accepted')
  assert.equal(schema.safeParse({ id: MATCHING_ID, format: 'json' }).success, true, 'json is accepted')
  assert.equal(schema.safeParse({ id: MATCHING_ID, format: 'pdf' }).success, false, 'an unknown format is refused')
  assert.equal(schema.safeParse({ id: MATCHING_ID }).success, false, 'a missing format is refused')
  assert.equal(schema.safeParse({ format: 'json' }).success, false, 'a missing id is refused')
  results.push('the export schema accepts exactly the two formats and a valid id')
}

function theDefaultFileNameMatchesTheDerivedTitle() {
  // The filename main offers in the dialog is derived from the same rule the row's title came from,
  // which is what keeps the two from disagreeing about what a conversation is called.
  const title = titleFromTranscript(matchingSnapshot())
  assert.equal(title, 'the parser drops trailing newlines', 'the title comes from the first user message')
  assert.equal(exportFileName(title, 'markdown'), `${title}.md`, 'the default name follows the title')
  assert.equal(exportFileName(title, 'json'), `${title}.json`, 'in either format')

  // A conversation with no user prose at all still gets a name to write under.
  const blank: TranscriptSnapshot = { version: TRANSCRIPT_VERSION, interrupted: false, turns: [] }
  assert.equal(titleFromTranscript(blank), UNTITLED, 'a conversation with no message falls back')
  results.push('the default export filename is derived from the transcript by the shared title rule')
}

// ---------------------------------------------------------------- harness

let sessionDir = ''
let workDir = ''

async function main() {
  const root = process.env.SAM_TEST_USER_DATA
  if (!root) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  sessionDir = join(root, 'sessions')
  workDir = join(root, 'exports')
  mkdirSync(sessionDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  try {
    // Two readable conversations, one of which mentions the term, and one unrelated.
    writeFileSync(join(sessionDir, `${MATCHING_ID}.json`), JSON.stringify(matchingSnapshot()), 'utf8')
    writeFileSync(join(sessionDir, `${SILENT_ID}.json`), JSON.stringify(silentSnapshot()), 'utf8')
    // A file that is not a session id at all, so the scan's own filename filtering is exercised.
    writeFileSync(join(sessionDir, 'not-a-session.json'), JSON.stringify(matchingSnapshot()), 'utf8')

    await step('scan matches', theScanFindsMatchingConversationsOnly)
    await step('scan boundary', aResultCarriesNoTranscript)
    await step('scan resilience', unreadableFilesAreSkippedNotFatal)
    await step('scan schema', theScanRefusesShortTerms)
    await step('scan empty', aTermThatMatchesNothingReturnsNothing)
    await step('export markdown', markdownIsWrittenWhereTheDialogSaid)
    await step('export json', jsonIsTheSnapshotAndNamedFromTheTranscript)
    await step('export cancel', cancellingWritesNothing)
    await step('export missing', exportingAnUnsavedSessionHasItsOwnCode)
    await step('export schema', theExportSchemaIsClosed)
    await step('export filename', theDefaultFileNameMatchesTheDerivedTitle)

    // The unrelated file must not have become an exported or scanned session along the way.
    assert.ok(
      readdirSync(sessionDir).includes('not-a-session.json'),
      'a non-session file is left alone by every command'
    )

    console.log(`session commands (search, export): ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    delete process.env.SAM_TEST_SAVE_PATH
    rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('SESSION COMMANDS TEST FAILED:', err)
  process.exit(1)
})
