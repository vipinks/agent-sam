/**
 * Verifies the two disk-facing halves of mentions: the flat walk, and the read behind one mention.
 *
 * The walk is asserted against a real seeded tree rather than a mock, because the properties that
 * matter are the ones a mock would have to be told about: that a `node_modules` subtree is never
 * opened, that the cap stops the walk rather than truncating its result, and that the order is stable.
 *
 * The 2001-file case is the important one. A walk that collected everything and sliced afterwards
 * would return the same array, so the assertion is not on the length alone — it is that the walk
 * stops, which is what the elapsed-work check below pins by seeding the over-cap file last and
 * asserting it is absent while the cap is exactly full.
 *
 * No electron: these take a root path, so this writes into a temp directory and walks it back.
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorkspaceFiles, mentionsModule, readMention, readMentions } from '../../conveyor/modules/mentions'
import { MAX_FILE_BYTES } from '../../conveyor/modules/workspace'
import { MAX_MENTION_ENTRIES } from '../../conveyor/protocol/mentions'

const results: string[] = []

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  process.stdout.write(`... ${label}\n`)
  await fn()
}

const roots: string[] = []

function makeRoot(prefix = 'sam-mentions-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

// ---------------------------------------------------------------- the walk

async function theWalkFindsNestedFilesAsRelativePaths() {
  const root = makeRoot()
  mkdirSync(join(root, 'src', 'deep', 'deeper'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# readme', 'utf8')
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1', 'utf8')
  writeFileSync(join(root, 'src', 'deep', 'deeper', 'leaf.ts'), 'export const leaf = 1', 'utf8')

  const files = await listWorkspaceFiles(root)

  assert.ok(files.includes('README.md'), 'a root-level file is listed')
  assert.ok(files.includes('src/app.ts'), 'a nested file is listed')
  assert.ok(
    files.includes('src/deep/deeper/leaf.ts'),
    'a deeply nested file is listed, with a forward-slash relative path'
  )

  // Relative, never absolute: a mention path crosses to the renderer and into a transcript, and an
  // absolute path would be machine-specific in both.
  assert.ok(
    files.every((f) => !f.startsWith(root) && !f.includes('\\')),
    `every path must be relative and forward-slashed, got ${JSON.stringify(files)}`
  )
  // Directories are not files, and are not listed as such.
  assert.ok(!files.includes('src'), 'a directory is not returned as a file')
  assert.ok(!files.includes('src/deep'), 'at any depth')
  results.push('the walk returns nested files as relative, forward-slashed paths and no directories')
}

async function aSkippedSubtreeIsNeverOffered() {
  const root = makeRoot()
  mkdirSync(join(root, 'node_modules', 'react'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, '.git', 'objects'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  mkdirSync(join(root, 'out'), { recursive: true })
  mkdirSync(join(root, 'vendor', 'lib'), { recursive: true })

  writeFileSync(join(root, 'node_modules', 'react', 'index.js'), 'module.exports = {}', 'utf8')
  writeFileSync(join(root, '.git', 'config'), '[core]', 'utf8')
  writeFileSync(join(root, 'dist', 'bundle.js'), '(()=>{})()', 'utf8')
  writeFileSync(join(root, 'out', 'main.js'), '// built', 'utf8')
  writeFileSync(join(root, 'vendor', 'lib', 'dep.js'), '// vendored', 'utf8')
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1', 'utf8')

  const files = await listWorkspaceFiles(root)

  assert.ok(files.includes('src/app.ts'), 'the ordinary source file is listed')
  for (const skipped of ['node_modules', '.git', 'dist', 'out', 'vendor']) {
    assert.ok(
      !files.some((f) => f === skipped || f.startsWith(`${skipped}/`)),
      `nothing under ${skipped} may appear, got ${JSON.stringify(files)}`
    )
  }

  // And a nested occurrence is skipped too: this is the segment rule, not a check on the first level.
  mkdirSync(join(root, 'src', 'vendor'), { recursive: true })
  writeFileSync(join(root, 'src', 'vendor', 'inner.js'), '// nested', 'utf8')
  const again = await listWorkspaceFiles(root)
  assert.ok(!again.includes('src/vendor/inner.js'), 'a skipped segment nested deeper is also excluded')
  results.push('the five skipped trees are absent from the walk at every depth')
}

async function theCapStopsTheWalkAtTwoThousand() {
  const root = makeRoot()
  mkdirSync(join(root, 'many'), { recursive: true })

  // 2000 real files, then one more — the 2001st. Named so it sorts last, which is what makes its
  // absence evidence that the walk stopped rather than evidence about ordering.
  for (let i = 0; i < MAX_MENTION_ENTRIES; i += 1) {
    writeFileSync(join(root, 'many', `f${String(i).padStart(4, '0')}.ts`), `// ${i}`, 'utf8')
  }
  writeFileSync(join(root, 'many', 'zzzz-the-2001st.ts'), '// over the cap', 'utf8')

  // Which entries the walk actually inspected — the half a result-length assertion cannot see. A walk
  // that collected all 2001 and sliced at the end returns the same array, so "the cap applied during
  // the walk" shows up in the work done rather than in what came back.
  const fsPromises = createRequire(__filename)('fs/promises') as { stat: (...args: unknown[]) => Promise<unknown> }
  const originalStat = fsPromises.stat
  const inspected: string[] = []
  fsPromises.stat = async (path: unknown, ...rest: unknown[]) => {
    inspected.push(String(path))
    return originalStat(path, ...rest)
  }

  let files: string[]
  try {
    files = await listWorkspaceFiles(root)
  } finally {
    fsPromises.stat = originalStat
  }

  assert.equal(files.length, MAX_MENTION_ENTRIES, `the walk returns exactly the cap, got ${files.length}`)
  assert.ok(!files.includes('many/zzzz-the-2001st.ts'), 'the file past the cap is not in the result')
  assert.ok(files.includes('many/f0000.ts'), 'the first entry is present')
  assert.equal(new Set(files).size, files.length, 'and no entry is duplicated')

  // 2001 files exist, but the walk may inspect no more than the cap of them: it stopped, rather than
  // reading everything and discarding the tail.
  //
  // The sharp form of the claim, and asserted per entry rather than on a total: the 2001st file was
  // never even looked at. A total would be measuring the shape of the tree instead, because the walk
  // also stats the directories it descends into.
  assert.ok(inspected.length > 0, 'the stat calls went through the wrapped module, so the work was observed')
  assert.ok(!inspected.some((p) => p.endsWith('zzzz-the-2001st.ts')), 'the entry past the cap must never be inspected')
  results.push(`the walk stops at ${MAX_MENTION_ENTRIES} entries, and never inspects the one past it`)
}

async function theOrderIsStableAcrossRuns() {
  const root = makeRoot()
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const name of ['zeta.ts', 'Alpha.ts', 'alpha.ts', 'Beta.ts']) {
    writeFileSync(join(root, 'src', name), `// ${name}`, 'utf8')
  }

  const first = await listWorkspaceFiles(root)
  const second = await listWorkspaceFiles(root)

  assert.deepEqual(first, second, 'the same tree walks to the same order every time')
  assert.ok(
    first.every((f) => !f.startsWith(root)),
    'and the result is relative, not absolute'
  )
  results.push('the walk order is deterministic across runs')
}

async function anEmptyOrMissingRootListsNothing() {
  const root = makeRoot()
  assert.deepEqual(await listWorkspaceFiles(root), [], 'an empty directory lists nothing')
  assert.deepEqual(await listWorkspaceFiles(null), [], 'no workspace lists nothing rather than throwing')
  assert.deepEqual(
    await listWorkspaceFiles(join(root, 'does-not-exist')),
    [],
    'a root that has gone missing lists nothing rather than throwing'
  )
  results.push('an empty, absent, or missing root is an empty list rather than an error')
}

// ---------------------------------------------------------------- one read

async function aMentionedFileIsRead() {
  const root = makeRoot()
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1\n', 'utf8')

  const read = await readMention(root, 'src/app.ts')
  assert.equal(read.status, 'ok', 'a readable file is read')
  assert.equal(read.text, 'export const app = 1\n', 'and its content is the file content')
  assert.equal(read.path, 'src/app.ts', 'and the path is echoed back')
  results.push('a mentioned file is read and its content carried')
}

async function anOversizedMentionIsRefusedWithItsCode() {
  const root = makeRoot()
  const big = 'x'.repeat(MAX_FILE_BYTES + 1)
  writeFileSync(join(root, 'big.ts'), big, 'utf8')
  writeFileSync(join(root, 'ok.ts'), 'const ok = true', 'utf8')

  const read = await readMention(root, 'big.ts')
  assert.equal(read.status, 'too-large', 'a file over the read cap is refused')

  // The boundary, from both sides: at the cap is read, one byte over is not.
  writeFileSync(join(root, 'exact.ts'), 'y'.repeat(MAX_FILE_BYTES), 'utf8')
  assert.equal((await readMention(root, 'exact.ts')).status, 'ok', 'a file exactly at the cap is read')
  results.push('a mention over the per-file read cap is refused rather than loaded')
}

async function aMentionOutsideTheWorkspaceIsRefused() {
  const root = makeRoot()

  // Containment is the workspace's own law, not a check written for mentions: a traversal is refused
  // by the same function the agent's tools obey.
  assert.equal((await readMention(root, '../escape.ts')).status, 'refused', 'a traversal is refused')
  assert.equal((await readMention(root, '/etc/passwd')).status, 'refused', 'an absolute escape is refused')
  assert.equal((await readMention(root, 'a\u0000b')).status, 'refused', 'a NUL byte is refused')
  assert.equal((await readMention(null, 'src/app.ts')).status, 'refused', 'no workspace is refused')
  results.push('a mention outside the workspace is refused by the same containment law as every other read')
}

async function aMissingMentionIsReportedNotThrown() {
  const root = makeRoot()
  mkdirSync(join(root, 'src'), { recursive: true })

  const read = await readMention(root, 'src/not-there.ts')
  assert.equal(read.status, 'missing', 'a file that does not exist is reported, not thrown')

  // A directory is not a file, and reading one must not throw either.
  mkdirSync(join(root, 'src', 'adir'), { recursive: true })
  const dir = await readMention(root, 'src/adir')
  assert.ok(dir.status !== 'ok', 'mentioning a directory does not succeed as a file read')
  results.push('a mention that cannot be read is reported with a status rather than thrown')
}

async function readsKeepTheRequestOrderAndTheCodes() {
  const root = makeRoot()
  writeFileSync(join(root, 'second.ts'), 'const second = 2', 'utf8')
  writeFileSync(join(root, 'first.ts'), 'const first = 1', 'utf8')
  writeFileSync(join(root, 'huge.ts'), 'z'.repeat(MAX_FILE_BYTES + 1), 'utf8')

  const reads = await readMentions(root, ['second.ts', 'nope.ts', 'first.ts', 'huge.ts'])

  assert.deepEqual(
    reads.map((r) => [r.path, r.status]),
    [
      ['second.ts', 'ok'],
      ['nope.ts', 'missing'],
      ['first.ts', 'ok'],
      ['huge.ts', 'too-large'],
    ],
    'every request is answered, in the order asked, with its own status'
  )
  results.push('a batch of mentions is answered in request order, one status each')
}

// ---------------------------------------------------------------- the registered query

async function theRegisteredQueryIsWiredToTheOpenWorkspace() {
  // The walk is tested above; this is the wiring turn C will call. Asserted through the module's own
  // record, as the commands suite does for export, so what is under test is the handler the renderer
  // reaches rather than a helper beside it.
  const member = mentionsModule.record['listFilesFlat'] as unknown as {
    kind?: string
    resolver: (opts: { input: unknown; ctx?: unknown }) => Promise<unknown>
  }
  assert.ok(member?.resolver, 'listFilesFlat must have a resolver')
  assert.equal(member.kind, 'query', 'and must be a query: it reads and takes no input')

  // No input schema is declared, which is the point: the root comes from the open folder in main, so a
  // renderer cannot ask for a walk of a directory it names.
  assert.equal(
    (member as { input?: unknown }).input,
    undefined,
    'the walk takes no input, so it cannot be pointed anywhere the renderer chooses'
  )

  const root = makeRoot()
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'react'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1', 'utf8')
  writeFileSync(join(root, 'node_modules', 'react', 'index.js'), 'module.exports = {}', 'utf8')

  // It resolves against the workspace store file. The module reads `app.getPath('userData')`, which the
  // shared stub points at SAM_TEST_USER_DATA, so seeding the store file is what puts a root behind it.
  const userData = process.env.SAM_TEST_USER_DATA
  assert.ok(userData, 'the suite runs with a private userData directory')
  mkdirSync(join(userData, 'conveyor-stores'), { recursive: true })
  writeFileSync(join(userData, 'conveyor-stores', 'workspace.json'), JSON.stringify({ rootPath: root }), 'utf8')

  const listed = (await member.resolver({ input: undefined })) as string[]
  assert.ok(Array.isArray(listed), 'the query resolves to a list')
  assert.ok(listed.includes('src/app.ts'), 'and lists the open workspace')
  assert.ok(
    !listed.some((p) => p.startsWith('node_modules/')),
    'with the skip law applied, since it goes through the same walk'
  )
  // Paths only. A picker has no use for contents, and shipping them would be a read per file over IPC.
  assert.ok(
    listed.every((p) => typeof p === 'string' && !p.includes('\n')),
    'and every entry is a bare path rather than file content'
  )
  results.push('listFilesFlat is registered as an inputless query over the open workspace, returning paths')
}

// ---------------------------------------------------------------- harness

async function main() {
  try {
    await step('walk: nested', theWalkFindsNestedFilesAsRelativePaths)
    await step('walk: skips', aSkippedSubtreeIsNeverOffered)
    await step('walk: cap', theCapStopsTheWalkAtTwoThousand)
    await step('walk: order', theOrderIsStableAcrossRuns)
    await step('walk: empty', anEmptyOrMissingRootListsNothing)
    await step('read: ok', aMentionedFileIsRead)
    await step('read: cap', anOversizedMentionIsRefusedWithItsCode)
    await step('read: containment', aMentionOutsideTheWorkspaceIsRefused)
    await step('read: missing', aMissingMentionIsReportedNotThrown)
    await step('read: batch', readsKeepTheRequestOrderAndTheCodes)
    await step('query: wired', theRegisteredQueryIsWiredToTheOpenWorkspace)

    console.log(`mentions files: ${results.length} passed`)
    for (const r of results) console.log(`  pass: ${r}`)
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

void main().catch((err) => {
  console.error('MENTIONS FILES TEST FAILED:', err)
  process.exit(1)
})
