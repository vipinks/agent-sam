/**
 * Verifies the memory v1 slice 1 rules: the pure tokenizer and inverted index, the sanitizer, the
 * import fan-out and its conflict path, write-supersede and restore, the index rebuild's mtime skip,
 * and the zero-LLM boundary (neither memory module may import an agent, engine or llm module).
 *
 * The filesystem half runs against a temp app-data directory passed in explicitly, so no suite ever
 * touches the real `%APPDATA%` — the same property the electron stub's temp user-data gives the
 * sessions suites, and the reason every helper here takes `appDataPath` rather than reading one.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assembleMemorySection,
  buildIndex,
  fanOutImport,
  planMemoryInjection,
  sanitize,
  searchPages,
  splitDecisions,
  tokenize,
  type MemoryPageId,
} from '../../conveyor/protocol/memory'
import {
  ensureMemoryIndex,
  importMemoryHandoff,
  memoryRoot,
  projectKeyFor,
  readMemoryPage,
  restoreMemoryPage,
  writeMemoryPage,
} from '../../conveyor/modules/memory'

const results: string[] = []

/** A fresh temp app-data root and a workspace path inside it, cleaned up by the caller. */
function makeRoots() {
  const appData = mkdtempSync(join(tmpdir(), 'sam-memory-'))
  const root = join(appData, 'workspace')
  mkdirSync(root, { recursive: true })
  return { appData, root, cleanup: () => rmSync(appData, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- the pure rules

function theTokenizerSplitsIntoLowerCaseWords() {
  assert.deepEqual(tokenize('The Parser drops — trailing!'), ['the', 'parser', 'drops', 'trailing'])
  assert.deepEqual(tokenize('  A,B.c  '), ['a', 'b', 'c'])
  results.push('the tokenizer lowercases and splits on non-word boundaries')
}

function theIndexMapsTokensToPagesAndPositions() {
  const index = buildIndex({ handoff: 'alpha beta', decisions: 'beta gamma', parked: '', quirks: '' })
  const beta = index['beta']
  assert.ok(beta, 'the shared token is present')
  assert.deepEqual(
    beta
      .map((entry) => [entry.page, entry.positions] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['decisions', [0]],
      ['handoff', [1]],
    ],
    'each occurrence records its page and its token position'
  )
  results.push('the index maps each token to the page and position of every occurrence')
}

function theSearchReturnsPageIdsAndSnippets() {
  const pages: Record<MemoryPageId, string> = {
    handoff: 'the parser needs a trim before it splits',
    decisions: 'nothing about parsers here',
    parked: 'idle note',
    quirks: 'the parser again on a quirk',
  }
  const found = searchPages(pages, 'parser')
  assert.deepEqual(
    found.map((r) => r.page).sort(),
    ['handoff', 'quirks'],
    'only pages containing the term are returned'
  )
  const handoff = found.find((r) => r.page === 'handoff')
  assert.equal(handoff?.matchCount, 1, 'the count covers the occurrence in that page')
  assert.ok(handoff?.snippets.every((s) => s.toLowerCase().includes('parser')), 'every snippet contains the term')
  assert.ok((handoff?.snippets.length ?? 0) <= 3, 'snippets are bounded')
  results.push('search returns page ids with bounded snippets containing the term')
}

function theSanitizerRedactsSecretsAndHomePaths() {
  const home = join('C:', 'Users', 'dell')
  const dirty = [
    'Bearer abcdefghijkLMNOP123456',
    'key sk-abcdefghijklmnopqrstuvwxyz1234567890',
    'api_key=supersecret123',
    `the log is at ${join(home, 'projects', 'secret', 'log.txt')}`,
  ].join('\n')
  const clean = sanitize(dirty, home)
  assert.ok(!/abcdefghijkLMNOP123456/.test(clean), 'the bearer credential is gone')
  assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz1234567890/.test(clean), 'the API key is gone')
  assert.ok(!/supersecret123/.test(clean), 'the assigned credential is gone')
  assert.ok(!/projects[\\/]secret/.test(clean), 'the path under the home directory is gone')
  assert.ok(/\[REDACTED/.test(clean), 'the redactions are marked rather than silently dropped')
  results.push('the sanitizer redacts keys, bearer tokens, credential assignments and home paths')
}

function theFanOutMapsHeadingsToPages() {
  const markdown = [
    'Preamble that is not under a heading.',
    '# Handoff',
    'ship the small release',
    '# Decisions',
    'we chose the smallest release',
    '# Unknown heading',
    'this is dropped',
  ].join('\n')
  const fanned = fanOutImport(markdown)
  assert.equal(fanned.handoff, 'Preamble that is not under a heading.\n\nship the small release')
  assert.equal(fanned.decisions, 'we chose the smallest release')
  assert.equal(fanned.parked, undefined, 'an absent section is not invented')
  assert.equal(fanned.quirks, undefined, 'an unknown heading is dropped rather than written anywhere')
  results.push('the fan-out maps each heading to its page and drops unrecognised ones')
}

function theDecisionsSplitSeparatesVetoes() {
  assert.deepEqual(splitDecisions('decided A\n\n## Vetoes\n\nveto B'), {
    vetoes: 'veto B',
    decisions: 'decided A',
  })
  assert.deepEqual(splitDecisions('just decisions'), { vetoes: '', decisions: 'just decisions' })
  results.push('the decisions split separates vetoes from decisions on the vetoes heading')
}

function theBriefAssemblesInTheDocumentedOrder() {
  const section = assembleMemorySection({ handoff: 'H', vetoes: 'V', decisions: 'D', quirks: 'Q' })
  assert.ok(section, 'a project with any memory produces a section')
  const text = section?.content ?? ''
  const h = text.indexOf('Handoff')
  const v = text.indexOf('Pending vetoes')
  const d = text.indexOf('Recent decisions')
  const q = text.indexOf('Quirks')
  assert.ok(h >= 0 && v > h && d > v && q > d, 'the sections run handoff, vetoes, decisions, quirks')
  assert.equal(
    assembleMemorySection({ handoff: '', vetoes: '', decisions: '', quirks: '  ' }),
    null,
    'all blank means no section'
  )
  results.push('the brief assembles handoff, pending vetoes, recent decisions and quirks in order')
}

function theInjectionPlansNullInNullOut() {
  assert.equal(planMemoryInjection([], null), null, 'no brief means no injection')
  assert.deepEqual(
    planMemoryInjection([{ role: 'user', content: 'hi' }], 'memory section'),
    { content: 'memory section' },
    'a fresh history gets the section'
  )
  assert.equal(
    planMemoryInjection([{ role: 'system', content: 'memory section' }], 'memory section'),
    null,
    'an already-present section is refused, which is the resumed case'
  )
  results.push('the memory injection is null-in null-out and refuses a resumed copy')
}

// ---------------------------------------------------------------- the filesystem half

async function theIndexRebuildsOnlyWhenTheTreeMoved() {
  const { appData, root, cleanup } = makeRoots()
  try {
    // Pages are written directly rather than through writeMemoryPage, which rebuilds as part of the
    // mutation — the mtime skip is ensureMemoryIndex's own claim, tested against the disk only.
    const mem = memoryRoot(appData, root)
    mkdirSync(mem, { recursive: true })
    writeFileSync(join(mem, 'handoff.md'), 'first handoff', 'utf8')

    const first = await ensureMemoryIndex(appData, root)
    assert.equal(first.rebuilt, true, 'a tree with no recorded mtime rebuilds')

    const second = await ensureMemoryIndex(appData, root)
    assert.equal(second.rebuilt, false, 'an unchanged tree skips the rebuild')

    writeFileSync(join(mem, 'decisions.md'), 'a decision', 'utf8')
    const third = await ensureMemoryIndex(appData, root)
    assert.equal(third.rebuilt, true, 'a new page changes the tree and rebuilds')

    results.push('the index rebuilds once and skips while the tree mtime is unchanged')
  } finally {
    cleanup()
  }
}

async function writePageSupersedesAndRetainsThePrior() {
  const { appData, root, cleanup } = makeRoots()
  try {
    const created = await writeMemoryPage(appData, root, 'handoff', 'v1')
    assert.deepEqual(created, { page: 'handoff', exists: true, revisions: 0 }, 'creation has no prior revision')

    const superseded = await writeMemoryPage(appData, root, 'handoff', 'v2')
    assert.deepEqual(superseded, { page: 'handoff', exists: true, revisions: 1 }, 'the prior revision is retained')

    const read = await readMemoryPage(appData, root, 'handoff')
    assert.equal(read?.content, 'v2', 'the page holds the new content')
    assert.equal(read?.revisions, 1, 'with one retained prior')

    results.push('writing an existing page supersedes it and retains the prior revision')
  } finally {
    cleanup()
  }
}

async function restoreRevertsToThePriorRevision() {
  const { appData, root, cleanup } = makeRoots()
  try {
    await writeMemoryPage(appData, root, 'handoff', 'v1')
    await writeMemoryPage(appData, root, 'handoff', 'v2')

    const restored = await restoreMemoryPage(appData, root, 'handoff')
    assert.equal(restored.content, 'v1', 'restore reverts to the prior revision')
    assert.equal(restored.revisions, 0, 'and consumes it')

    const read = await readMemoryPage(appData, root, 'handoff')
    assert.equal(read?.content, 'v1', 'the reverted content is on disk')

    results.push('restore reverts to the prior revision and consumes it')
  } finally {
    cleanup()
  }
}

async function theImportFansOutAndRefusesToSilentlyOverwrite() {
  const { appData, root, cleanup } = makeRoots()
  try {
    const home = join(appData, 'home')
    mkdirSync(home, { recursive: true })

    const after = await importMemoryHandoff(
      appData,
      root,
      '# Handoff\nship the small release\n# Decisions\nchose the smallest',
      home
    )
    assert.ok(after.find((p) => p.page === 'handoff')?.exists, 'handoff is created')
    assert.ok(after.find((p) => p.page === 'decisions')?.exists, 'decisions is created')

    let conflict: unknown
    try {
      await importMemoryHandoff(appData, root, '# Handoff\nreplace it', home)
    } catch (err) {
      conflict = err
    }
    assert.ok(
      conflict && (conflict as { code?: string }).code === 'MEMORY_CONFLICT',
      'a second import of an existing section conflicts'
    )

    const forced = await importMemoryHandoff(appData, root, '# Handoff\nreplace it', home, true)
    assert.equal(
      forced.find((p) => p.page === 'handoff')?.revisions,
      1,
      'the forced import supersedes and retains the prior'
    )

    results.push('the import fans out, refuses to overwrite silently, and supersedes under force')
  } finally {
    cleanup()
  }
}

function theProjectKeyIsAHashedNormalizedRoot() {
  const key = projectKeyFor('C:\\w')
  assert.match(key, /^[0-9a-f]{64}$/, 'the key is a sha256 hex digest, never a raw path segment')
  assert.equal(key, projectKeyFor('C:\\w'), 'the same root hashes to the same key')
  assert.equal(
    memoryRoot('C:\\appdata', 'C:\\w'),
    join('C:\\appdata', 'era', 'memory', key),
    'the layout is %APPDATA%\\era\\memory\\<key>'
  )
  results.push('the project key is a hashed normalized root and the layout is app-data-scoped')
}

function theMemoryModulesImportNoAgentEngineOrLlm() {
  const sources = [
    ['conveyor/modules/memory.ts', readFileSync(join(process.cwd(), 'conveyor', 'modules', 'memory.ts'), 'utf8')],
    ['conveyor/protocol/memory.ts', readFileSync(join(process.cwd(), 'conveyor', 'protocol', 'memory.ts'), 'utf8')],
  ] as const
  for (const [name, src] of sources) {
    const specifiers = [...src.matchAll(/(?:from\s+|import\s*\(|require\s*\(|import\s+)['"]([^'"]+)['"]/g)].map(
      (m) => m[1]
    )
    for (const spec of specifiers) {
      assert.ok(
        !/(agent|engine|llm)/.test(spec),
        `${name} imports '${spec}', which crosses the zero-LLM boundary`
      )
    }
  }
  results.push('neither memory module imports an agent, engine or llm module')
}

// ---------------------------------------------------------------- report

async function main() {
  const steps: Array<[string, () => void | Promise<void>]> = [
    ['tokenizer', theTokenizerSplitsIntoLowerCaseWords],
    ['index', theIndexMapsTokensToPagesAndPositions],
    ['search', theSearchReturnsPageIdsAndSnippets],
    ['sanitizer', theSanitizerRedactsSecretsAndHomePaths],
    ['fan-out', theFanOutMapsHeadingsToPages],
    ['decisions split', theDecisionsSplitSeparatesVetoes],
    ['brief order', theBriefAssemblesInTheDocumentedOrder],
    ['injection', theInjectionPlansNullInNullOut],
    ['index mtime skip', theIndexRebuildsOnlyWhenTheTreeMoved],
    ['write supersede', writePageSupersedesAndRetainsThePrior],
    ['restore', restoreRevertsToThePriorRevision],
    ['import fan-out and conflict', theImportFansOutAndRefusesToSilentlyOverwrite],
    ['project key', theProjectKeyIsAHashedNormalizedRoot],
    ['zero-LLM boundary', theMemoryModulesImportNoAgentEngineOrLlm],
  ]
  for (const [label, fn] of steps) {
    process.stdout.write(`... ${label}\n`)
    await fn()
  }
  console.log(`memory v1: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

main().catch((err) => {
  console.error('MEMORY TEST FAILED:', err)
  process.exit(1)
})
