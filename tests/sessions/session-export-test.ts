/**
 * Verifies the export renderer: markdown for a reader, and the raw snapshot for a machine.
 *
 * The renderer is pure precisely so this can exist — main reads the file and opens the dialog, and
 * neither of those belongs in a test of what the export says. What is asserted here is the part a
 * person would notice missing: every element present, exactly once, in the order it happened.
 *
 * The centrepiece is the two-turn transcript the phase named: one tool card and one denial. It is
 * rendered once and then counted, rather than checked line by line, because "appears exactly once"
 * is the property that fails when a renderer repeats a heading or echoes a denial's outcome text
 * twice — and both of those read as fine in a diff.
 */
import { strict as assert } from 'node:assert'
import { exportFileName, renderExport, renderMarkdown } from '../../conveyor/protocol/export'
import { TRANSCRIPT_VERSION, type TranscriptSnapshot } from '../../conveyor/protocol/transcript'

const results: string[] = []

function step(label: string, fn: () => void): void {
  process.stdout.write(`... ${label}\n`)
  fn()
}

/** How many times a substring occurs. Used to assert "exactly once". */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * The named case: two turns, one tool card, one denial.
 *
 * Turn one runs a command that worked. Turn two asks for something the user refused — the denial is
 * a settled decision, not an error, and it has to survive as a stated refusal.
 */
function twoTurnsOneToolOneDenial(): TranscriptSnapshot {
  return {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      { id: 'u1', role: 'user', content: 'run the test suite', steps: [] },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Running it now.',
        steps: [
          {
            callId: 'c1',
            tool: 'run_command',
            args: { command: 'npm test' },
            status: 'ok',
            output: 'all 17 node suites passed',
          },
        ],
      },
      { id: 'u2', role: 'user', content: 'now wipe the dist folder', steps: [] },
      {
        id: 'a2',
        role: 'assistant',
        content: 'That needs your approval.',
        steps: [
          {
            callId: 'c2',
            tool: 'run_command',
            args: { command: 'rm -rf dist' },
            status: 'denied',
            output: 'Denied by you.',
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------- the named case

function everyElementAppearsExactlyOnceInOrder() {
  const markdown = renderMarkdown(twoTurnsOneToolOneDenial(), { title: 'test run' })

  // Headings: one title, and one per turn.
  assert.equal(occurrences(markdown, '# test run'), 1, 'the title heading appears once')
  assert.equal(occurrences(markdown, '## You'), 2, 'one user heading per user turn')
  assert.equal(occurrences(markdown, '## Sam AI'), 2, 'one assistant heading per assistant turn')

  // Prose, in order.
  const order = ['run the test suite', 'Running it now.', 'now wipe the dist folder', 'That needs your approval.']
  let cursor = -1
  for (const text of order) {
    const at = markdown.indexOf(text)
    assert.ok(at > cursor, `"${text}" must appear after the text before it`)
    cursor = at
  }

  // Tool cards: one fence each, each naming its tool.
  assert.equal(occurrences(markdown, '```tool run_command'), 2, 'one fence per tool call')
  assert.equal(occurrences(markdown, '```'), 4, 'each fence block is opened and closed exactly once')
  assert.equal(occurrences(markdown, 'args: command="npm test"'), 1, 'the first call keeps its arguments')
  assert.equal(occurrences(markdown, 'args: command="rm -rf dist"'), 1, 'the denial keeps its arguments')

  // Outcomes: the successful one, and the refusal stated in words.
  assert.equal(occurrences(markdown, 'outcome (ok): all 17 node suites passed'), 1, 'the outcome is recorded')
  assert.equal(occurrences(markdown, 'denied by the user'), 1, 'the denial is stated exactly once')
  // The stored output for a denial is the UI's own wording; echoing it would say the same thing
  // twice in a different voice.
  assert.equal(occurrences(markdown, 'Denied by you.'), 0, 'a denial does not also print its stored output')

  results.push('two turns, one tool card, one denial: every element once, in order')
}

// ---------------------------------------------------------------- ordering and content

function theCardsSitInsideTheirTurn() {
  const markdown = renderMarkdown(twoTurnsOneToolOneDenial(), { title: 'test run' })

  // The four headings in document order: user, assistant, user, assistant. Walking them in order is
  // what makes "inside its own turn" checkable — a bare `indexOf('## You')` finds the first one, which
  // is how this assertion first came out comparing the wrong pair.
  const headings: Array<{ at: number; text: string }> = []
  for (const text of ['## You', '## Sam AI', '## You', '## Sam AI']) {
    const from = headings.length > 0 ? headings[headings.length - 1].at + 1 : 0
    headings.push({ at: markdown.indexOf(text, from), text })
  }
  assert.ok(
    headings.every((h) => h.at !== -1),
    `all four turn headings must be present: ${JSON.stringify(headings)}`
  )
  assert.deepEqual(
    headings.map((h) => h.at),
    [...headings.map((h) => h.at)].sort((a, b) => a - b),
    'the headings appear in turn order'
  )

  const firstCard = markdown.indexOf('```tool run_command')
  const secondCard = markdown.indexOf('```tool run_command', firstCard + 1)

  // The command card belongs to the first assistant turn: after its heading, before the next turn.
  assert.ok(headings[1].at < firstCard, 'the first card comes after its own heading')
  assert.ok(firstCard < headings[2].at, 'the first card comes before the next turn begins')
  // The denial belongs to the last one, which is the point of the pair: a card must not be hoisted
  // to the end of the file where it would read as an afterthought rather than as that turn's work.
  assert.ok(headings[3].at < secondCard, 'the denial comes after its own heading')
  results.push('a tool card is rendered inside the turn that made the call, not at the end')
}

function anEmptyTurnStillGetsAHeading() {
  // A turn the model left blank is still a thing that happened — the heading is what keeps the
  // export's structure readable when the prose is missing.
  const snapshot: TranscriptSnapshot = {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [{ id: 'u1', role: 'user', content: '   ', steps: [] }],
  }
  const markdown = renderMarkdown(snapshot, { title: 'blank' })
  assert.equal(occurrences(markdown, '## You'), 1, 'the heading is there')
  assert.ok(!markdown.includes('\n\n\n'), 'and no stray blank section is left behind')
  results.push('a turn whose prose is blank still gets its heading, without a blank section')
}

function aFailedCallKeepsItsCode() {
  const snapshot: TranscriptSnapshot = {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      {
        id: 'a1',
        role: 'assistant',
        content: 'Trying.',
        steps: [
          {
            callId: 'c1',
            tool: 'run_command',
            args: { command: 'python fib.py' },
            status: 'failed',
            output: 'Traceback (most recent call last):\n  File "fib.py", line 1\nSyntaxError',
            code: 'COMMAND_FAILED',
          },
        ],
      },
    ],
  }
  const markdown = renderMarkdown(snapshot, { title: 'failure' })

  assert.equal(occurrences(markdown, 'code: COMMAND_FAILED'), 1, 'the code is recorded once')
  assert.ok(markdown.includes('outcome (failed): Traceback'), 'the outcome keeps the first line')
  // A stack trace would otherwise turn one export entry into a page.
  assert.ok(!markdown.includes('SyntaxError'), 'only the first line of a long output is quoted')
  results.push('a failed call is recorded with its first output line and its error code')
}

function anUnfinishedTurnIsDeclared() {
  const snapshot: TranscriptSnapshot = {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      {
        id: 'a1',
        role: 'assistant',
        content: 'Writing the file…',
        steps: [{ callId: 'c1', tool: 'write_file', args: { path: 'a.ts' }, status: 'running' }],
      },
    ],
  }
  const markdown = renderMarkdown(snapshot, { title: 'interrupted' })

  assert.equal(occurrences(markdown, 'left unfinished'), 1, 'an unfinished turn says so once')
  assert.ok(markdown.includes('outcome (running): no outcome recorded.'), 'and its call has no outcome')
  results.push('a turn cut off mid-run is declared rather than reading as finished')
}

function aConversationFlagIsStatedOnceAndNotTwice() {
  const withUnsettled: TranscriptSnapshot = {
    version: TRANSCRIPT_VERSION,
    interrupted: true,
    turns: [
      {
        id: 'a1',
        role: 'assistant',
        content: 'Working.',
        steps: [{ callId: 'c1', tool: 'read_file', args: {}, status: 'awaiting' }],
      },
    ],
  }
  // The turn already says it; a second note at the end would announce the same thing twice.
  const once = renderMarkdown(withUnsettled, { title: 'x' })
  assert.equal(occurrences(once, 'left unfinished'), 1, 'the interruption is stated once, not twice')

  // With no unsettled step, the flag is the only trace and must be stated.
  const flaggedOnly = renderMarkdown(
    { version: TRANSCRIPT_VERSION, interrupted: true, turns: [{ id: 'u1', role: 'user', content: 'hi', steps: [] }] },
    { title: 'x' }
  )
  assert.equal(occurrences(flaggedOnly, 'left mid-turn'), 1, 'a flagged conversation says so')
  results.push('the interrupted flag is stated once, and never twice for the same interruption')
}

function argumentSummariesAreBounded() {
  const snapshot: TranscriptSnapshot = {
    version: TRANSCRIPT_VERSION,
    interrupted: false,
    turns: [
      {
        id: 'a1',
        role: 'assistant',
        content: 'Writing it.',
        steps: [
          {
            callId: 'c1',
            tool: 'write_file',
            // A whole file, which would bury the prose it sits between.
            args: { path: 'big.ts', content: 'x'.repeat(5000) },
            status: 'ok',
            output: 'Wrote 5000 bytes.',
          },
        ],
      },
    ],
  }
  const markdown = renderMarkdown(snapshot, { title: 'big' })
  const argsLine = markdown.split('\n').find((line) => line.startsWith('args: ')) ?? ''

  assert.ok(argsLine.length < 300, `an argument summary is clipped, got ${argsLine.length} characters`)
  assert.ok(argsLine.includes('path="big.ts"'), 'the small arguments are still readable')
  assert.ok(!markdown.includes('x'.repeat(200)), 'a large argument does not flood the export')
  results.push('a large tool argument is summarized rather than pasted whole')
}

// ---------------------------------------------------------------- json and the filename

function jsonIsTheRawSnapshot() {
  const snapshot = twoTurnsOneToolOneDenial()
  const json = renderExport(snapshot, { title: 'test run', format: 'json' })

  // An export is a way out of this app, so the JSON is what the app holds — parsed back, it is the
  // snapshot itself, not a shape invented for export.
  assert.deepEqual(JSON.parse(json), snapshot, 'the json export round-trips to the same snapshot')
  assert.ok(json.endsWith('\n'), 'the file ends with a newline')

  const markdown = renderExport(snapshot, { title: 'test run', format: 'markdown' })
  assert.ok(markdown.startsWith('# test run'), 'the markdown export goes through the renderer')
  assert.notEqual(markdown, json, 'the two formats are actually different')
  results.push('the json export is the raw snapshot; the markdown export is the rendered one')
}

function theDefaultFileNameIsDerivedFromTheTitle() {
  assert.equal(exportFileName('test run', 'markdown'), 'test run.md', 'a plain title passes through')
  assert.equal(exportFileName('test run', 'json'), 'test run.json', 'the extension follows the format')

  // A separator in a filename would put the export somewhere other than where the dialog said.
  assert.equal(exportFileName('a/b\\c:d', 'markdown'), 'a-b-c-d.md', 'separators are replaced, not dropped')
  assert.equal(exportFileName('  spaced   out  ', 'markdown'), 'spaced out.md', 'whitespace collapses')
  assert.equal(exportFileName('', 'markdown'), 'conversation.md', 'an empty title still names a file')
  assert.equal(exportFileName('   ', 'json'), 'conversation.json', 'so does a whitespace-only one')
  assert.equal(exportFileName('...hidden', 'markdown'), 'hidden.md', 'a leading dot cannot hide the file')
  assert.ok(exportFileName('x'.repeat(200), 'markdown').length < 80, 'a long title does not make a long name')
  results.push('the default filename is derived from the title and is safe to write anywhere')
}

// ---------------------------------------------------------------- harness

function main(): void {
  step('named case', everyElementAppearsExactlyOnceInOrder)
  step('card placement', theCardsSitInsideTheirTurn)
  step('blank turn', anEmptyTurnStillGetsAHeading)
  step('failed call', aFailedCallKeepsItsCode)
  step('unfinished turn', anUnfinishedTurnIsDeclared)
  step('interrupted flag', aConversationFlagIsStatedOnceAndNotTwice)
  step('argument bounds', argumentSummariesAreBounded)
  step('formats', jsonIsTheRawSnapshot)
  step('filename', theDefaultFileNameIsDerivedFromTheTitle)

  console.log(`session export renderer: ${results.length} passed`)
  for (const r of results) console.log(`  pass: ${r}`)
}

try {
  main()
} catch (err) {
  console.error('SESSION EXPORT TEST FAILED:', err)
  process.exit(1)
}
