/**
 * Verifies the episodic-capture rules: what one completed turn contributes to an episode, what is
 * deliberately left out, the byte bound, the sanitizer's four added redaction rules, the per-session
 * page writer (supersede in place, rotation, mtime invalidation), and the brief's episode section
 * (appended last, newest first, five blocks, whole-block truncation). Plus the one guarantee the
 * fire-and-forget path rests on: a failed capture never throws.
 *
 * The filesystem half runs against a temp app-data directory passed in explicitly, so no suite ever
 * touches the real `%APPDATA%` — the property every memory and sessions suite shares.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPISODE_PAGE_DIR,
  MAX_EPISODE_ASK_CHARS,
  MAX_EPISODE_BYTES,
  MAX_EPISODE_COMBO_ATTEMPTS,
  MAX_EPISODE_PAGE_BYTES,
  MAX_EPISODE_TOOLS,
  MAX_EPISODES_PER_PAGE,
  episodeRowFromBlock,
  extractEpisode,
  latestEpisodeTurnId,
  parseEpisodeBlocks,
  renderEpisodeBlock,
  type EpisodeBlock,
} from '../../conveyor/protocol/episodes'
import {
  EPISODES_IN_BRIEF,
  MAX_EPISODES_BRIEF_BYTES,
  MAX_MEMORY_BRIEF_BYTES,
  assembleMemorySection,
} from '../../conveyor/protocol/memory'
import {
  appendEpisodePage,
  captureEpisode,
  deleteEpisodeBlocksForTurns,
  ensureMemoryIndex,
  listMemoryEpisodes,
  memoryRoot,
  setEpisodesEnabledSource,
  setSessionRootSource,
  writeMemoryPage,
} from '../../conveyor/modules/memory'
import { sessionsModule } from '../../conveyor/modules/sessions'
import {
  TRANSCRIPT_VERSION,
  type TranscriptSnapshot,
  type TranscriptToolStep,
  type TranscriptTurn,
} from '../../conveyor/protocol/transcript'

const results: string[] = []

const SESSION = '11111111-2222-4333-8444-555555555555'
const OTHER = '22222222-3333-4444-8555-666666666666'

/** A fixed capture clock, so "the capture time" is asserted as a value rather than around one. */
const AT = Date.UTC(2026, 0, 2, 3, 4, 5)

function bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

function snap(turns: TranscriptTurn[]): TranscriptSnapshot {
  return { version: TRANSCRIPT_VERSION, interrupted: false, turns }
}

function userTurn(id: string, content: string): TranscriptTurn {
  return { id, role: 'user', content, steps: [] }
}

function assistantTurn(id: string, content: string, extra: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return { id, role: 'assistant', content, steps: [], ...extra }
}

function toolStep(index: number, status: TranscriptToolStep['status'] = 'ok'): TranscriptToolStep {
  return {
    callId: `call_${index}`,
    tool: `tool_${index}`,
    args: { command: 'SECRET ARGUMENT VALUE' },
    status,
    output: 'SECRET TOOL OUTPUT',
    code: 'SECRET CODE',
  }
}

/**
 * One turn with every excluded field populated: outputs, argument values, error text, mention paths,
 * image references, a failure tail and plan titles are all present and must all stay out of the block.
 */
function richSnapshot(): TranscriptSnapshot {
  return snap([
    {
      ...userTurn('user-1', '  please\n   fix the parser  '),
      mentionPaths: ['C:/secret/plan.md'],
      imageRefs: [{ id: 'image-1', name: 'shot.png', mimeType: 'image/png', size: 1024 }],
    },
    assistantTurn('assistant-2', 'Fixed it.', {
      steps: Array.from({ length: 14 }, (_, index) => toolStep(index, index === 13 ? 'failed' : 'ok')),
      error: 'SECRET ERROR TEXT',
      plan: [
        { id: 'p1', text: 'PLAN TITLE ONE', status: 'done' },
        { id: 'p2', text: 'PLAN TITLE TWO', status: 'interrupted' },
      ],
      continuations: [{ count: 1, max: 8, afterSteps: 2 }],
      endNotice: {
        cause: 'truncated',
        midWork: true,
        unfinishedSteps: 2,
        failure: { exitCode: 1, code: 'EXIT', tail: 'FAILURE TAIL TEXT' },
        combo: {
          id: 'fast',
          name: 'Fast answers',
          requests: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
          attempts: [
            { kind: 'failed', providerId: 'openai', modelId: 'gpt-4o' },
            { kind: 'failed', providerId: 'anthropic', modelId: 'claude-sonnet' },
            { kind: 'skipped', providerId: 'google', modelId: 'gemini-pro' },
            { kind: 'skipped', providerId: 'mistral', modelId: 'mistral-large' },
            { kind: 'skipped', providerId: 'xai', modelId: 'grok' },
            { kind: 'skipped', providerId: 'meta', modelId: 'llama' },
          ],
        },
      },
    }),
  ])
}

function makeRoots() {
  const appData = mkdtempSync(join(tmpdir(), 'sam-episodes-'))
  const root = join(appData, 'workspace')
  mkdirSync(root, { recursive: true })
  return { appData, root, cleanup: () => rmSync(appData, { recursive: true, force: true }) }
}

function pagePath(appData: string, root: string, sessionId: string): string {
  return join(memoryRoot(appData, root), EPISODE_PAGE_DIR, `${sessionId}.md`)
}

function markerCount(page: string): number {
  return (page.match(/<!-- episode turn=/g) ?? []).length
}

/** The capture clock one block was written with, as the marker states it. */
function capturedAtOf(page: string, turnId: string): string | null {
  return new RegExp(`<!-- episode turn=${turnId} at=([^ ]+) -->`).exec(page)?.[1] ?? null
}

/** A page that may not have been written yet, read as empty rather than raised. */
function readPage(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- extraction

function theExtractionGateRefusesWhatCannotBeAnEpisode() {
  const summary: TranscriptTurn = {
    ...userTurn('summary-1', 'a compacted summary'),
    summarizesTurns: ['user-0'],
  }
  const snapshot = snap([userTurn('user-1', 'do it'), summary, assistantTurn('assistant-2', 'ok')])

  assert.equal(extractEpisode(SESSION, snapshot, 'summary-1', AT), null, 'a summary turn is not an episode')
  assert.equal(extractEpisode(SESSION, snapshot, 'user-1', AT), null, 'a question is not an episode')
  assert.equal(extractEpisode(SESSION, snapshot, 'missing', AT), null, 'a turn not on the trail is not one')

  for (const status of ['running', 'awaiting', 'queued'] as const) {
    const inFlight = snap([
      userTurn('user-1', 'do it'),
      assistantTurn('assistant-2', 'working', { steps: [toolStep(0, status)] }),
    ])
    assert.equal(extractEpisode(SESSION, inFlight, 'assistant-2', AT), null, `a ${status} call is in flight`)
  }

  const empty = snap([userTurn('user-1', 'do it'), assistantTurn('assistant-2', '   ')])
  assert.equal(extractEpisode(SESSION, empty, 'assistant-2', AT), null, 'an empty turn is not an episode')

  const settled = snap([
    userTurn('user-1', 'do it'),
    assistantTurn('assistant-2', 'done', { steps: [toolStep(0, 'interrupted')] }),
  ])
  assert.ok(
    extractEpisode(SESSION, settled, 'assistant-2', AT),
    'a settled call — even an interrupted one — is still capturable'
  )

  results.push('the extraction gate refuses summary turns, questions, in-flight calls and empty turns')
}

function theEpisodeCarriesExactlyTheRuledFieldSet() {
  const episode = extractEpisode(SESSION, richSnapshot(), 'assistant-2', AT)
  assert.ok(episode, 'the rich turn is capturable')

  assert.equal(episode.sessionId, SESSION)
  assert.equal(episode.turnId, 'assistant-2')
  assert.equal(episode.capturedAt, AT, 'the time is the capture clock passed in, not a turn timestamp')
  assert.equal(episode.ordinal, 2, 'the ordinal is the trail position plus one')
  assert.equal(episode.ask, 'please fix the parser', 'the ask is the nearest preceding question, collapsed')

  assert.equal(episode.tools.length, MAX_EPISODE_TOOLS, 'tools are capped')
  assert.equal(episode.tools[0].tool, 'tool_0')
  assert.equal(episode.tools[11].tool, 'tool_11', 'the twelfth listed pair is the twelfth step')
  assert.equal(episode.toolsMore, 2, 'the rest are counted, not named')

  assert.deepEqual(episode.outcome, {
    cause: 'truncated',
    midWork: true,
    unfinishedSteps: 2,
    continuations: 1,
    plan: { done: 1, total: 2 },
  })

  assert.ok(episode.combo, 'the served combo travels')
  assert.equal(episode.combo.name, 'Fast answers')
  assert.equal(episode.combo.providerId, 'deepseek')
  assert.equal(episode.combo.modelId, 'deepseek-chat')
  assert.equal(episode.combo.attempts.length, MAX_EPISODE_COMBO_ATTEMPTS, 'attempts are bounded')

  assert.deepEqual(
    Object.keys(episode).sort(),
    ['ask', 'capturedAt', 'combo', 'ordinal', 'outcome', 'sessionId', 'tools', 'toolsMore', 'turnId'],
    'the field set is the ruled one and no per-turn time was invented'
  )

  results.push('the episode carries the ruled field set and nothing invented')
}

function theAskIsBoundedAndSkipsASummary() {
  const long = snap([userTurn('user-1', '  a  '.repeat(300)), assistantTurn('assistant-2', 'done')])
  const bounded = extractEpisode(SESSION, long, 'assistant-2', AT)
  assert.ok(bounded)
  assert.equal(bounded.ask.length, MAX_EPISODE_ASK_CHARS, 'the ask is cut to 240 characters')

  const afterSummary = snap([
    userTurn('user-1', 'the real question'),
    { ...userTurn('summary-1', 'a summary that is not a question'), summarizesTurns: ['user-1'] },
    assistantTurn('assistant-2', 'done'),
  ])
  const episode = extractEpisode(SESSION, afterSummary, 'assistant-2', AT)
  assert.ok(episode)
  assert.equal(episode.ask, 'the real question', 'a summary is skipped when the ask is looked up')

  results.push('the ask is whitespace-collapsed, bounded to 240 characters and skips summaries')
}

function theExcludedFieldsNeverEnterTheBlock() {
  const episode = extractEpisode(SESSION, richSnapshot(), 'assistant-2', AT)
  assert.ok(episode)
  const block = renderEpisodeBlock(episode, '')

  for (const forbidden of [
    'SECRET TOOL OUTPUT',
    'SECRET ARGUMENT VALUE',
    'SECRET CODE',
    'SECRET ERROR TEXT',
    'FAILURE TAIL TEXT',
    'PLAN TITLE ONE',
    'PLAN TITLE TWO',
    'C:/secret/plan.md',
    'image-1',
    'shot.png',
  ]) {
    assert.ok(!block.includes(forbidden), `the block must not carry '${forbidden}'`)
  }

  assert.ok(block.startsWith('<!-- episode turn=assistant-2 at='), 'the marker leads the block')
  assert.ok(block.includes('ask: please fix the parser'), 'the question is what it does carry')

  results.push('tool outputs, arguments, codes, error text, failure tails, mention paths, images and plan titles')
}

// ---------------------------------------------------------------- bounds and sanitization

function theBlockIsBoundedByOneKilobyte() {
  const longTools = Array.from({ length: 20 }, (_, index) => toolStep(index, 'ok' as const)).map((step) => ({
    ...step,
    tool: 'a_very_long_tool_name_for_the_bound'.repeat(2),
  }))
  const episode = extractEpisode(
    SESSION,
    snap([userTurn('user-1', 'q'.repeat(4000)), assistantTurn('assistant-2', 'done', { steps: longTools })]),
    'assistant-2',
    AT
  )
  assert.ok(episode)
  const block = renderEpisodeBlock(episode, '')
  assert.ok(bytes(block) <= MAX_EPISODE_BYTES, `the block is ${bytes(block)} bytes, over the 1024 cap`)
  assert.ok(block.startsWith('<!-- episode turn=assistant-2 at='), 'the cut keeps the marker, which is the key')

  results.push('a block is sanitized first and then cut to the 1024-byte cap, marker and heading included')
}

function theSanitizerRedactsTheFourNewShapesOnEpisodes() {
  const dirty = [
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEsecretmaterial',
    '-----END RSA PRIVATE KEY-----',
    'GITHUB_TOKEN=ghp_abcdefghi',
    'bare sk-proj-abcdefghijklmnop',
    'Basic dXNlcjpwYXNz',
    'at https://user:pass@example.com',
    'glpat-abcdefghijkl',
  ].join(' ')
  const episode = extractEpisode(
    SESSION,
    snap([userTurn('user-1', dirty), assistantTurn('assistant-2', 'done')]),
    'assistant-2',
    AT
  )
  assert.ok(episode)
  const block = renderEpisodeBlock(episode, '')

  assert.ok(!block.includes('ghp_abcdefghi'), 'an env-named credential value is redacted')
  assert.ok(!block.includes('sk-proj-abcdefghijklmnop'), 'a modern token prefix is redacted')
  assert.ok(!block.includes('dXNlcjpwYXNz'), 'basic auth is redacted')
  assert.ok(!block.includes('user:pass@'), 'URL userinfo is redacted')
  assert.ok(!block.includes('MIIEsecretmaterial'), 'a PEM block is redacted whole')
  assert.ok(!block.includes('glpat-abcdefghijkl'), 'a GitLab token is redacted')
  assert.ok(/\[REDACTED/.test(block), 'the redactions are marked rather than silently dropped')

  results.push('the four added sanitizer rules hold on a rendered episode, not just on a pasted handoff')
}

// ---------------------------------------------------------------- the writer

async function theWriterKeepsOneBlockPerTurn() {
  const { appData, root, cleanup } = makeRoots()
  try {
    const first = extractEpisode(SESSION, richSnapshot(), 'assistant-2', AT)
    assert.ok(first)
    await appendEpisodePage(appData, root, first, '')

    const second = extractEpisode(SESSION, richSnapshot(), 'assistant-2', AT + 5_000)
    assert.ok(second)
    await appendEpisodePage(appData, root, second, '')

    const page = readFileSync(pagePath(appData, root, SESSION), 'utf8')
    assert.equal(markerCount(page), 1, 'a debounced re-save of one turn is one block')
    assert.ok(
      page.includes(`at=${new Date(AT + 5_000).toISOString()}`),
      'the replacement happens in place, with the newest capture time'
    )

    // A regenerated reply keeps the turn id and rewrites the block, which is what keeps one exchange
    // from pinning two blocks as the answer is written again.
    const regenerated = snap([
      userTurn('user-1', 'please fix the parser'),
      assistantTurn('assistant-2', 'A different answer.', { steps: [toolStep(0, 'ok')] }),
    ])
    const third = extractEpisode(SESSION, regenerated, 'assistant-2', AT + 9_000)
    assert.ok(third)
    await appendEpisodePage(appData, root, third, '')

    const after = readFileSync(pagePath(appData, root, SESSION), 'utf8')
    assert.equal(markerCount(after), 1, 'a regenerated reply still converges to one block')
    assert.ok(after.includes('continuations=0'), 'the block is the regenerated turn, not the old one')
    assert.ok(!after.includes('cause=truncated'), 'the old ending is gone with the block it described')

    results.push('a page keeps one block per turn, replaced in place, and a regenerated reply converges to it')
  } finally {
    cleanup()
  }
}

async function theWriterRotatesThePageAtFortyBlocks() {
  const { appData, root, cleanup } = makeRoots()
  try {
    for (let index = 0; index <= MAX_EPISODES_PER_PAGE; index++) {
      const episode = extractEpisode(
        SESSION,
        snap([userTurn('user-1', `question ${index}`), assistantTurn(`assistant-${index}`, 'done')]),
        `assistant-${index}`,
        AT + index * 1_000
      )
      assert.ok(episode)
      await appendEpisodePage(appData, root, episode, '')
    }

    const page = readFileSync(pagePath(appData, root, SESSION), 'utf8')
    assert.equal(markerCount(page), MAX_EPISODES_PER_PAGE, 'the page holds exactly forty blocks')
    assert.ok(page.includes(`turn=assistant-${MAX_EPISODES_PER_PAGE} at=`), 'the newest block is kept')
    assert.ok(!page.includes('turn=assistant-0 at='), 'the oldest whole block is dropped, not truncated')
    assert.ok(
      page.indexOf(`turn=assistant-${MAX_EPISODES_PER_PAGE} at=`) < page.indexOf('turn=assistant-39 at='),
      'the page runs newest first'
    )

    // The byte cap is the second bound, reachable only by a hand-edited page: forty oversized blocks
    // are dropped from the tail until the file fits, and the newest block still lands.
    const huge = 'x'.repeat(4_000)
    const seeded = Array.from(
      { length: MAX_EPISODES_PER_PAGE },
      (_, index) =>
        `<!-- episode turn=huge-${index} at=${new Date(AT - index * 1_000).toISOString()} -->\n## Episode ${index + 1}\n- ask: ${huge}`
    ).join('\n\n')
    writeFileSync(pagePath(appData, root, SESSION), `# Episodes\n\n${seeded}\n`, 'utf8')

    const fresh = extractEpisode(
      SESSION,
      snap([userTurn('user-1', 'the newest question'), assistantTurn('assistant-new', 'done')]),
      'assistant-new',
      AT + 100_000
    )
    assert.ok(fresh)
    await appendEpisodePage(appData, root, fresh, '')

    const capped = readFileSync(pagePath(appData, root, SESSION), 'utf8')
    assert.ok(bytes(capped) <= MAX_EPISODE_PAGE_BYTES, 'the page fits its 128 KB cap')
    assert.ok(capped.includes('turn=assistant-new at='), 'the newest work survives the trim')

    results.push('the page rotates at forty blocks newest first and trims to its byte cap by whole blocks')
  } finally {
    cleanup()
  }
}

async function anEpisodeWriteInvalidatesTheIndexSkip() {
  const { appData, root, cleanup } = makeRoots()
  try {
    await writeMemoryPage(appData, root, 'handoff', 'first handoff')
    assert.equal((await ensureMemoryIndex(appData, root)).rebuilt, false, 'a settled tree skips')

    const episode = extractEpisode(SESSION, richSnapshot(), 'assistant-2', AT)
    assert.ok(episode)
    await appendEpisodePage(appData, root, episode, '')

    assert.equal((await ensureMemoryIndex(appData, root)).rebuilt, true, 'the episode moved the tree')
    assert.equal((await ensureMemoryIndex(appData, root)).rebuilt, false, 'and the skip holds again')
    assert.ok(existsSync(join(memoryRoot(appData, root), 'index.json')), 'the index persisted')

    results.push('an episode write moves the tree mtime, so the next ensure rebuilds once and then skips')
  } finally {
    cleanup()
  }
}

async function theRowsAndRetentionFollowThePage() {
  const { appData, root, cleanup } = makeRoots()
  try {
    for (const index of [0, 1]) {
      const episode = extractEpisode(
        SESSION,
        snap([userTurn('user-1', `question ${index}`), assistantTurn(`assistant-${index}`, 'done')]),
        `assistant-${index}`,
        AT + index * 1_000
      )
      assert.ok(episode)
      await appendEpisodePage(appData, root, episode, '')
    }

    const rows = await listMemoryEpisodes(appData, root)
    assert.equal(rows.length, 2, 'both episodes are rows')
    assert.equal(rows[0].turnId, 'assistant-1', 'the rows are newest first')
    assert.equal(rows[0].ask, 'question 1')
    assert.equal(rows[0].sessionId, SESSION)

    // The row rule is the one ordering rule, shared with the brief.
    const parsed = parseEpisodeBlocks(readFileSync(pagePath(appData, root, SESSION), 'utf8'), SESSION)
    assert.equal(parsed.length, 2)
    assert.deepEqual(episodeRowFromBlock(parsed[0]).turnId, 'assistant-1')

    results.push('the panel rows are parsed from the page, newest first, with the question they carried')
  } finally {
    cleanup()
  }
}

/**
 * A from-here delete prunes the blocks its range captured, and renumbers nothing.
 *
 * The page is newest first and each block carries the ordinal it was captured with. Removing a block
 * leaves the others exactly where they were, ordinal included: renumbering them would make the page
 * claim those turns happened at positions they never held.
 */
async function aDeletedRangePrunesItsBlocksAndKeepsOrdinals() {
  const { appData, root, cleanup } = makeRoots()
  try {
    const conversation = snap([
      userTurn('user-1', 'first question'),
      assistantTurn('assistant-2', 'first answer'),
      userTurn('user-3', 'second question'),
      assistantTurn('assistant-4', 'second answer'),
      userTurn('user-5', 'third question'),
      assistantTurn('assistant-6', 'third answer'),
    ])
    for (const [index, turnId] of ['assistant-2', 'assistant-4', 'assistant-6'].entries()) {
      const episode = extractEpisode(SESSION, conversation, turnId, AT + index * 1_000)
      assert.ok(episode)
      await appendEpisodePage(appData, root, episode, '')
    }

    const before = readFileSync(pagePath(appData, root, SESSION), 'utf8')
    assert.equal(markerCount(before), 3, 'three captured answers are three blocks')
    assert.ok(before.includes('## Episode 2'), 'the first answer was captured at position two')
    assert.ok(before.includes('## Episode 4'))
    assert.ok(before.includes('## Episode 6'))

    // A from-here delete at assistant-4 removes it and every turn after it.
    const removed = await deleteEpisodeBlocksForTurns(appData, root, SESSION, ['assistant-4', 'assistant-6'])
    assert.equal(removed, 2, 'both removed turns had a block on the page')

    const after = readFileSync(pagePath(appData, root, SESSION), 'utf8')
    assert.equal(markerCount(after), 1, 'the removed turns’ blocks are gone')
    assert.ok(after.includes('turn=assistant-2'), 'the surviving block is kept')
    assert.ok(after.includes('## Episode 2'), 'with the ordinal it was captured with, not a renumbered one')
    assert.ok(!after.includes('turn=assistant-4'), 'and the deleted turn is not on the page')
    assert.ok(!after.includes('turn=assistant-6'))

    // Idempotent: a second prune for the same ids has nothing to remove.
    assert.equal(await deleteEpisodeBlocksForTurns(appData, root, SESSION, ['assistant-4']), 0)
    assert.equal(markerCount(readFileSync(pagePath(appData, root, SESSION), 'utf8')), 1)

    results.push('a delete prunes the removed turns’ blocks and leaves the survivors’ ordinals untouched')
  } finally {
    cleanup()
  }
}

/**
 * A delete-save is not a turn-end save: it captures nothing, and prunes the blocks it removed.
 *
 * Capture is defined as a note about the answer a turn just produced. A delete would make the previous
 * answer the newest turn, and capturing then would mint an episode for an old exchange — so the save
 * that carries removed turn ids prunes instead of capturing, and the surviving block keeps the clock
 * it was already written with.
 */
async function aDeleteSaveSuppressesCaptureAndPrunesThePage() {
  const userData = process.env.SAM_TEST_USER_DATA
  if (!userData) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  const root = join(userData, 'workspace')
  mkdirSync(root, { recursive: true })
  const page = pagePath(userData, root, SESSION)
  const record = sessionsModule.record.saveTranscript as unknown as {
    resolver: (opts: { input: unknown }) => Promise<void>
  }

  setEpisodesEnabledSource(() => true)
  setSessionRootSource(() => root)
  try {
    const first = snap([userTurn('user-1', 'fix the parser'), assistantTurn('assistant-2', 'Fixed it.')])
    const full = snap([
      userTurn('user-1', 'fix the parser'),
      assistantTurn('assistant-2', 'Fixed it.'),
      userTurn('user-3', 'and the docs'),
      assistantTurn('assistant-4', 'Updated them.'),
    ])

    await record.resolver({ input: { id: SESSION, snapshot: first } })
    await record.resolver({ input: { id: SESSION, snapshot: full } })
    for (let attempt = 0; attempt < 200 && markerCount(readPage(page)) < 2; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const before = readPage(page)
    assert.equal(markerCount(before), 2, 'the two ordinary saves captured the two answers')
    const keptAt = capturedAtOf(before, 'assistant-2')
    assert.ok(keptAt, 'the surviving answer has a capture clock')

    // The same conversation after a from-here delete at user-3: the delete writes the surviving prefix
    // and says which turns it removed.
    await record.resolver({
      input: { id: SESSION, snapshot: first, deletedTurnIds: ['user-3', 'assistant-4'] },
    })
    for (let attempt = 0; attempt < 200 && readPage(page).includes('turn=assistant-4'); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const after = readPage(page)
    assert.equal(markerCount(after), 1, 'a delete-save captures nothing of its own')
    assert.ok(after.includes('turn=assistant-2'), 'the surviving block is still there')
    assert.equal(capturedAtOf(after, 'assistant-2'), keptAt, 'and its capture clock was not rewritten by a capture')
    assert.ok(!after.includes('turn=assistant-4'), 'the removed turn’s block was pruned after the write')

    results.push('a delete-save prunes the removed range and mints no episode for the previous answer')
  } finally {
    setEpisodesEnabledSource(null)
    setSessionRootSource(null)
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- the brief

/** One block built by the real extractor and renderer, so the brief is fed the bytes it will store. */
function blockFor(sessionId: string, ask: string, capturedAt: number, turnId = 'assistant-2'): EpisodeBlock {
  const episode = extractEpisode(
    sessionId,
    snap([userTurn('user-1', ask), assistantTurn(turnId, 'done')]),
    turnId,
    capturedAt
  )
  assert.ok(episode)
  const block = parseEpisodeBlocks(renderEpisodeBlock(episode, ''), sessionId)[0]
  assert.ok(block)
  return block
}

function aHeavyBlock(capturedAt: number, ask: string): EpisodeBlock {
  // Long enough that only two of these blocks fit the sub-budget, and short enough that each one
  // still fits inside the per-block cap.
  const steps = Array.from({ length: 12 }, (_, index) => ({
    ...toolStep(index),
    tool: `tool_${'x'.repeat(56)}`,
  }))
  const episode = extractEpisode(
    SESSION,
    snap([userTurn('user-1', ask), assistantTurn('assistant-2', 'done', { steps })]),
    'assistant-2',
    capturedAt
  )
  assert.ok(episode)
  return parseEpisodeBlocks(renderEpisodeBlock(episode, ''), SESSION)[0]
}

function theBriefAppendsEpisodesLastNewestFirst() {
  const section = assembleMemorySection({
    handoff: 'H',
    vetoes: 'V',
    decisions: 'D',
    quirks: 'Q',
    episodes: [
      blockFor(SESSION, 'oldest work', 1_000),
      blockFor(OTHER, 'newest work', 3_000),
      blockFor(SESSION, 'middle work', 2_000),
    ],
  })
  assert.ok(section)
  const text = section.content

  assert.ok(text.indexOf('Quirks') < text.indexOf('## Episodes'), 'the episodes section is last')
  assert.ok(text.indexOf('newest work') < text.indexOf('middle work'), 'newest capture first')
  assert.ok(text.indexOf('middle work') < text.indexOf('oldest work'))
  assert.equal(markerCount(text), 3)
  assert.equal(EPISODES_IN_BRIEF, 5)
  assert.equal(MAX_EPISODES_BRIEF_BYTES, 2048)

  results.push('the brief appends episodes last, newest first, after every canonical section')
}

function theBriefCarriesFiveEpisodesAtMost() {
  const blocks = Array.from({ length: 8 }, (_, index) => blockFor(SESSION, `episode ${index}`, 10_000 + index))
  const section = assembleMemorySection({ handoff: 'H', vetoes: '', decisions: '', quirks: '', episodes: blocks })
  assert.ok(section)
  assert.equal(markerCount(section.content), EPISODES_IN_BRIEF, 'five blocks, not eight')
  assert.ok(section.content.includes('episode 7'), 'the newest five, starting at the newest')
  assert.ok(!section.content.includes('episode 2'), 'the oldest are the ones left out')

  results.push('the brief carries the newest five episode blocks and no more')
}

function theBriefDropsWholeBlocksAndCannotBeEvictedByANovel() {
  const heavy = [
    aHeavyBlock(3_000, 'the newest heavy block'),
    aHeavyBlock(2_000, 'the middle heavy block'),
    aHeavyBlock(1_000, 'the oldest heavy block'),
  ]
  const section = assembleMemorySection({ handoff: 'H', vetoes: '', decisions: '', quirks: '', episodes: heavy })
  assert.ok(section)
  assert.ok(bytes(section.content) <= MAX_MEMORY_BRIEF_BYTES)
  assert.equal(markerCount(section.content), 2, 'only the blocks that fit are taken')
  assert.ok(section.content.includes('the newest heavy block'))
  assert.ok(!section.content.includes('the oldest heavy block'), 'the oldest is dropped whole, never cut in half')

  // A novel-sized handoff is cut to 6144 first, so the episodes sub-budget is never spent on history.
  const novel = assembleMemorySection({
    handoff: 'h'.repeat(20_000),
    vetoes: '',
    decisions: '',
    quirks: '',
    episodes: [blockFor(SESSION, 'the work that must survive', 5_000)],
  })
  assert.ok(novel)
  assert.ok(novel.content.includes('the work that must survive'), 'the newest work is not evicted')
  assert.ok(bytes(novel.content) <= MAX_MEMORY_BRIEF_BYTES, 'and the whole brief still fits its budget')
  assert.ok(novel.content.indexOf('## Episodes') <= 6_146, 'the canonical body was cut to 6144 first')

  results.push('the brief spends its 2048-byte episode sub-budget on whole blocks and cuts the canonical body first')
}

// ---------------------------------------------------------------- the guarantee

function latestTurnIsTheAssistantOne() {
  assert.equal(latestEpisodeTurnId(snap([userTurn('user-1', 'q')])), null, 'no answer, nothing to capture')
  assert.equal(
    latestEpisodeTurnId(snap([userTurn('user-1', 'q'), assistantTurn('assistant-2', 'a')])),
    'assistant-2',
    'the completed answer is the turn a turn-end save captures'
  )
  results.push('the capture target is the last assistant turn on the checked-out trail')
}

async function aFailedCaptureNeverThrows() {
  // The capture path resolves its own app-data directory through electron's `app.getPath`, so this
  // step uses the stub's private directory rather than a second root of its own — otherwise the page
  // would land somewhere the assertion never looks.
  const appData = process.env.SAM_TEST_USER_DATA
  if (!appData) throw new Error('SAM_TEST_USER_DATA must be set for this test')
  const root = join(appData, 'workspace')
  mkdirSync(root, { recursive: true })
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    setEpisodesEnabledSource(() => true)
    setSessionRootSource(() => {
      throw new Error('the store is not readable')
    })
    await captureEpisode(SESSION, richSnapshot())
    assert.equal(warnings.length, 1, 'one bounded warning, not a throw and not a flood')
    assert.match(warnings[0], /EPISODE_CAPTURE_FAILED/)

    // A ConveyorError keeps its own code in the warning, which is what "logged by code" means here.
    setSessionRootSource(() => root)
    await captureEpisode('../escape', richSnapshot())
    assert.equal(warnings.length, 2)
    assert.match(warnings[1], /MEMORY_IO_ERROR/)

    // Consent off is not a failure: nothing is written and nothing is said.
    setEpisodesEnabledSource(() => false)
    await captureEpisode(SESSION, richSnapshot())
    assert.equal(warnings.length, 2, 'a disabled capture is silent')
    assert.ok(!existsSync(pagePath(appData, root, SESSION)), 'and writes nothing')

    // Consent on is the ordinary path: the page lands.
    setEpisodesEnabledSource(() => true)
    setSessionRootSource(() => root)
    await captureEpisode(SESSION, richSnapshot())
    assert.ok(existsSync(pagePath(appData, root, SESSION)), 'an enabled capture writes its page')

    results.push('a failed capture resolves quietly with one coded warning, and consent off writes nothing')
  } finally {
    console.warn = original
    setEpisodesEnabledSource(null)
    setSessionRootSource(null)
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- report

async function main() {
  const steps: Array<[string, () => void | Promise<void>]> = [
    ['extraction gate', theExtractionGateRefusesWhatCannotBeAnEpisode],
    ['field set', theEpisodeCarriesExactlyTheRuledFieldSet],
    ['ask', theAskIsBoundedAndSkipsASummary],
    ['exclusions', theExcludedFieldsNeverEnterTheBlock],
    ['byte bound', theBlockIsBoundedByOneKilobyte],
    ['sanitizer on episodes', theSanitizerRedactsTheFourNewShapesOnEpisodes],
    ['writer idempotence', theWriterKeepsOneBlockPerTurn],
    ['writer rotation', theWriterRotatesThePageAtFortyBlocks],
    ['mtime invalidation', anEpisodeWriteInvalidatesTheIndexSkip],
    ['rows and retention', theRowsAndRetentionFollowThePage],
    ['delete pruning', aDeletedRangePrunesItsBlocksAndKeepsOrdinals],
    ['delete-save capture', aDeleteSaveSuppressesCaptureAndPrunesThePage],
    ['brief order', theBriefAppendsEpisodesLastNewestFirst],
    ['brief five-block budget', theBriefCarriesFiveEpisodesAtMost],
    ['brief whole-block truncation', theBriefDropsWholeBlocksAndCannotBeEvictedByANovel],
    ['capture target', latestTurnIsTheAssistantOne],
    ['failed capture', aFailedCaptureNeverThrows],
  ]
  for (const [label, fn] of steps) {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }
  console.log(`episodes: ${results.length} passed`)
  for (const line of results) console.log(`  pass: ${line}`)
}

main().catch((err) => {
  console.error('EPISODES TEST FAILED:', err)
  process.exit(1)
})
